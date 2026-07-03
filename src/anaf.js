'use strict';

/**
 * Integrare ANAF e-Factura (SPV) prin OAuth2.
 * Necesita o aplicatie OAuth inregistrata in SPV (client_id/secret) si un
 * certificat digital calificat pentru pasul de autorizare (logincert.anaf.ro).
 * Fluxul: authorize (in browser, cu certificat) -> callback (cod) -> token ->
 * upload UBL -> stareMesaj -> descarcare recipisa.
 */

const AUTH_URL = 'https://logincert.anaf.ro/anaf-oauth2/v1/authorize';
const TOKEN_URL = 'https://logincert.anaf.ro/anaf-oauth2/v1/token';

function apiBase(env) {
  return env === 'prod' ? 'https://api.anaf.ro/prod' : 'https://api.anaf.ro/test';
}

function attr(xml, name) {
  const m = String(xml || '').match(new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i'));
  return m ? m[1] : '';
}

function configured(cfg) {
  return !!(cfg && cfg.clientId && cfg.clientSecret && cfg.redirectUri);
}
function connected(cfg) {
  return !!(cfg && cfg.accessToken);
}

function authorizeUrl(cfg) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    token_content_type: 'jwt',
  });
  return AUTH_URL + '?' + q.toString();
}

async function postToken(cfg, params) {
  const body = new URLSearchParams(Object.assign({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  }, params));
  const auth = Buffer.from(cfg.clientId + ':' + cfg.clientSecret).toString('base64');
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + auth,
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error('ANAF token ' + r.status + ': ' + txt.slice(0, 300));
  let j;
  try { j = JSON.parse(txt); } catch (_) { throw new Error('Raspuns token invalid: ' + txt.slice(0, 200)); }
  return j;
}

/** Schimba codul de autorizare pe token-uri si le scrie in cfg. */
async function exchangeCode(cfg, code) {
  const j = await postToken(cfg, { grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri });
  applyToken(cfg, j);
  return cfg;
}

async function refresh(cfg) {
  if (!cfg.refreshToken) throw new Error('Lipseste refresh_token (reconecteaza-te).');
  const j = await postToken(cfg, { grant_type: 'refresh_token', refresh_token: cfg.refreshToken });
  applyToken(cfg, j);
  return cfg;
}

function applyToken(cfg, j) {
  cfg.accessToken = j.access_token || cfg.accessToken;
  if (j.refresh_token) cfg.refreshToken = j.refresh_token;
  const ttl = Number(j.expires_in) || 0;
  cfg.tokenExpiry = ttl ? Date.now() + ttl * 1000 : Date.now() + 3600 * 1000;
}

/** Returneaza un access token valid, reimprospatand daca e cazul. */
async function ensureToken(cfg) {
  if (!connected(cfg)) throw new Error('Neconectat la SPV. Conecteaza-te mai intai.');
  if (cfg.tokenExpiry && cfg.tokenExpiry < Date.now() + 60000) {
    await refresh(cfg);
  }
  return cfg.accessToken;
}

/** Incarca o factura UBL in SPV. Returneaza index_incarcare. */
async function upload(cfg, xmlStr, cif) {
  const token = await ensureToken(cfg);
  const url = apiBase(cfg.env) + '/FCTEL/rest/upload?standard=UBL&cif=' + encodeURIComponent(cif);
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'text/plain' },
    body: xmlStr,
  });
  const txt = await r.text();
  if (!r.ok) throw new Error('ANAF upload ' + r.status + ': ' + txt.slice(0, 300));
  const status = attr(txt, 'ExecutionStatus');
  const index = attr(txt, 'index_incarcare');
  if (status !== '0' || !index) {
    const err = attr(txt, 'errorMessage') || txt.slice(0, 300);
    throw new Error('Upload respins: ' + err);
  }
  return { index, raw: txt };
}

/** Verifica starea unei incarcari. Returneaza {stare, idDescarcare}. */
async function status(cfg, indexIncarcare) {
  const token = await ensureToken(cfg);
  const url = apiBase(cfg.env) + '/FCTEL/rest/stareMesaj?id_incarcare=' + encodeURIComponent(indexIncarcare);
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const txt = await r.text();
  if (!r.ok) throw new Error('ANAF stareMesaj ' + r.status + ': ' + txt.slice(0, 300));
  return { stare: attr(txt, 'stare') || 'in prelucrare', idDescarcare: attr(txt, 'id_descarcare'), raw: txt };
}

/** Descarca arhiva ZIP (recipisa pentru trimise, factura pentru primite). */
async function download(cfg, idDescarcare) {
  const token = await ensureToken(cfg);
  const url = apiBase(cfg.env) + '/FCTEL/rest/descarcare?id=' + encodeURIComponent(idDescarcare);
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error('ANAF descarcare ' + r.status + ': ' + txt.slice(0, 200));
  }
  const buf = Buffer.from(await r.arrayBuffer());
  return buf;
}

/**
 * Lista mesajelor din SPV pe ultimele `zile` zile.
 * filtru: 'P' = primite, 'T' = trimise, 'E' = erori, 'R' = mesaje (toate).
 */
async function listMessages(cfg, cif, zile, filtru) {
  const token = await ensureToken(cfg);
  const q = new URLSearchParams({ zile: String(zile || 60), cif: String(cif).replace(/^ro/i, '') });
  if (filtru) q.set('filtru', filtru);
  const url = apiBase(cfg.env) + '/FCTEL/rest/listaMesajeFactura?' + q.toString();
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
  const txt = await r.text();
  if (!r.ok) throw new Error('ANAF listaMesaje ' + r.status + ': ' + txt.slice(0, 200));
  let j;
  try { j = JSON.parse(txt); } catch (_) { throw new Error('Raspuns lista invalid: ' + txt.slice(0, 200)); }
  if (j.eroare) throw new Error(j.eroare);
  return Array.isArray(j.mesaje) ? j.mesaje : [];
}

module.exports = { configured, connected, authorizeUrl, exchangeCode, refresh, ensureToken, upload, status, download, listMessages, apiBase };
