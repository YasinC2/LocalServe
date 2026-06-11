// ============================================================
// sw.js — Service Worker for LocalServe PWA
// Version: 1.0.0
// ============================================================

const SW_VERSION = '1.0.0';
const CACHE_NAME = 'localserve-v1';
const STATIC_ASSETS = [
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon.svg'
];

// MIME type map for serving local files
const MIME_TYPES = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv'
};

// The prefix used for local-file URLs
const LOCAL_PREFIX = '/__local__/';

// ---- Install: cache static assets ----
self.addEventListener('install', (event) => {
  console.log('[SW] Installing version', SW_VERSION);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ---- Activate: clean old caches ----
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating version', SW_VERSION);
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ---- Helper: get MIME type from file path ----
function getMimeType(filePath) {
  const ext = '.' + filePath.split('.').pop().toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

// ---- Helper: request file from main thread via MessageChannel ----
function requestFileFromClient(client, filePath) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => {
      reject(new Error('Timeout waiting for file: ' + filePath));
    }, 10000);

    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      if (event.data.error) {
        reject(new Error(event.data.error));
      } else {
        resolve(event.data);
      }
    };

    client.postMessage(
      { type: 'GET_FILE', path: filePath },
      [channel.port2]
    );
  });
}

// ---- Fetch handler ----
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Check if this is a request for a local file
  if (url.pathname.startsWith(LOCAL_PREFIX)) {
    event.respondWith(handleLocalFileRequest(event, url));
    return;
  }

  // For normal requests, serve from cache first, then network
  event.respondWith(
    caches.match(event.request).then(cached => {
      return cached || fetch(event.request).catch(() => {
        // Offline fallback for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});

// ---- Handle local file requests ----
async function handleLocalFileRequest(event, url) {
  // Extract the file path from the URL, removing the prefix
  let filePath = decodeURIComponent(url.pathname.substring(LOCAL_PREFIX.length));

  // Normalize: remove leading slash
  if (filePath.startsWith('/')) {
    filePath = filePath.substring(1);
  }

  // Resolve ../ segments properly (e.g., "css/../img/photo.jpg" -> "img/photo.jpg")
  const parts = filePath.split('/');
  const resolved = [];
  for (const part of parts) {
    if (part === '..') {
      resolved.pop();
    } else if (part && part !== '.') {
      resolved.push(part);
    }
  }
  filePath = resolved.join('/');

  try {
    // Always find the main window client (not iframe clients)
    // The main app window is the one at the root URL
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    let client = null;

    // Prefer the client at the app's main URL (not /__local__/ URLs)
    for (const c of allClients) {
      const cUrl = new URL(c.url);
      if (!cUrl.pathname.startsWith(LOCAL_PREFIX)) {
        client = c;
        break;
      }
    }

    // Fallback to any client
    if (!client && allClients.length > 0) {
      client = allClients[0];
    }

    if (!client) {
      return new Response('No active client found', { status: 500 });
    }

    // Request the file from the main thread
    const result = await requestFileFromClient(client, filePath);

    if (!result || (result.content === undefined || result.content === null)) {
      return new Response('File not found: ' + filePath, { status: 404 });
    }

    const mimeType = getMimeType(filePath);
    const headers = {
      'Content-Type': mimeType,
      'Cache-Control': 'no-cache',
      'X-Local-File': 'true'
    };

    // For HTML files, inject a <base> tag so relative resources resolve correctly
    if (mimeType === 'text/html' && typeof result.content === 'string') {
      // Determine the directory of this HTML file
      const lastSlash = filePath.lastIndexOf('/');
      const dir = lastSlash >= 0 ? filePath.substring(0, lastSlash + 1) : '';
      const baseHref = `${LOCAL_PREFIX}${dir}`;

      let html = result.content;

      // Inject <base> tag if not already present
      if (!/<base\s/i.test(html)) {
        // Also inject a script to handle absolute paths (those starting with /)
        const injectScript = `<script>
          // Intercept absolute paths and redirect to local prefix
          (function() {
            const LOCAL_PREFIX = '${LOCAL_PREFIX}';
            // We don't rewrite in this version — the base tag handles relative paths
            // Absolute paths starting with / inside the HTML are rewritten below
          })();
        </script>`;

        if (/<head[^>]*>/i.test(html)) {
          html = html.replace(/(<head[^>]*>)/i, `$1\n<base href="${baseHref}">\n${injectScript}`);
        } else if (/<html[^>]*>/i.test(html)) {
          html = html.replace(/(<html[^>]*>)/i, `$1\n<head><base href="${baseHref}">${injectScript}</head>`);
        } else {
          html = `<head><base href="${baseHref}">${injectScript}</head>\n` + html;
        }
      }

      // Rewrite absolute paths (starting with / but not /__local__/)
      // This converts href="/css/style.css" to href="/__local__/css/style.css"
      html = html.replace(
        /((?:src|href|action|data|poster)\s*=\s*["'])\/(?!_)(.*?["'])/gi,
        `$1${LOCAL_PREFIX}$2`
      );

      return new Response(html, { headers });
    }

    // For CSS files, rewrite absolute url() paths
    if (mimeType === 'text/css' && typeof result.content === 'string') {
      let css = result.content;
      // Rewrite url(/...) to url(/__local__/...)
      css = css.replace(
        /url\(\s*(['"]?)\/(?!_)(.*?)\1\s*\)/gi,
        `url($1${LOCAL_PREFIX}$2$1)`
      );
      return new Response(css, { headers });
    }

    // For JS files that might use fetch('/...') or similar, serve as-is
    // (dynamic paths can't be reliably rewritten statically)

    // For binary files, result.content will be an ArrayBuffer
    return new Response(result.content, { headers });

  } catch (err) {
    console.error('[SW] Error serving local file:', filePath, err);
    return new Response('Error loading file: ' + err.message, {
      status: 500,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

// ---- Message handler for version checks ----
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: SW_VERSION });
  }
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
