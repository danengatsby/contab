'use strict';

// Traduce sursele cartii RO -> EN, fara sa schimbe schema JSON. Rezultatele sunt pastrate
// separat in scripts/carte/en/, iar manifestul le leaga de hash-ul sursei si de modelul care
// le-a produs. Astfel, o corectura in romana invalideaza numai fisierul afectat.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const ROOT = path.join(__dirname, '..');
require('../src/bootstrap').loadDotEnv(ROOT);

const MODEL = process.env.CONTAB_BOOK_TRANSLATION_MODEL
  || process.env.CONTAB_AI_MODEL
  || 'claude-sonnet-5';
const OUT = path.join(__dirname, 'carte', 'en');
const MANIFEST = path.join(OUT, 'translation-manifest.json');
const TIPURI = new Set(['p', 'h', 'cheie', 'contabil', 'recap', 'tabel', 'exercitiu']);
const LIMITA_CARACTERE = 12000;

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error('ANTHROPIC_API_KEY lipseste: traducerea cartii nu poate fi generata.');
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
fs.mkdirSync(OUT, { recursive: true });

function surse() {
  return fs.readdirSync(__dirname)
    .filter((f) => /^cuprins-carte(?:-cap(?:\d+|[A-F]))?\.json$/.test(f))
    .sort((a, b) => {
      if (a === 'cuprins-carte.json') return -1;
      if (b === 'cuprins-carte.json') return 1;
      return a.localeCompare(b, 'en', { numeric: true });
    });
}

function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function citesteManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); }
  catch (_) { return { version: 1, model: MODEL, files: {} }; }
}

function frunzeTraductibile(root) {
  const out = [];
  function walk(value, cale, parentKey) {
    if (typeof value === 'string') {
      // Valorile tehnice si sirurile formate numai din cifre/semne raman identice. Toate
      // celelalte siruri se traduc, inclusiv antete scurte precum "Lei" sau "Total".
      if (parentKey !== 'nr' && parentKey !== 'tip' && !TIPURI.has(value)
          && /[A-Za-zĂÂÎȘȚăâîșț]/.test(value)) {
        out.push({ cale: cale.slice(), text: value });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, cale.concat(i), parentKey));
      return;
    }
    if (value && typeof value === 'object') {
      Object.keys(value).forEach((key) => walk(value[key], cale.concat(key), key));
    }
  }
  walk(root, [], '');
  return out;
}

function pune(root, cale, text) {
  let cur = root;
  for (let i = 0; i < cale.length - 1; i += 1) cur = cur[cale[i]];
  cur[cale[cale.length - 1]] = text;
}

function bucati(frunze) {
  const out = [];
  let cur = [];
  let chars = 0;
  for (const frunza of frunze) {
    const n = frunza.text.length;
    if (cur.length && chars + n > LIMITA_CARACTERE) {
      out.push(cur); cur = []; chars = 0;
    }
    cur.push(frunza); chars += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

const SYSTEM = `You are the senior English-language editor of a practical book about Romanian accounting.
Translate Romanian into precise, natural professional English for business owners and accountants.

Rules:
- Translate every supplied text completely. Do not summarize, omit, add, update, or fact-check it.
- Preserve all amounts, percentages, dates, account numbers, declaration codes, formulas, quotation marks,
  cross-references, and Romanian legal citations. Romanian accounting and tax rules must remain Romanian;
  never adapt them to UK or US law.
- Use consistent terms: patron = business owner; contabil = accountant; balanță = trial balance;
  bilanț = balance sheet; cont de profit și pierdere = income statement; notă contabilă = journal entry;
  partidă dublă = double-entry bookkeeping; creanță = receivable; datorie = liability/payable according
  to context; imobilizare = fixed asset; stoc = inventory; cheltuială = expense; venit = revenue.
- Keep "leu"/"lei" as "leu"/"lei" or use RON where the source is a currency header. Never call it a pound.
- Keep official Romanian names or acronyms where accuracy requires it; translate the surrounding explanation.
- Return the translations in exactly the same id order. The JSON schema is mandatory.`;

function schema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      translations: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          properties: { id: { type: 'integer' }, text: { type: 'string' } },
          required: ['id', 'text'],
        },
      },
    },
    required: ['translations'],
  };
}

function asteapta(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function canonizeazaPartile(files) {
  const sumar = JSON.parse(fs.readFileSync(path.join(OUT, 'cuprins-carte.json'), 'utf8'));
  const dupaNumar = new Map();
  for (const parte of sumar.parti) {
    const nume = parte.nr === '—'
      ? `${parte.titlu} · ${parte.faza}`
      : `Part ${parte.nr} · ${parte.titlu}${parte.nr === 'I' ? '' : ` · ${parte.faza}`}`;
    parte.capitole.forEach((c) => dupaNumar.set(String(c.nr), nume));
  }
  for (const fisier of files.filter((f) => /-cap(?:\d+|[A-F])\.json$/.test(f))) {
    const target = path.join(OUT, fisier);
    const capitol = JSON.parse(fs.readFileSync(target, 'utf8'));
    const parte = dupaNumar.get(String(capitol.nr));
    if (parte && capitol.parte !== parte) {
      capitol.parte = parte;
      fs.writeFileSync(target, JSON.stringify(capitol, null, 1) + '\n', { mode: 0o644 });
    }
  }
}

async function traduce(chunk, fisier, index, total) {
  const payload = chunk.map((x, id) => ({ id, text: x.text }));
  let ultima;
  for (let incercare = 1; incercare <= 3; incercare += 1) {
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM,
        output_config: {
          effort: 'low',
          format: { type: 'json_schema', schema: schema() },
        },
        messages: [{
          role: 'user',
          content: `File ${fisier}, chunk ${index}/${total}. Translate this JSON array:\n${JSON.stringify(payload)}`,
        }],
      });
      if (response.stop_reason === 'max_tokens') throw new Error('raspuns taiat la max_tokens');
      if (response.stop_reason === 'refusal') throw new Error('cerere refuzata');
      const bloc = (response.content || []).find((x) => x.type === 'text');
      if (!bloc) throw new Error('raspuns fara bloc text');
      const parsed = JSON.parse(bloc.text);
      const lista = parsed.translations || [];
      if (lista.length !== payload.length) throw new Error(`numar traduceri ${lista.length}/${payload.length}`);
      lista.forEach((x, i) => {
        if (x.id !== i || typeof x.text !== 'string' || !x.text.trim()) {
          throw new Error(`traducere invalida la id ${i}`);
        }
      });
      return lista.map((x) => x.text);
    } catch (err) {
      ultima = err;
      if (incercare < 3) {
        console.warn(`   reincercare ${incercare}/3: ${String(err.message || err)}`);
        await asteapta(1500 * incercare);
      }
    }
  }
  throw ultima;
}

async function main() {
  const files = surse();
  const manifest = citesteManifest();
  manifest.version = 1;
  manifest.model = MODEL;
  manifest.files = manifest.files || {};
  console.log(`── Traducere carte RO -> EN: ${files.length} fisiere, model ${MODEL}`);

  let urmatorul = 0;
  async function worker() {
    while (urmatorul < files.length) {
      const fi = urmatorul;
      urmatorul += 1;
    const fisier = files[fi];
    const sourceText = fs.readFileSync(path.join(__dirname, fisier), 'utf8');
    const sourceHash = hash(sourceText);
    const target = path.join(OUT, fisier);
    const cached = manifest.files[fisier];
    if (cached && cached.sha256 === sourceHash && cached.model === MODEL && fs.existsSync(target)) {
      console.log(`[${fi + 1}/${files.length}] ${fisier}: neschimbat`);
      continue;
    }

    const obiect = JSON.parse(sourceText);
    const frunze = frunzeTraductibile(obiect);
    const chunks = bucati(frunze);
    console.log(`[${fi + 1}/${files.length}] ${fisier}: ${frunze.length} texte, ${chunks.length} bucati`);
    let cursor = 0;
    for (let ci = 0; ci < chunks.length; ci += 1) {
      const traduse = await traduce(chunks[ci], fisier, ci + 1, chunks.length);
      traduse.forEach((text, i) => pune(obiect, chunks[ci][i].cale, text));
      cursor += traduse.length;
      console.log(`   ${ci + 1}/${chunks.length}: ${cursor}/${frunze.length} texte`);
    }

    fs.writeFileSync(target, JSON.stringify(obiect, null, 1) + '\n', { mode: 0o644 });
    manifest.files[fisier] = {
      sha256: sourceHash,
      model: MODEL,
      strings: frunze.length,
      translatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644 });
    }
  }
  // Trei cereri simultane scurteaza publicarea fara sa impinga inutil furnizorul spre
  // limitele de trafic; reincercarile din `traduce` absorb raspunsurile 429 tranzitorii.
  await Promise.all([worker(), worker(), worker()]);
  // Campul `parte` se repeta in fiecare capitol. Traducerea lui separata poate produce sinonime
  // sau capitalizari diferite ("phase"/"stage"), care ar sparge gruparea cuprinsului. Sumarul
  // tradus este sursa canonica pentru toate cele 56 de fisiere.
  canonizeazaPartile(files);
  console.log('── Traducerea EN este completa.');
}

main().catch((err) => {
  console.error('EROARE traducere:', err && (err.stack || err.message) || err);
  process.exitCode = 1;
});
