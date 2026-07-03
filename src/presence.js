'use strict';

// Prezenta administratorilor + decizia de notificare pe email la mesaje noi de suport.
// „Online" = un admin a fost activ recent (o sesiune cu lastSeen proaspat). lastSeen se
// reimprospateaza la cererile autentificate (cu throttle de ~5 min), deci fereastra e ceva mai larga.

const ADMIN_ONLINE_WINDOW = 7 * 60 * 1000;      // activ in ultimele ~7 min => online
const SUPPORT_EMAIL_COOLDOWN = 15 * 60 * 1000;  // cel mult un email la 15 min per admin (anti-spam)

/** Exista vreun administrator online (sesiune activa recent)? */
function anyAdminOnline(users, now) {
  now = now || Date.now();
  return (users || []).some((u) => u.role === 'admin'
    && (u.sessions || []).some((s) => now - Date.parse(s.lastSeen || s.createdAt || 0) < ADMIN_ONLINE_WINDOW));
}

/**
 * Administratorii care trebuie notificati pe email acum:
 *  - daca vreun admin e online -> nimeni (vede in aplicatie);
 *  - altfel: adminii cu email setat, finalizati, in afara perioadei de cooldown.
 */
function adminsToEmail(users, now) {
  now = now || Date.now();
  if (anyAdminOnline(users, now)) return [];
  return (users || []).filter((u) => u.role === 'admin' && u.email && !u.pending
    && (!u.lastSupportEmailAt || now - u.lastSupportEmailAt >= SUPPORT_EMAIL_COOLDOWN));
}

module.exports = { anyAdminOnline, adminsToEmail, ADMIN_ONLINE_WINDOW, SUPPORT_EMAIL_COOLDOWN };
