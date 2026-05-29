// Trilogia Dashboard — Service Worker v10
// HTML:          sempre rede (no-store)
// JS/CSS locais: Network First → garante versão atual; fallback cache se offline
// Fontes/CDN:    Cache First (raramente mudam)

const CACHE_NAME = 'trilogia-v10';

const ASSETS_TO_CACHE = [
  '/manifest.json',
  '/icons/icon.svg',
];

// ── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.allSettled(
        ASSETS_TO_CACHE.map((url) => cache.add(url).catch(() => {}))
      ))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: remove caches antigas e força reload de todas as abas ─────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clients) => {
        // Força reload — o fetch handler abaixo já garante que HTML vem da rede
        clients.forEach((client) => client.navigate(client.url));
      })
  );
});

// ── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET') return;

  // ❶ HTML: SEMPRE vai à rede com cache: 'no-store', ignorando cache HTTP
  //    Isso garante que qualquer navegação para .html entrega o arquivo atual
  if (
    url.pathname.endsWith('.html') ||
    url.pathname === '/' ||
    url.pathname === ''
  ) {
    event.respondWith(
      fetch(new Request(event.request.url, {
        method: 'GET',
        headers: event.request.headers,
        cache: 'no-store',
        credentials: event.request.credentials,
        redirect: event.request.redirect,
        mode: event.request.mode === 'navigate' ? 'navigate' : event.request.mode,
      })).catch(() => caches.match(event.request))
    );
    return;
  }

  // ❷ Firebase / APIs: sempre network
  if (
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('firebase.googleapis.com') ||
    url.hostname.includes('cloudfunctions.net') ||
    url.hostname.includes('identitytoolkit.googleapis.com') ||
    url.hostname.includes('firestore.googleapis.com')
  ) {
    return;
  }

  // ❸ Fontes e CDNs externos: Cache First
  if (
    url.hostname.includes('fonts.gstatic.com') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('gstatic.com')
  ) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((res) => {
          if (res && res.status === 200) {
            caches.open(CACHE_NAME).then((c) => c.put(event.request, res.clone()));
          }
          return res;
        }).catch(() => new Response('', { status: 503 }));
      })
    );
    return;
  }

  // ❹ JS e CSS locais: Network First — garante código atual; cache só se offline
  if (
    url.hostname === self.location.hostname &&
    (url.pathname.endsWith('.js') || url.pathname.endsWith('.css'))
  ) {
    event.respondWith(
      fetch(new Request(event.request.url, { cache: 'no-store' }))
        .then((res) => {
          if (res && res.status === 200) {
            caches.open(CACHE_NAME).then((c) => c.put(event.request, res.clone()));
          }
          return res;
        })
        .catch(() => caches.match(event.request)
          .then(cached => cached || new Response('', { status: 503 }))
        )
    );
    return;
  }

  // ❺ Imagens, manifest e demais assets: Cache First
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        if (res && res.status === 200) {
          caches.open(CACHE_NAME).then((c) => c.put(event.request, res.clone()));
        }
        return res;
      }).catch(() => new Response('', { status: 503 }));
    })
  );
});
