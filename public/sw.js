const CACHE_NAME = 'marhaba-connect-v5';
const APP_SHELL = [
  '/manifest.webmanifest',
  '/pwa-192x192.png',
  '/pwa-512x512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;

  // Always network-first for HTML, JS, CSS so updates apply immediately on mobile/APK
  if (
    request.mode === 'navigate' ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname === '/'
  ) {
    event.respondWith(
      fetch(request).catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        const cachedCt = (cached.headers.get('content-type') || '').toLowerCase();
        if (!(cachedCt.includes('text/html') && request.destination !== 'document')) {
          return cached;
        }
      }
      return fetch(request).then((response) => {
        const ct = (response?.headers.get('content-type') || '').toLowerCase();
        if (response && response.status === 200 && response.type === 'basic' && !ct.includes('text/html')) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});

self.addEventListener('push', (event) => {
  let payload = {
    type: 'message',
    title: 'Marhaba Connect',
    body: '',
    tag: 'marhaba_push',
    chatId: '',
    callId: '',
    url: '/',
    requireInteraction: false,
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      if (parsed && typeof parsed === 'object') {
        payload = { ...payload, ...parsed };
      }
    } catch {
      const text = event.data.text();
      if (text) payload.body = text;
    }
  }

  const isCall = payload.type === 'call';
  const safeUrl = typeof payload.url === 'string' && payload.url.startsWith('/') ? payload.url : '/';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        const hasVisibleFocusedClient = clients.some(
          (client) => client.focused && client.visibilityState === 'visible'
        );
        if (hasVisibleFocusedClient) {
          return undefined;
        }

        return self.registration.showNotification(payload.title || 'Marhaba Connect', {
          body: payload.body || '',
          icon: '/pwa-192x192.png',
          badge: '/pwa-192x192.png',
          tag: payload.tag || (isCall ? 'marhaba_call' : 'marhaba_message'),
          renotify: true,
          requireInteraction: Boolean(payload.requireInteraction || isCall),
          vibrate: isCall ? [300, 150, 300, 150, 400] : [180, 80, 180],
          data: {
            type: payload.type,
            chatId: payload.chatId || '',
            callId: payload.callId || '',
            url: safeUrl,
          },
        });
      })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const targetUrl = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if (client.url.startsWith(self.location.origin) && 'focus' in client) {
            return client.focus().then((focusedClient) => {
              focusedClient?.postMessage({
                type: 'notification:open',
                data,
              });
              return focusedClient;
            });
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
        return undefined;
      })
  );
});
