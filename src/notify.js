'use strict';

const secretbox = require('./secretbox');
const { sendResend } = require('./resend');

// Trimiterea de emailuri: SMTP-ul configurat in Setari sau, in lipsa, API-ul Resend
// (RESEND_API_KEY din .env). Tot aici: digestul zilnic cu termenele fiscale.

const db = require('./db');
const decl = require('./declarations');
const billing = require('./billing');

/** Trimitere prin SMTP-ul din Setari (nodemailer). */
function sendMail(smtp, to, subject, text) {
  let nodemailer;
  try { nodemailer = require('nodemailer'); } catch (_) { throw new Error('nodemailer neinstalat'); }
  const t = nodemailer.createTransport({ host: smtp.host, port: smtp.port || 587, secure: !!smtp.secure, auth: smtp.user ? { user: smtp.user, pass: secretbox.open(smtp.pass) } : undefined });
  return t.sendMail({ from: smtp.from || smtp.user, to, subject, text });
}

/** SMTP daca e configurat, altfel Resend. Arunca daca niciunul nu e disponibil. */
async function sendNotifMail(to, subject, text) {
  const smtp = db.get().settings.smtp || {};
  if (smtp.host) return sendMail(smtp, to, subject, text);
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('Nici SMTP, nici RESEND_API_KEY nu sunt configurate.');
  return sendResend(key, { from: 'Contab <comenzi@poetio.site>', to, subject, text, ua: 'contab-app/1.0' });
}

function digestText(n) {
  const line = (i) => '  • [' + (i.firma || 'firma') + '] ' + i.nume + ' — luna ' + i.period + ', termen ' + i.due;
  const rest = n.items.filter((i) => i.kind === 'restanta');
  const term = n.items.filter((i) => i.kind === 'termen');
  let s = 'Ai ' + n.count + ' notificări de termene fiscale în Contab (' + billing.appUrl() + '):\n';
  if (rest.length) s += '\nRESTANȚE (termen depășit):\n' + rest.map(line).join('\n') + '\n';
  if (term.length) s += '\nTERMENE ÎN URMĂTOARELE 7 ZILE:\n' + term.map(line).join('\n') + '\n';
  s += '\nMarchează depunerile în aplicație: Declarații ANAF → Registrul depunerilor.\n'
    + 'Poți dezactiva aceste emailuri din Setări → Contul meu.\n';
  return s;
}

/** Trimite digestul cu termene fiecarui utilizator cu email si notificari active. */
async function sendDeadlineDigests() {
  const d = db.get();
  const out = { sent: [], skipped: 0, errors: [] };
  for (const u of d.users) {
    if (!u.email || u.notifyDeadlines === false || u.username === 'demo' || u.pending) { out.skipped++; continue; }
    const fids = u.role === 'admin' ? d.firme.map((f) => f.id) : (u.firme || []);
    if (!fids.length) { out.skipped++; continue; }
    const n = decl.notifications(d, fids.map((id) => db.scoped(id)));
    if (!n.count) { out.skipped++; continue; }
    try {
      await sendNotifMail(u.email, '[Contab] ' + n.count + ' termene fiscale / restanțe', digestText(n));
      out.sent.push(u.email);
    } catch (e) { out.errors.push(u.username + ': ' + e.message); }
  }
  return out;
}

module.exports = { sendMail, sendNotifMail, digestText, sendDeadlineDigests };
