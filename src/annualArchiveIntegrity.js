'use strict';

// Integritatea dosarului anual este verificabila fara a recalcula contabilitatea. Manifestul
// descrie exact fiecare intrare din ZIP si este semnat HMAC cu o cheie tinuta in afara bazei.
// Nu este o semnatura electronica calificata; este o sigilare tehnica a aplicatiei, cu separare
// de cheie fata de secretul de autentificare.

const crypto = require('crypto');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) if (value[key] !== undefined) out[key] = canonical(value[key]);
  return out;
}

function keyMaterial(opts) {
  const explicit = opts && opts.signingKey;
  const raw = String(explicit || process.env.CONTAB_ARCHIVE_SIGNING_KEY || process.env.CONTAB_AUTH_SECRET || '');
  if (raw.length >= 32) return raw;
  if (String(process.env.CONTAB_DEV || '') === '1' || (opts && opts.allowDevelopmentKey)) {
    return 'contab-development-annual-archive-key-do-not-use-in-production';
  }
  const e = new Error('Sigilarea dosarului anual cere CONTAB_ARCHIVE_SIGNING_KEY sau CONTAB_AUTH_SECRET de minimum 32 de caractere.');
  e.status = 503; throw e;
}

function derivedKey(opts) {
  return crypto.createHmac('sha256', keyMaterial(opts)).update('contab/annual-archive/manifest/v2').digest();
}

function unsignedManifest(manifest) {
  const out = Object.assign({}, manifest);
  delete out.signature;
  return out;
}

function signManifest(manifest, opts) {
  const key = derivedKey(opts);
  const payload = Buffer.from(JSON.stringify(canonical(unsignedManifest(manifest))), 'utf8');
  return {
    algorithm: 'HMAC-SHA256',
    scope: 'manifest-canonic-fara-signature',
    keyId: sha256(key).slice(0, 16),
    value: crypto.createHmac('sha256', key).update(payload).digest('hex'),
  };
}

function safeEqualHex(a, b) {
  if (!/^[0-9a-f]{64}$/i.test(String(a || '')) || !/^[0-9a-f]{64}$/i.test(String(b || ''))) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function rootHash(files) {
  return sha256(Buffer.from((files || []).slice().sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => f.path + ':' + f.sha256).join('\n'), 'utf8'));
}

function verifyBuffer(buffer, opts) {
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(buffer);
    const manifestEntry = zip.getEntry('manifest.json');
    if (!manifestEntry) return { ok: false, reason: 'manifest.json lipsește' };
    const manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
    if (manifest.schemaVersion !== 2) return { ok: false, reason: 'versiune de manifest necunoscută' };
    if (!manifest.signature || manifest.signature.algorithm !== 'HMAC-SHA256') return { ok: false, reason: 'semnătura manifestului lipsește' };
    const expected = new Map((manifest.files || []).map((f) => [f.path, f]));
    if (expected.size !== (manifest.files || []).length) return { ok: false, reason: 'căi duplicate în manifest' };
    const actual = zip.getEntries().filter((e) => !e.isDirectory && e.entryName !== 'manifest.json');
    if (actual.length !== expected.size) return { ok: false, reason: 'setul de fișiere nu coincide cu manifestul' };
    for (const entry of actual) {
      const meta = expected.get(entry.entryName);
      if (!meta) return { ok: false, reason: 'fișier nemarcat în manifest: ' + entry.entryName };
      const bytes = entry.getData();
      if (Number(meta.bytes) !== bytes.length || !safeEqualHex(meta.sha256, sha256(bytes))) {
        return { ok: false, reason: 'amprentă invalidă: ' + entry.entryName };
      }
    }
    if (!safeEqualHex(manifest.contentRootHash, rootHash(manifest.files))) return { ok: false, reason: 'contentRootHash invalid' };
    const expectedSignature = signManifest(manifest, opts);
    if (manifest.signature.keyId !== expectedSignature.keyId
      || !safeEqualHex(manifest.signature.value, expectedSignature.value)) return { ok: false, reason: 'semnătura HMAC nu se verifică' };
    return { ok: true, manifest, files: actual.length, zipSha256: sha256(buffer) };
  } catch (e) { return { ok: false, reason: e.message || String(e) }; }
}

function verifyStored(row, opts) {
  if (!row || !row.zipBase64) return { ok: false, reason: 'binarul ZIP lipsește din înregistrarea arhivei' };
  let buffer;
  try { buffer = Buffer.from(String(row.zipBase64), 'base64'); } catch (e) { return { ok: false, reason: 'base64 invalid' }; }
  const hash = sha256(buffer);
  if (!safeEqualHex(row.zipSha256, hash)) return { ok: false, reason: 'amprenta ZIP stocată nu coincide' };
  if (row.bytes != null && Number(row.bytes) !== buffer.length) return { ok: false, reason: 'dimensiunea ZIP stocată nu coincide' };
  const result = verifyBuffer(buffer, opts);
  if (!result.ok) return result;
  if (String(result.manifest.year) !== String(row.year) || Number(result.manifest.archiveVersion) !== Number(row.version)) {
    return { ok: false, reason: 'identitatea manifestului nu coincide cu înregistrarea persistentă' };
  }
  if (result.manifest.company && result.manifest.company.id != null
    && Number(result.manifest.company.id) !== Number(row.firmaId)) {
    return { ok: false, reason: 'firma din manifest nu coincide cu înregistrarea persistentă' };
  }
  if (row.contentRootHash && !safeEqualHex(row.contentRootHash, result.manifest.contentRootHash)) {
    return { ok: false, reason: 'contentRootHash stocat nu coincide cu manifestul' };
  }
  if (row.signature && (!result.manifest.signature
    || row.signature.keyId !== result.manifest.signature.keyId
    || !safeEqualHex(row.signature.value, result.manifest.signature.value))) {
    return { ok: false, reason: 'semnătura stocată nu coincide cu manifestul' };
  }
  if (row.manifest && JSON.stringify(canonical(row.manifest)) !== JSON.stringify(canonical(result.manifest))) {
    return { ok: false, reason: 'copia manifestului din înregistrare nu coincide cu manifest.json' };
  }
  return Object.assign(result, { buffer });
}

module.exports = { sha256, canonical, rootHash, signManifest, verifyBuffer, verifyStored };
