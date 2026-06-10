// worker.js — FitPulse Service Worker
const SW_VERSION = 'fitpulse-v1.0.3';
const STATIC_CACHE = `fp-static-${SW_VERSION}`;
const RUNTIME_CACHE = `fp-runtime-${SW_VERSION}`;
const IMAGE_CACHE = `fp-images-${SW_VERSION}`;

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/logger',
  '/history',
  '/analytics',
  '/schedule',
  '/exercises'
];

const OFFLINE_FALLBACK = '/';

// ---------- INSTALL ----------
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => {
      return Promise.all(
        PRECACHE_URLS.map(url =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ---------- ACTIVATE ----------
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => ![STATIC_CACHE, RUNTIME_CACHE, IMAGE_CACHE].includes(k))
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ---------- HELPERS ----------
function isNavigationRequest(req) {
  return req.mode === 'navigate' ||
    (req.method === 'GET' && req.headers.get('accept') && req.headers.get('accept').includes('text/html'));
}

function isImageRequest(req) {
  if (req.destination === 'image') return true;
  const url = new URL(req.url);
  return /\.(png|jpg|jpeg|webp|gif|svg|ico)$/i.test(url.pathname);
}

function isFontRequest(req) {
  if (req.destination === 'font') return true;
  const url = req.url;
  return url.includes('fonts.gstatic.com') ||
         url.includes('fonts.googleapis.com') ||
         /\.(woff2?|ttf|otf|eot)$/i.test(new URL(url).pathname);
}

function isStaticAsset(req) {
  const url = new URL(req.url);
  return /\.(css|js|json)$/i.test(url.pathname);
}

function isSupabaseAPI(req) {
  return req.url.includes('supabase.co/rest/') ||
         req.url.includes('supabase.co/auth/') ||
         req.url.includes('supabase.co/realtime/');
}

function isSupabaseStorage(req) {
  return req.url.includes('supabase.co/storage/');
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const networkFetch = fetch(req).then(res => {
    if (res && res.status === 200 && res.type !== 'opaqueredirect') {
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  }).catch(() => cached);
  return cached || networkFetch;
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.status === 200) {
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  } catch (e) {
    return cached || Response.error();
  }
}

async function networkFirst(req, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName);
  return new Promise(async resolve => {
    let settled = false;
    const timer = setTimeout(async () => {
      if (settled) return;
      const cached = await cache.match(req);
      if (cached) { settled = true; resolve(cached); }
    }, timeoutMs || 3000);

    try {
      const res = await fetch(req);
      settled = true;
      clearTimeout(timer);
      if (res && res.status === 200 && req.method === 'GET') {
        cache.put(req, res.clone()).catch(() => {});
      }
      resolve(res);
    } catch (e) {
      clearTimeout(timer);
      const cached = await cache.match(req);
      if (cached) resolve(cached);
      else if (isNavigationRequest(req)) {
        const fallback = await cache.match(OFFLINE_FALLBACK) || await caches.match(OFFLINE_FALLBACK);
        resolve(fallback || Response.error());
      } else {
        resolve(Response.error());
      }
    }
  });
}

// ---------- FETCH ----------
self.addEventListener('fetch', event => {
  const req = event.request;

  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Skip cross-origin non-cacheable
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Supabase API/auth/realtime — always network, never cache
  if (isSupabaseAPI(req)) return;

  // Navigation requests — network first with offline fallback
  if (isNavigationRequest(req)) {
    event.respondWith(networkFirst(req, RUNTIME_CACHE, 3000));
    return;
  }

  // Supabase storage (logo, audio files) — cache first
  if (isSupabaseStorage(req)) {
    event.respondWith(cacheFirst(req, IMAGE_CACHE));
    return;
  }

  // Images — cache first
  if (isImageRequest(req)) {
    event.respondWith(cacheFirst(req, IMAGE_CACHE));
    return;
  }

  // Fonts — cache first (long-lived)
  if (isFontRequest(req)) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  // CSS / JS / JSON — stale while revalidate
  if (isStaticAsset(req)) {
    event.respondWith(staleWhileRevalidate(req, STATIC_CACHE));
    return;
  }

  // CDN scripts (jsdelivr, cloudflare, googleapis) — stale while revalidate
  if (
    url.hostname.includes('jsdelivr.net') ||
    url.hostname.includes('cloudflare.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('gstatic.com')
  ) {
    event.respondWith(staleWhileRevalidate(req, STATIC_CACHE));
    return;
  }

  // Default — network first
  event.respondWith(networkFirst(req, RUNTIME_CACHE, 4000));
});

// ---------- BACKGROUND SYNC ----------
self.addEventListener('sync', event => {
  if (event.tag === 'fp-sync-queue') {
    event.waitUntil(notifyClientsToSync());
  }
});

async function notifyClientsToSync() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach(c => c.postMessage({ type: 'PROCESS_SYNC_QUEUE' }));
}

// ---------- MESSAGES ----------
const scheduledNotifications = new Map();

self.addEventListener('message', event => {
  if (!event.data) return;
  const { type, payload } = event.data;

  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (type === 'CLEAR_CACHES') {
    event.waitUntil(
      caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
    );
    return;
  }

  if (type === 'SCHEDULE_NOTIFICATION' && payload) {
    scheduleNotification(payload);
    return;
  }

  if (type === 'CANCEL_NOTIFICATION' && payload && payload.id) {
    const timer = scheduledNotifications.get(payload.id);
    if (timer) {
      clearTimeout(timer);
      scheduledNotifications.delete(payload.id);
    }
    return;
  }
});

function scheduleNotification(payload) {
  const { id, title, body, delayMs, url, icon, tag } = payload;
  const notifId = id || ('fp-' + Date.now());
  const delay = Math.max(0, parseInt(delayMs) || 0);

  if (scheduledNotifications.has(notifId)) {
    clearTimeout(scheduledNotifications.get(notifId));
  }

  const timer = setTimeout(() => {
    self.registration.showNotification(title || 'Fit Pulse', {
      body: body || '',
      icon: icon || 'https://pavzofvewfzvertuizyp.supabase.co/storage/v1/object/public/FILES/logo1.webp',
      badge: 'https://pavzofvewfzvertuizyp.supabase.co/storage/v1/object/public/FILES/logo1.webp',
      tag: tag || notifId,
      vibrate: [80, 40, 80],
      data: { url: url || '/logger', id: notifId },
      requireInteraction: false
    }).catch(() => {});
    scheduledNotifications.delete(notifId);
  }, delay);

  scheduledNotifications.set(notifId, timer);
}

// ---------- PUSH ----------
self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Fit Pulse', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Fit Pulse';
  const options = {
    body: data.body || '',
    icon: data.icon || 'https://pavzofvewfzvertuizyp.supabase.co/storage/v1/object/public/FILES/logo1.webp',
    badge: 'https://pavzofvewfzvertuizyp.supabase.co/storage/v1/object/public/FILES/logo1.webp',
    tag: data.tag || 'fp-push',
    vibrate: [80, 40, 80],
    data: { url: data.url || '/logger' },
    requireInteraction: !!data.requireInteraction
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ---------- NOTIFICATION CLICK ----------
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/logger';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({ type: 'NOTIFICATION_CLICK', url: targetUrl });
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

// ---------- SHARE TARGET (optional) ----------
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method === 'GET' && url.searchParams.get('share') === '1') {
    event.respondWith(Response.redirect('/', 303));
  }
});
