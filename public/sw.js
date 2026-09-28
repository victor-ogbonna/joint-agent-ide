/*
 * Joint-Agent service worker.
 *
 * It exists so Chrome offers "Install app". It caches nothing: every request
 * reaches the server exactly as it would without it, so a deploy is live on
 * the next load, as before. The one thing it adds is a page of its own when a
 * page load fails for want of a connection, in place of the browser's error.
 *
 * Only page loads pass through here. API calls, the agent's streamed replies,
 * the serial WebSocket and WebUSB never do. Sign-in (/__/auth/*) and /api/*
 * pages are left alone entirely.
 */

const OFFLINE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0B0D12">
<title>Joint-Agent IDE — offline</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: radial-gradient(120% 90% at 50% 44%, rgba(249, 115, 22, 0.11), transparent 62%), #08090d;
    color: #e6e8ee; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    text-align: center; padding: 24px; box-sizing: border-box;
  }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { font-size: 14px; line-height: 1.5; color: #9aa1b2; margin: 0 0 24px; max-width: 320px; }
  button {
    font: inherit; font-size: 15px; font-weight: 700; color: #fff; border: 0; cursor: pointer;
    padding: 12px 28px; border-radius: 999px; background: #f97316;
  }
</style>
</head>
<body>
  <main>
    <h1>You're offline</h1>
    <p>Joint-Agent needs a connection to write, compile and flash. Reconnect, then try again.</p>
    <button onclick="location.reload()">Try again</button>
  </main>
</body>
</html>`;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.mode !== "navigate") return;
  const path = new URL(request.url).pathname;
  if (path.startsWith("/__/") || path.startsWith("/api/")) return;
  event.respondWith(
    fetch(request).catch(
      () =>
        new Response(OFFLINE_PAGE, {
          status: 503,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        }),
    ),
  );
});
