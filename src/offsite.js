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
  } = opts;

  const host = new URL(endpoint).host;
  const dateStamp = amzDate.slice(0, 8);
  const canonicalUri = '/' + uriEncodePath(bucket + '/' + key);
  const payloadHash = sha256hex(payload);

  const headers = {
    host,
    'content-type': contentType,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map((h) => h + ':' + headers[h] + '\n').join('');
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = [dateStamp, region, service, 'aws4_request'].join('/');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(secretKey, dateStamp, region, service))
    .update(stringToSign, 'utf8').digest('hex');

  return {
    url: endpoint.replace(/\/$/, '') + canonicalUri,
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

module.exports = { signRequest, signingKey, putObject, getObject, configured, fromEnv, uriEncodePath };
