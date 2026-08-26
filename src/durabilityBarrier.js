'use strict';

// Bariera de durabilitate pentru raspunsurile HTTP pe PostgreSQL.
//
// Aplicatia isi muta graful in RAM sincron, iar storePg comite asincron. Fara aceasta bariera,
// `res.json({ ok: true })` putea ajunge la client inainte de COMMIT; o cadere de proces sau un
// ROLLBACK imediat dupa raspuns transforma un succes confirmat intr-o operatiune pierduta.
//
// Interceptam numai finalizarea raspunsului (res.end), nu API-ul fiecarei rute. Astfel acoperim
// central toate raspunsurile bufferizate Express (json/send/download) fara sa convertim sute de
// handlere in async. Fisierele statice sunt inregistrate inaintea middleware-ului. Fluxurile care
// au trimis deja anteturile nu mai pot fi inlocuite in siguranta; ele sunt livrabile de citire,
// nu raspunsuri de confirmare a unei mutatii.

const API_PATH = /^\/(api|pdf|xml|csv|efactura)(?:\/|$)/;

function createDurabilityBarrier(db, log) {
  return function durabilityBarrier(req, res, next) {
    if (!db || db.DRIVER !== 'pg' || !API_PATH.test(req.path || '')) return next();

    const originalEnd = res.end;
    let waiting = false;

    res.end = function durableEnd() {
      const args = Array.from(arguments);

      // `write()`/pipe() a pornit deja fluxul: statusul si anteturile nu mai pot fi schimbate.
      if (res.headersSent) return Reflect.apply(originalEnd, res, args);
      if (waiting) return res;

      // Calea rapida pentru citiri intre tranzactii: nu introduce nici macar un microtask cand
      // store-ul confirma explicit ca nu exista lucru in zbor si nicio eroare nevindecata.
      // `draining` este verificat separat: pendingWork devine null CAT TIMP tranzactia ruleaza.
      if (typeof db.persistStats === 'function') {
        const s = db.persistStats();
        if (!s.pending && !s.draining && !s.failStreak && !s.conflicted) {
          return Reflect.apply(originalEnd, res, args);
        }
      }
      waiting = true;

      Promise.resolve()
        .then(() => db.flushStore())
        // Outbox-ul se dreneaza numai DUPA commitul mutatiei; apoi confirmam si marcajul
        // `deliveredAt`. Mock-urile de contract pot omite functia fara sa depinda de baza reala.
        .then(() => (typeof db.drainAuditOutbox === 'function' ? db.drainAuditOutbox() : null))
        .then(() => db.flushStore())
        .then(() => Reflect.apply(originalEnd, res, args))
        .catch((err) => {
          if (res.headersSent) return Reflect.apply(originalEnd, res, args);

          const body = JSON.stringify({
            error: 'Salvarea nu a fost confirmata de baza de date. Operatiunea nu este confirmata; reincarca pagina inainte de a reincerca.',
            reqId: req.reqId,
          });
          res.statusCode = 503;
          res.removeHeader('Content-Length');
          res.removeHeader('Content-Encoding');
          res.removeHeader('ETag');
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Content-Length', Buffer.byteLength(body));
          if (log && typeof log.error === 'function') {
            log.error('commit PostgreSQL neconfirmat; raspunsul HTTP a fost oprit', {
              reqId: req.reqId,
              method: req.method,
              path: req.originalUrl || req.path,
              status: 503,
              err,
            });
          }
          return Reflect.apply(originalEnd, res, [req.method === 'HEAD' ? '' : body]);
        });
      return res;
    };

    next();
  };
}

module.exports = { createDurabilityBarrier };
