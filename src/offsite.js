'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  COPIA OFFSITE PE STOCARE OBIECT (S3-compatibil), SEMNATA NATIV
//
//  De ce nu rclone: era singura cale de urcare din script, dar binarul NU e instalat pe server,
//  deci `RCLONE_REMOTE` ar fi esuat tacit la prima folosire. O dependenta externa nedeclarata,
//  intr-un drum care se executa doar noaptea, e o cale moarta care pare vie.
//
//  Semnarea AWS Signature V4 e implementata aici, cu `node:crypto` — fara dependente noi, in
//  spiritul restului proiectului. Merge pe orice S3-compatibil (Backblaze B2, Hetzner, MinIO,
//  Cloudflare R2), fiindca toate vorbesc acelasi protocol de semnare.
//
//  Ce NU face acest modul: nu cripteaza. Criptarea ramane in scripts/backup.js, pe formatul
//  openssl, deliberat — o restaurare de dezastru trebuie sa fie posibila cu `openssl` de pe orice
//  masina, fara aplicatia asta si fara Node. Un format propriu ar lega recuperarea de codul care
//  tocmai a fost pierdut.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();

/** Cheia de semnare derivata (AWS SigV4): HMAC in lant peste data/regiune/serviciu. */
function signingKey(secret, date, region, service) {
  const kDate = hmac('AWS4' + secret, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/** Codificare de cale conform S3: fiecare segment codificat, dar `/` pastrat. */
function uriEncodePath(p) {
  return String(p).split('/').map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');
}

/**
 * Construieste antetele semnate pentru o cerere S3.
 * Pur si determinist (data se da explicit) — de aceea se poate verifica fata de vectorii oficiali.
 * @returns {{ headers: object, url: string }}
 */
function signRequest(opts) {
  const {
    method = 'PUT', endpoint, region, service = 's3', bucket, key,
    accessKey, secretKey, payload = Buffer.alloc(0), contentType = 'application/octet-stream',
    amzDate, // YYYYMMDDTHHMMSSZ
    // Sirul de interogare CANONIC (deja codificat si sortat de apelant, ex. 'lifecycle=').
    // Operatiunile pe BUCKET (retentie, listare) traiesc in query, nu in cale — fara el
    // semnatura s-ar calcula peste o alta cerere decat cea trimisa, iar serverul ar raspunde
    // `SignatureDoesNotMatch`, care arata a credentiala gresita desi credentiala e buna.
    query = '',
    // Antete suplimentare care intra SI in semnatura (ex. content-md5, cerut de PutLifecycle).
    extraHeaders = null,
  } = opts;

  const host = new URL(endpoint).host;
  const dateStamp = amzDate.slice(0, 8);
  // Cheia goala inseamna operatiune pe BUCKET: calea e `/bucket`, fara „/" final (unul in plus
  // ar desemna un obiect cu nume gol, iar semnatura n-ar mai corespunde caii cerute).
  const canonicalUri = '/' + uriEncodePath(key ? bucket + '/' + key : bucket);
  const payloadHash = sha256hex(payload);

  const headers = Object.assign({
    host,
    'content-type': contentType,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }, extraHeaders || {});
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map((h) => h + ':' + headers[h] + '\n').join('');
  const canonicalRequest = [method, canonicalUri, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = [dateStamp, region, service, 'aws4_request'].join('/');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(secretKey, dateStamp, region, service))
    .update(stringToSign, 'utf8').digest('hex');

  return {
    // URL-ul poarta EXACT sirul canonic de interogare, nu o forma echivalenta (`?lifecycle` vs.
    // `?lifecycle=`): serverul recanonicalizeaza ce primeste, iar orice diferenta rupe semnatura.
    url: endpoint.replace(/\/$/, '') + canonicalUri + (query ? '?' + query : ''),
    headers: Object.assign({}, headers, {
      Authorization: 'AWS4-HMAC-SHA256 Credential=' + accessKey + '/' + scope
        + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
    }),
    canonicalRequest, stringToSign, signature,
  };
}

/** Configurarea e completa? (toate cele patru bucati, altfel urcarea nici nu se incearca) */
function configured(cfg) {
  return !!(cfg && cfg.endpoint && cfg.bucket && cfg.accessKey && cfg.secretKey);
}

/** Citeste configurarea din mediu. Prefixul `CONTAB_OFFSITE_` — documentat in docs/rulare.md. */
function fromEnv(env) {
  const e = env || process.env;
  return {
    endpoint: e.CONTAB_OFFSITE_ENDPOINT || '',
    region: e.CONTAB_OFFSITE_REGION || 'us-east-1',
    bucket: e.CONTAB_OFFSITE_BUCKET || '',
    prefix: e.CONTAB_OFFSITE_PREFIX || 'contab',
    accessKey: e.CONTAB_OFFSITE_KEY || '',
    secretKey: e.CONTAB_OFFSITE_SECRET || '',
  };
}

/** Urca un obiect. Intoarce { ok, status } sau arunca la eroare de retea. */
async function putObject(cfg, key, buf, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const s = signRequest({
    method: 'PUT', endpoint: cfg.endpoint, region: cfg.region, bucket: cfg.bucket,
    key, accessKey: cfg.accessKey, secretKey: cfg.secretKey, payload: buf, amzDate,
  });
  const r = await doFetch(s.url, { method: 'PUT', headers: s.headers, body: buf });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error('S3 PUT ' + r.status + ': ' + String(txt).slice(0, 300));
  }
  return { ok: true, status: r.status, url: s.url };
}

/** Descarca un obiect (pentru drill-ul care verifica exact ce s-a urcat). */
async function getObject(cfg, key, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const s = signRequest({
    method: 'GET', endpoint: cfg.endpoint, region: cfg.region, bucket: cfg.bucket,
    key, accessKey: cfg.accessKey, secretKey: cfg.secretKey, payload: Buffer.alloc(0), amzDate,
  });
  const r = await doFetch(s.url, { method: 'GET', headers: s.headers });
  if (!r.ok) throw new Error('S3 GET ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

// ── RETENTIA din bucket (regula de lifecycle) ────────────────────────────────────────────────
//
// De ce traieste AICI si nu doar in consola furnizorului: o regula setata cu mana dintr-o
// interfata web e configuratie invizibila — nimeni nu stie ca exista, nimeni n-o poate reface
// dupa o migrare de furnizor si nimic nu semnaleaza cand cineva o schimba. Aceeasi lectie ca la
// configul nginx, care a driftat doua saptamani fara sa se vada (vezi `npm run nginx-drift`).
//
// Cifra: local se pastreaza 14 arhive complete (CONTAB_BACKUP_KEEP_FULL). Offsite-ul e plasa de
// DEZASTRU, deci trebuie sa acopere si o problema descoperita tarziu (o corupere care se vede
// abia la o inchidere de trimestru), nu doar accidentul de ieri. La ~0,2 MB pe zi, 180 de zile
// inseamna ~36 MB — costul nu e argumentul, marginirea cresterii este.
const RETENTIE_ZILE = 180;
const RETENTIE_MULTIPART_ZILE = 7; // urcari intrerupte: ocupa spatiu FACTURABIL si nu se vad la listare

/** XML-ul regulii de retentie. Pur, deci verificabil fara retea. */
function lifecycleXml(prefix, days, abortDays) {
  const p = String(prefix || '').replace(/\/$/, '');
  return '<LifecycleConfiguration>'
    + '<Rule>'
    + '<ID>contab-arhive</ID>'
    + '<Filter><Prefix>' + (p ? p + '/' : '') + '</Prefix></Filter>'
    + '<Status>Enabled</Status>'
    + '<Expiration><Days>' + Number(days || RETENTIE_ZILE) + '</Days></Expiration>'
    + '<AbortIncompleteMultipartUpload><DaysAfterInitiation>'
    + Number(abortDays || RETENTIE_MULTIPART_ZILE) + '</DaysAfterInitiation></AbortIncompleteMultipartUpload>'
    + '</Rule>'
    + '</LifecycleConfiguration>';
}

/** Citeste din XML ce s-a aplicat efectiv — ca sa se compare cu ce am CERUT, nu cu ce am trimis. */
function lifecycleSummary(xml) {
  const s = String(xml || '');
  if (!s.trim()) return null;
  const num = (re) => { const m = s.match(re); return m ? Number(m[1]) : null; };
  const mPrefix = s.match(/<Prefix>([^<]*)<\/Prefix>/);
  return {
    prefix: mPrefix ? mPrefix[1] : '',
    activa: /<Status>Enabled<\/Status>/.test(s),
    zile: num(/<Expiration>\s*<Days>(\d+)<\/Days>/),
    zileMultipart: num(/<DaysAfterInitiation>(\d+)<\/DaysAfterInitiation>/),
  };
}

/** Aplica regula de retentie pe bucket. S3 cere Content-MD5 pe aceasta operatiune. */
async function putBucketLifecycle(cfg, xml, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const payload = Buffer.from(xml, 'utf8');
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const s = signRequest({
    method: 'PUT', endpoint: cfg.endpoint, region: cfg.region, bucket: cfg.bucket, key: '',
    accessKey: cfg.accessKey, secretKey: cfg.secretKey, payload, amzDate,
    query: 'lifecycle=', contentType: 'application/xml',
    extraHeaders: { 'content-md5': crypto.createHash('md5').update(payload).digest('base64') },
  });
  const r = await doFetch(s.url, { method: 'PUT', headers: s.headers, body: payload });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error('S3 PUT lifecycle ' + r.status + ': ' + String(txt).slice(0, 300));
  }
  return { ok: true, status: r.status };
}

/** Citeste regula existenta. Bucket fara regula => '' (nu e o eroare, e o stare). */
async function getBucketLifecycle(cfg, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const s = signRequest({
    method: 'GET', endpoint: cfg.endpoint, region: cfg.region, bucket: cfg.bucket, key: '',
    accessKey: cfg.accessKey, secretKey: cfg.secretKey, payload: Buffer.alloc(0), amzDate,
    query: 'lifecycle=',
  });
  const r = await doFetch(s.url, { method: 'GET', headers: s.headers });
  const txt = await r.text().catch(() => '');
  if (r.status === 404 || /NoSuchLifecycleConfiguration/.test(txt)) return '';
  if (!r.ok) throw new Error('S3 GET lifecycle ' + r.status + ': ' + String(txt).slice(0, 300));
  return txt;
}

/**
 * Avertismentul de CONFIDENTIALITATE al copiei offsite.
 *
 * O copie plecata fara criptare NU e un esec de backup — arhiva chiar a ajuns undeva — dar e o
 * expunere, si pana acum trecea complet tacut: singurul avertisment din scripts/backup.js se
 * declansa cand NU exista nicio destinatie configurata. Cu e-mailul configurat si fara cheie,
 * logul spunea „Offsite email OK" si atat.
 *
 * Masurat pe productie la 2026-07-29: `CONTAB_BACKUP_KEY` lipsea, deci arhiva zilnica —
 * db.json + contab.sql + uploads/, adica toate datele fiscale ale tuturor firmelor — pleca in
 * CLAR catre o cutie postala terta, exact ce itemul de backlog voia sa elimine. Codul criptat
 * exista si era testat; lipsea doar configurarea, si nimic nu o semnala.
 *
 * Severitate: avertisment, nu esec. Backupul si-a facut treaba, iar `exitCode=1` aici ar
 * confunda „nu am backup" (grav, disponibilitate) cu „am backup neprotejat" (grav, dar altfel)
 * — si ar toci semnalul care conteaza cel mai mult.
 *
 * @returns {string} mesajul de avertizare, sau '' daca nu e nimic de semnalat
 */
function confidentialityWarning(stare) {
  const s = stare || {};
  if (!s.sent || s.encrypted) return '';
  return 'ATENTIE: copia offsite a plecat NECRIPTATA'
    + (s.viaEmail ? ' prin e-mail (cutie postala terta)' : '')
    + ' — arhiva contine db.json, contab.sql si uploads/, adica toate datele fiscale. '
    + 'Seteaza CONTAB_BACKUP_KEY (cheia NU se tine langa backup) si verifica cu `npm run offsite-check`. '
    + 'Detalii: docs/rulare.md, sectiunea RTO / RPO.';
}

module.exports = { signRequest, signingKey, putObject, getObject, configured, fromEnv, uriEncodePath, confidentialityWarning,
  lifecycleXml, lifecycleSummary, putBucketLifecycle, getBucketLifecycle, RETENTIE_ZILE, RETENTIE_MULTIPART_ZILE };
