// Service worker: guarda o "casco" do app para abrir mesmo sem internet
// e gerencia Web Push em segundo plano com celular bloqueado ou minimizado.
const VERSION = 'nova-os-v10';
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

// ---------- Web Push Notifications (Segundo Plano / Bloqueado) ----------
self.addEventListener('push', (e) => {
  let payload = {
    title: 'Nova OS - Manutenção',
    body: 'Você recebeu um novo alerta de serviço.',
    url: '/#/avisos',
    woId: null,
    kind: 'alerta'
  };

  if (e.data) {
    try {
      const json = e.data.json();
      payload = { ...payload, ...json };
    } catch {
      payload.body = e.data.text() || payload.body;
    }
  }

  const isStop = /PARADA/i.test(payload.title) || /PARADA/i.test(payload.body);
  const isDirect = /Atribuída a Você/i.test(payload.title) || payload.kind === 'atribuicao';

  const options = {
    body: payload.body,
    icon: '/icons/icon.svg',
    badge: '/icons/icon.svg',
    tag: payload.woId ? `wo-${payload.woId}` : `alert-${Date.now()}`,
    renotify: true,
    requireInteraction: isStop || isDirect, // Permanece na tela até o manutentor interagir se for crítico
    vibrate: isStop ? [300, 100, 300, 100, 500] : [200, 100, 200],
    data: {
      url: payload.url || (payload.woId ? `/#/os/${payload.woId}` : '/#/avisos'),
      woId: payload.woId
    },
    actions: payload.woId
      ? [{ action: 'open_wo', title: 'Abrir OS' }, { action: 'dismiss', title: 'Fechar' }]
      : []
  };

  e.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();

  if (e.action === 'dismiss') {
    return;
  }

  const targetUrl = (e.notification.data && e.notification.data.url) || '/';

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Se houver uma janela aberta do app, foca nela e redireciona
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client) {
            return client.navigate(targetUrl);
          } else {
            client.postMessage({ type: 'navigate', url: targetUrl });
            return;
          }
        }
      }
      // Se não houver janela aberta, abre uma nova com a URL do alerta
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
