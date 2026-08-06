'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const { round2 } = require('./util');
const { typesForClient } = require('./documentTypes');

// Modelul implicit al Anthropic, intr-un SINGUR loc: constanta exportata si resolveProvider() il
// scriau fiecare de mana si driftasera deja fata de .env.example (trei fisiere, trei modele).
const MODEL_ANTHROPIC = 'claude-opus-5';
const MODEL = process.env.CONTAB_AI_MODEL || MODEL_ANTHROPIC;

let client = null;
let openaiClient = null;

/** Alegerea furnizorului AI. Reguli, in ordine:
 *  1. CONTAB_AI_PROVIDER explicit BATE prezenta cheilor (dar fara cheia lui => 'none',
 *     nu cadere tacuta pe celalalt furnizor — o configurare gresita trebuie sa se vada);
 *  2. fara setare explicita, Anthropic are prioritate (comportamentul istoric al aplicatiei;
 *     OpenAI e opt-in) — simpla aparitie a unei chei OpenAI in mediu nu deturneaza extragerea.
 *  Modelele sunt per furnizor: CONTAB_AI_MODEL ramane al Anthropic (semantica existenta,
 *  productia il are deja setat pe un model Claude), CONTAB_AI_MODEL_OPENAI e al OpenAI —
 *  un singur camp partajat ar trimite id de model Claude catre OpenAI la comutare. */
function resolveProvider() {
  const forced = (process.env.CONTAB_AI_PROVIDER || '').toLowerCase();
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenai = !!process.env.OPENAI_API_KEY;
  let provider = (forced === 'anthropic' || forced === 'openai')
    ? forced
    : (hasAnthropic ? 'anthropic' : hasOpenai ? 'openai' : 'none');
  if (provider === 'anthropic' && !hasAnthropic) provider = 'none';
  if (provider === 'openai' && !hasOpenai) provider = 'none';
  const model = provider === 'openai'
    ? (process.env.CONTAB_AI_MODEL_OPENAI || 'gpt-4.1-mini')
    : (process.env.CONTAB_AI_MODEL || MODEL_ANTHROPIC);
  return { provider, model };
}

function getClient() {
  const { provider } = resolveProvider();
  if (provider === 'openai') {
    if (!openaiClient) openaiClient = new OpenAI(); // citeste OPENAI_API_KEY din mediu
    return openaiClient;
  }
  if (provider === 'anthropic') {
    if (!client) client = new Anthropic(); // citeste ANTHROPIC_API_KEY din mediu
    return client;
  }
  return null;
}

/** Disponibil = furnizorul ALES are cheia lui — aliniat cu resolveProvider, altfel un
 *  provider fortat fara cheie ar consuma cota zilnica pe apeluri care esueaza garantat. */
function aiAvailable() {
  return resolveProvider().provider !== 'none';
}

/** Construieste schema JSON pentru output-ul structurat. */
function buildSchema() {
  const typeIds = typesForClient().map((t) => t.id);
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      suggestedType: { type: 'string', enum: typeIds, description: 'Cel mai potrivit tip de document din lista.' },
      partener: { type: 'string', description: 'Numele partenerului (client sau furnizor). Gol daca nu se stie.' },
      document: { type: 'string', description: 'Seria si numarul documentului. Gol daca nu se stie.' },
      data: { type: 'string', description: 'Data documentului in format YYYY-MM-DD. Gol daca nu se stie.' },
      baza: { type: 'number', description: 'Baza impozabila (valoarea fara TVA) in lei. 0 daca nu se aplica.' },
      tva: { type: 'number', description: 'Valoarea TVA in lei. 0 daca nu se aplica.' },
      cota: { type: 'integer', description: 'Cota TVA in procente (ex: 21, 19, 11, 9, 5). 0 daca nu se aplica.' },
      suma: { type: 'number', description: 'Totalul de plata (baza + TVA) sau suma operatiunii in lei.' },
      brut: { type: 'number', description: 'Doar pentru state de plata: total salarii brute. 0 in rest.' },
      cuis: { type: 'array', items: { type: 'string' }, description: 'CUI-urile gasite in document.' },
      incredere: { type: 'integer', description: 'Increderea in extragere, 0-100.' },
      motiv: { type: 'string', description: 'O propozitie scurta despre cum a fost ales tipul.' },
    },
    required: ['suggestedType', 'partener', 'document', 'data', 'baza', 'tva', 'cota', 'suma', 'brut', 'cuis', 'incredere', 'motiv'],
  };
}

function systemPrompt(ownCui) {
  const types = typesForClient()
    .map((t) => `- ${t.id}: ${t.nume} (${t.grup})`)
    .join('\n');
  return `Esti contabil si extragi date din documente primare romanesti (facturi, chitante, bonuri, NIR, state de plata) pentru a genera articole contabile dupa planul de conturi romanesc.

Firma utilizatorului are CUI ${ownCui || '(necunoscut)'}. Foloseste asta pentru a stabili sensul:
- Daca emitentul/furnizorul documentului este firma utilizatorului (acelasi CUI), documentul este o VANZARE (factura emisa).
- Daca firma utilizatorului este cumparatorul, documentul este o CUMPARARE (factura primita).

Alege exact unul dintre aceste tipuri (campul suggestedType):
${types}

Reguli:
- Sumele sunt in lei (RON), cu punct ca separator zecimal in raspuns (ex: 1050.00).
- baza = valoarea fara TVA, tva = valoarea TVA, suma = totalul de plata. Verifica: suma ≈ baza + tva.
- Daca documentul este o factura de marfuri/produse fara alt indiciu, foloseste tipul de marfuri.
- Daca nu poti citi o valoare, pune 0 (numeric) sau sir gol (text). Nu inventa.
- Raspunde DOAR cu obiectul JSON cerut de schema.`;
}

/**
 * Extrage datele dintr-un PDF folosind Claude API (document input + output structurat).
 * @param {Buffer} buffer
 * @param {string} ownCui
 * @returns {Promise<{suggestedType, fields, cuis, source, incredere, motiv}>}
 */
/** Detecteaza tipul fisierului din primii octeti (PDF sau imagine). */
function detectMediaType(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf'; // %PDF
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

async function extractWithAI(buffer, ownCui) {
  const c = getClient();
  const providerInfo = resolveProvider();
  if (!c) throw new Error('Niciun furnizor AI configurat (ANTHROPIC_API_KEY sau OPENAI_API_KEY).');

  const b64 = buffer.toString('base64'); // fara newline-uri
  const mediaType = detectMediaType(buffer) || 'application/pdf';
  const docBlock = mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } };

  let response;
  let data;
  if (providerInfo.provider === 'openai') {
    // Responses API: PDF-urile merg ca input_file (cu filename obligatoriu la file_data),
    // imaginile ca input_image — un singur tip pentru ambele ar respinge pozele de bonuri.
    const docBlockOpenai = mediaType === 'application/pdf'
      ? { type: 'input_file', filename: 'document.pdf', file_data: `data:application/pdf;base64,${b64}` }
      : { type: 'input_image', image_url: `data:${mediaType};base64,${b64}` };
    const responseObj = await c.responses.create({
      model: providerInfo.model,
      input: [
        { role: 'system', content: systemPrompt(ownCui) },
        { role: 'user', content: [
          { type: 'input_text', text: 'Extrage datele din acest document (PDF sau imagine scanata/fotografiata) conform schemei.' },
          docBlockOpenai,
        ] },
      ],
      text: { format: { type: 'json_schema', name: 'extragere_document', schema: buildSchema() } },
    });
    response = responseObj;
    // echivalentul lui stop_reason==='refusal' de pe Anthropic: fara astea, un refuz ar iesi
    // ca o eroare criptica de JSON.parse
    if (response.status === 'incomplete') throw new Error('Raspuns incomplet de la model (' + ((response.incomplete_details || {}).reason || 'motiv necunoscut') + ').');
    const refusal = (response.output || []).flatMap((o) => o.content || []).find((x) => x.type === 'refusal');
    if (refusal) throw new Error('Cererea a fost refuzata de model.');
    const outputText = response.output_text || '';
    if (!outputText) throw new Error('Raspuns gol de la model.');
    data = JSON.parse(outputText);
  } else {
    // `effort` e suportat doar de modelele Opus/Sonnet; Haiku il respinge
    const outputConfig = { format: { type: 'json_schema', schema: buildSchema() } };
    if (/opus|sonnet/i.test(providerInfo.model)) outputConfig.effort = 'low';
    response = await c.messages.create({
      model: providerInfo.model,
      // Plafonul acopera GANDIREA + raspunsul la un loc, iar pe generatia 5 gandirea adaptiva e
      // PORNITA implicit cand `thinking` lipseste (pe Sonnet 4.6 / Opus 4.8 era oprita). Deci
      // premisa care facea 2048 sigur s-a schimbat — dar MASURAT pe claude-sonnet-5 cu
      // `effort: 'low'`, iesirea totala ramane mica: 167 tokeni pe o factura curata, 257 pe una
      // cu 45 de pozitii si doua cote, 183 pe un scan JPEG degradat (62 dpi, calitate 28).
      // Sub 13% din plafon in cazul cel mai rau, deci 2048 ramane — o marire ar fi fost o cifra
      // aleasa dintr-o poveste, nu dintr-o masuratoare. Gandirea NU se opreste: acuratetea pe
      // documente fotografiate e insusi motivul pentru care exista extragerea AI.
      max_tokens: 2048,
      system: systemPrompt(ownCui),
      output_config: outputConfig,
      messages: [
        {
          role: 'user',
          content: [
            docBlock,
            { type: 'text', text: 'Extrage datele din acest document (PDF sau imagine scanata/fotografiata) conform schemei.' },
          ],
        },
      ],
    });

    if (response.stop_reason === 'refusal') {
      throw new Error('Cererea a fost refuzata de model.');
    }
    // Raspuns taiat de plafon. Fara garda, singurul simptom ar fi o eroare de JSON despre un
    // caracter lipsa — care arata a defect de parsare, nu a raspuns incomplet. Perechea ei pe
    // ramura OpenAI exista deja (`status === 'incomplete'`); aici lipsea.
    // Nu apara de configurarea masurata mai sus, ci de una nemasurata: `effort: 'low'` se pune
    // doar pe modelele care se potrivesc cu /opus|sonnet/, deci un CONTAB_AI_MODEL din alta
    // familie ruleaza pe efortul implicit (mai mare) si poate gandi mult peste 2048. Atunci
    // trebuie sa scrie ce s-a intamplat, nu sa cada pe JSON.parse.
    if (response.stop_reason === 'max_tokens') {
      throw new Error('Raspunsul modelului a fost taiat de plafonul de tokeni (max_tokens); documentul nu a putut fi extras complet.');
    }
    const textBlock = (response.content || []).find((b) => b.type === 'text');
    if (!textBlock) throw new Error('Raspuns gol de la model.');
    data = JSON.parse(textBlock.text);
  }

  // Cota se pastreaza asa cum a fost citita (inclusiv 0 = document fara TVA). NU se forteaza o
  // valoare implicita aici — reconcilierea post-extragere (src/extractCheck.js) o infereaza din
  // raportul TVA/baza cand lipseste, altfel cade pe cota standard datata; un „|| 19" ar fi pus o
  // cota veche si ar fi ascuns documentele fara TVA.
  const cota = Math.round(Number(data.cota) || 0);
  const fields = {
    data: data.data || '',
    document: data.document || '',
    partener: data.partener || '',
    baza: data.baza != null ? round2(data.baza) : null,
    tva: data.tva != null ? round2(data.tva) : null,
    cota,
    suma: data.suma != null ? round2(data.suma) : null,
    brut: data.brut ? round2(data.brut) : null,
  };
  // valideaza tipul sugerat
  let suggestedType = data.suggestedType;
  if (!typesForClient().some((t) => t.id === suggestedType)) suggestedType = 'nota_contabila';

  return {
    suggestedType,
    fields,
    cuis: Array.isArray(data.cuis) ? data.cuis : [],
    source: 'ai',
    incredere: Number(data.incredere) || null,
    motiv: data.motiv || '',
  };
}

module.exports = { extractWithAI, aiAvailable, detectMediaType, MODEL, resolveProvider };
