// Service Worker du Studio TCGBP — stratégie "Network-First" :
// on demande toujours la dernière version au réseau (donc chaque mise à jour poussée
// sur GitHub arrive tout de suite), et on ne sert le cache qu'en secours, hors ligne.

const CACHE = 'studio-tcgbp-v3';

// Bibliothèques externes mises en cache pour que l'app s'ouvre même sans réseau
const CACHEABLE_HOSTS = [
    'cdnjs.cloudflare.com',
    'cdn.jsdelivr.net',
    'fonts.googleapis.com',
    'fonts.gstatic.com'
];

self.addEventListener('install', event => {
    // La nouvelle version prend la main sans attendre la fermeture des onglets
    self.skipWaiting();
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['./', './manifest.json'])));
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    const sameOrigin = url.origin === self.location.origin;
    // Supabase (cartes, images, temps réel) n'est jamais mis en cache : toujours en direct
    if (!sameOrigin && !CACHEABLE_HOSTS.includes(url.hostname)) return;

    event.respondWith(networkFirst(request, sameOrigin));
});

async function networkFirst(request, sameOrigin) {
    const cache = await caches.open(CACHE);
    try {
        // 'no-cache' : on revalide auprès de GitHub Pages au lieu de réutiliser
        // une copie du cache HTTP du navigateur (qui peut garder la page 10 min)
        const response = sameOrigin
            ? await fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' })
            : await fetch(request);
        if (response.ok || response.type === 'opaque') {
            cache.put(request, response.clone());
        }
        return response;
    } catch (err) {
        const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
        if (cached) return cached;
        if (request.mode === 'navigate') {
            const home = await cache.match('./');
            if (home) return home;
        }
        throw err;
    }
}
