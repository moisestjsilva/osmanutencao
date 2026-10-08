// Service worker: guarda o "casco" do app para abrir mesmo sem internet.
// Os dados (OS, máquinas, fila de operações) ficam no IndexedDB, controlados pelo app.
const VERSION = 'nova-os-v8';
const SHELL = [
  '/', '/index.html', '/css/styles.css', '/js/app.js', '/js/store.js', '/js/ui.js', '/js/views.js', '/js/scanner.js',
  '/manifest.webmanifest', '/icons/icon.svg', '/vendor/jsQR.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return; // dados: rede (app trata offline)
  if (url.origin === location.origin && url.pathname.startsWith('/uploads/')) {
    e.respondWith(caches.open(VERSION).then(async (c) => (await c.match(req)) || fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; })));
    return;
  }
  // Casco e fontes: rede primeiro com atualização do cache; sem rede, usa cache
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && (url.origin === location.origin || url.hostname.includes('fonts.'))) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req)) || (req.mode === 'navigate' ? caches.match('/index.html') : Response.error()))
  );
});
