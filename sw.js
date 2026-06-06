self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  event.respondWith(
    new Response(`
      <html>
        <body style="font-family:sans-serif;text-align:center;padding:2rem">
          <h1>chemediaho v2</h1>
          <p>Questa versione è stata dismessa. <a href="https://media.gabrx.eu.org">Vai alla nuova versione</a></p>
        </body>
      </html>
    `, { headers: { 'Content-Type': 'text/html' } })
  );
});
