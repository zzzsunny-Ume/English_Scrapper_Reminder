// 오프라인 앱 셸 캐싱 + 웹푸시 수신/클릭 처리.
// API 호출(worker-api)은 항상 최신 데이터가 필요하므로 캐싱하지 않고 네트워크로만 보낸다.

const CACHE_VERSION = 'v2'; // v1 캐시에 API 응답이 잘못 섞여 들어간 적이 있어서, 기존 설치본도 강제로 비우기 위해 버전 올림
const CACHE_NAME = `english-review-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 블랙리스트(특정 API 호스트만 제외) 대신 화이트리스트로 바꿈 - 우리 앱 셸(같은
  // origin, GET)만 캐싱 대상으로 삼고 그 외(worker-api, 구글 로그인 등 다른 origin
  // 전부)는 항상 네트워크로 직행시킨다. 예전엔 API 호스트를 하나씩 나열해서 막았는데,
  // 백엔드를 Cloudflare Worker로 옮기면서 그 목록이 안 맞게 돼 API 응답까지 캐싱되어
  // 버렸음 - 홈 화면에 설치해서 쓰는 사람은 매번 새로고침해야만 최신 데이터가 보이는
  // 원인이었다.
  const isSameOrigin = url.origin === self.location.origin;
  if (event.request.method !== 'GET' || !isSameOrigin) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

// ===== 웹푸시 수신 =====
// 페이로드 없이(비어있는) 푸시도 지원: 발송 서버가 개인화된 문구를 못 담아 보내는
// 최악의 경우에도 최소한 "복습할 게 있어요"라는 알림은 뜨도록 기본 문구를 둔다.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : '' };
  }

  const title = data.title || '오늘 복습할 표현이 있어요 📚';
  const body = data.body || '지금 열어서 망각곡선이 알려주는 타이밍에 복습해보세요.';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: 'due-review',
      renotify: true,
      data: { url: data.url || './index.html' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './index.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('index.html') && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
