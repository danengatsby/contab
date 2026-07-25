'use strict';

// Trimiterea unui email prin API-ul Resend — SINGURA implementare, folosita si de aplicatie
// (src/notify.js) si de scriptul de backup din cron (scripts/backup.js).
//
// De ce un modul separat si nu o functie in notify.js: scriptul de backup ruleaza din cron si NU
// trebuie sa incarce baza de date (notify.js cere ./db, ./declarations, ./billing). Modulul asta
// nu are nicio dependinta — doar fetch.
//
// De ce exista: cele doua locuri aveau copii ale aceleiasi cereri, dar DOAR una verifica raspunsul.
// Copia din backup ignora `r.ok`, deci un 401 (cheie revocata) sau 403 (domeniu neverificat)
// trecea drept succes: alerta „arhiva nerestaurabila" sau „drill esuat" disparea fara nicio urma,
// exact in singurul moment cand contezi pe ea. Un canal de alerta care nu-si verifica raspunsul
// nu e un canal de alerta.

/**
 * Trimite un email prin Resend. ARUNCA daca nu a plecat (status non-2xx sau raspuns fara `id`),
 * ca apelantul sa poata reactiona — a nu confunda „am cerut trimiterea" cu „a plecat".
 * @param {string} key  RESEND_API_KEY
 * @param {{from:string,to:string,subject:string,text:string,ua?:string}} msg
 */
async function sendResend(key, msg) {
  if (!key) throw new Error('RESEND_API_KEY lipseste.');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      'User-Agent': msg.ua || 'contab-app/1.0',
    },
    body: JSON.stringify({ from: msg.from, to: [msg.to], subject: msg.subject, text: msg.text }),
  });
  const t = await r.text();
  // Resend raspunde cu { id } la succes; un 200 fara id ar insemna alt contract decat cel asteptat.
  if (!r.ok || !t.includes('"id"')) throw new Error('Resend ' + r.status + ': ' + t.slice(0, 200));
}

module.exports = { sendResend };
