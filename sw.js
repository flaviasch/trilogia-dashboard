// Trilogia Dashboard — Service Worker v19
// HTML:          sempre rede (no-store)
// JS/CSS locais: Network First → garante versão atual; fallback cache se offline
// Fontes/CDN:    Cache First (raramente mudam)
// Push:          exibe notificação + abre dashboard ao clicar

const CACHE_NAME = 'trilogia-v19';

const ASSETS_TO_CACHE = [
  '/manifest.json',
  '/icons/icon-192-v2.png',
  '/icons/icon-512-v2.png',
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
      // Não força navigate — o controllerchange no index.html já recarrega a página
  );
});

// ── Push: recebe notificação do servidor ─────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = { titulo: 'Trilogia Dashboard', corpo: '', url: '/index.html', tag: 'geral' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) {
    if (event.data) data.corpo = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(data.titulo, {
      body:    data.corpo,
      icon:    '/icons/icon-192-v2.png',
      badge:   '/icons/icon-192-v2.png',
      tag:     data.tag,
      data:    { url: data.url },
      vibrate: [200, 100, 200],
    })
  );
});

// ── NotificationClick: abre ou foca o dashboard ──────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/index.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        // Se já tiver uma aba aberta do dashboard, foca ela
        const dashClient = clients.find(c => c.url.includes(self.location.origin));
        if (dashClient) {
          dashClient.focus();
          dashClient.navigate(targetUrl);
        } else {
          self.clients.openWindow(targetUrl);
        }
      })
  );
});

// ── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET') return;

  // ❶ HTML: SEMPRE vai à rede com cache: 'no-store'
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

  // ❹ JS e CSS locais: Network First
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
