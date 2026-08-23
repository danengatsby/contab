'use strict';

// Service worker MINIMAL si CONSERVATOR — doar cat sa faca aplicatia instalabila pe homescreen
// si sa reziste la o pierdere scurta de retea. Reguli de securitate/corectitudine, deliberate:
//
//  1. NU atinge NICIODATA date de utilizator: /api, /pdf, /xml, /csv, /efactura trec direct la
//     retea (fara respondWith). Cache-ul e per-ORIGINE, nu per-utilizator — pe un dispozitiv
//     partajat (birou de contabilitate) cache-ul unui raspuns autentificat ar scurge date intre
//     conturi. Shell-ul static (HTML/JS/CSS) nu contine date — ele vin prin /api/meta dupa login.
//  2. NETWORK-FIRST pe shell: cand esti online se ia mereu versiunea proaspata (pastreaza
//     `no-cache`-ul serverului = actualizari instant la deploy); cache-ul e doar plasa de offline.
//  3. Doar GET, doar same-origin. Versiune in numele cache-ului -> activate sterge ce e vechi.

const CACHE = 'contab-shell-v24';
const SHELL = ['/', '/styles.css', '/u.css', '/erp.css', '/design-system.css', '/erp.js', '/formflow.js', '/core.js', '/app.js', '/manifest.webmanifest'];
const BYPASS = /^\/(api|pdf|xml|csv|efactura)(\/|$|\?)/;

self.addEventListener('install', (e) => {
  self.skipWaiting();
  // best-effort: daca un fisier lipseste, instalarea NU pica (addAll ar arunca)
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // doar same-origin
  if (BYPASS.test(url.pathname)) return;             // datele/livrabilele NU se cacheaza vreodata

  // network-first: proaspat cand esti online, cache cand nu esti
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/') : undefined)))
  );
});
