const CACHE_NAME = 'wyplayer-v27';

// 核心资源 - 安装时缓存
const CORE_ASSETS = [
  './',
  './index.html',
  './css/all.min.css',
  './css/noto-sans-sc.css',
  './css/variables.css',
  './css/components.css',
  './js/tailwindcss.js',
  './js/color-thief.umd.js',
  './js/play-effects.js',
  './img/icon.svg',
  './img/icon.png',
  './manifest.json'
];

// 字体文件
const FONT_ASSETS = [
  './fonts/NotoSansSC-Regular.ttf',
  './fonts/NotoSansSC-Medium.ttf',
  './fonts/NotoSansSC-Bold.ttf',
  './fonts/NotoSansSC-Black.ttf'
];

function isApiRequest(url) {
  if (url.pathname.startsWith('/api')) return true;
  const host = url.hostname;
  return (host.includes('workers.dev') || host.includes('pages.dev')) && url.pathname.startsWith('/api');
}

// 安装：缓存核心资源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(CORE_ASSETS).catch(err => {
        console.warn('SW: 部分核心资源缓存失败', err);
      });
    })
  );
  self.skipWaiting();
});

// 激活：清理旧缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      );
    })
  );
  self.clients.claim();
});

// 请求策略
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API 请求：始终网络优先，不缓存
  if (isApiRequest(url)) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 音频流：不缓存
  if (event.request.destination === 'audio' ||
      url.pathname.match(/\.(mp3|flac|wav|ogg|m4a|aac)$/i)) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 封面图片：缓存优先 (网易云 CDN)
  if (url.hostname.includes('music.126.net') && url.pathname.match(/\.(jpg|jpeg|png|webp)/i)) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(resp => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return resp;
        }).catch(() => new Response('', { status: 404 }));
      })
    );
    return;
  }

  // 本地资源：缓存优先，回退网络
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(resp => {
        // 缓存成功的本地资源
        if (resp.ok && url.origin === self.location.origin) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return resp;
      });
    })
  );
});
