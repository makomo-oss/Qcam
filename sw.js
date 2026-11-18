const CACHE_VERSION = 'qcam-v1.7.0';
const APP_SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/main.css',
  './src/main.js',
  './src/utils/platform.js',
  './src/utils/geometry.js',
  './src/utils/resolution.js',
  './src/utils/camera-lenses.js',
  './src/camera/camera-controller.js',
  './src/processing/frame-aligner.js',
  './src/processing/glsl-shaders.js',
  './src/processing/webgl-processor.js',
  './src/processing/avif-encoder.js',
  './src/processing/image-pipeline.js',
  './src/vendor/avif/avif_enc.js',
  './src/vendor/avif/avif_enc.wasm',
  './src/vendor/avif/LICENSE',
  './src/workers/image-processor.worker.js',
  './src/storage/media-saver.js',
  './src/ui/camera-ui.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

function isBinaryOrMediaAsset(pathname) {
  return /\.(wasm|png|svg|ico|webp)$/i.test(pathname) || pathname.endsWith('/LICENSE');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      const freshRequests = APP_SHELL_ASSETS.map(
        (asset) => new Request(asset, { cache: 'reload' })
      );
      return cache.addAll(freshRequests);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_VERSION)
            .map((oldKey) => caches.delete(oldKey))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Network-first for HTML navigations so updates propagate in lockstep with JS/CSS
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put('./index.html', copy));
          }
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Heavy WASM binary and icons remain cache-first per versioned cache; offline-capable fallback
  if (isBinaryOrMediaAsset(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      })
    );
    return;
  }

  // Code assets (JS / CSS / manifest): Network-first with conditional revalidation (cache: 'no-cache')
  // so index.html and JS modules never mix across versions while still working cleanly offline.
  const netRequest =
    request.cache === 'only-if-cached'
      ? request
      : new Request(request, { cache: 'no-cache' });
  event.respondWith(
    fetch(netRequest)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
