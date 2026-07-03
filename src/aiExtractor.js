'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { round2 } = require('./util');
const { typesForClient } = require('./documentTypes');
const coa = require('./chartOfAccounts');

const MODEL = process.env.CONTAB_AI_MODEL || 'claude-opus-4-8';

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic(); // citeste ANTHROPIC_API_KEY din mediu
  return client;
}

function aiAvailable() {
  return !!process.env.ANTHROPIC_API_KEY;
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
  if (!c) throw new Error('ANTHROPIC_API_KEY nu este setat.');

  const b64 = buffer.toString('base64'); // fara newline-uri
  const mediaType = detectMediaType(buffer) || 'application/pdf';
  const docBlock = mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } };
  // `effort` e suportat doar de modelele Opus/Sonnet; Haiku il respinge
  const outputConfig = { format: { type: 'json_schema', schema: buildSchema() } };
  if (/opus|sonnet/i.test(MODEL)) outputConfig.effort = 'low';
  const response = await c.messages.create({
    model: MODEL,
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
  const textBlock = (response.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Raspuns gol de la model.');
  const data = JSON.parse(textBlock.text);

  const cota = Number(data.cota) || 0;
  const fields = {
    data: data.data || '',
    document: data.document || '',
    partener: data.partener || '',
    baza: data.baza != null ? round2(data.baza) : null,
    tva: data.tva != null ? round2(data.tva) : null,
    cota: cota || 19,
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

module.exports = { extractWithAI, aiAvailable, detectMediaType, MODEL };
