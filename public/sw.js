// App-shell cache so the player keeps working offline. Downloaded episode audio
// lives in its own cache, written by js/downloads.js, and is never purged here.

const SHELL = 'shell-v9';
const SHELL_FILES = [
  '/',
  '/index.html',
  '/app.html',
  '/styles/landing.css',
  '/js/landing.js',
  '/js/account.js',
  '/manifest.webmanifest',
  '/icon.svg',
  '/styles/app.css',
  '/js/main.js',
  '/js/chrome.js',
  '/js/store.js',
  '/js/player.js',
  '/js/downloads.js',
  '/js/db.js',
  '/js/api.js',
  '/js/feed.js',
  '/js/format.js',
  '/js/opml.js',
  '/js/dom.js',
  '/js/routes.js',
  '/js/icons.js',
  '/js/components.js',
  '/js/menu.js',
  '/js/views/home.js',
  '/js/views/explore.js',
  '/js/views/activity.js',
  '/js/views/show.js',
  '/js/views/settings.js',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' bypasses the HTTP cache, so a new worker always installs
  // the files that were just deployed rather than whatever the browser held.
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) =>
        cache.addAll(SHELL_FILES.map((path) => new Request(path, { cache: 'reload' }))),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== SHELL && !key.startsWith('episode-audio')).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Feed and search responses must stay live; only the shell is cached.
  if (url.pathname.startsWith('/api/')) return;

  // Navigations fall back to the cached shell when the network is gone. The
  // player and the landing page are different documents, so pick by path.
  if (request.mode === 'navigate') {
    const shell = url.pathname.startsWith('/app') ? '/app.html' : '/index.html';
    event.respondWith(fetch(request).catch(() => caches.match(shell)));
    return;
  }

  // Code and styles go to the network first.
  //
  // This used to be cache-first for everything, which meant a returning visitor
  // kept running whatever JavaScript their browser had saved - a deploy was
  // invisible until SHELL was renamed, and forgetting to rename it shipped an
  // update nobody could see. Assets are served no-cache with ETags, so the
  // usual answer here is a cheap 304.
  const codeLike = /\.(js|css|html|json|webmanifest)$/.test(url.pathname);

  if (codeLike) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(SHELL).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        // Offline: whatever was last seen is better than nothing.
        .catch(() => caches.match(request)),
    );
    return;
  }

  // Artwork and icons change rarely and are heavy, so those stay cache-first.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(SHELL).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
