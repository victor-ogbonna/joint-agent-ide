/**
 * "Build App (PWA)" for Bluetooth and internet-connected projects: an app
 * package (a .zip) to put on any https website, from where it installs on
 * Android, iPhone and computers.
 *
 * The agent writes the app's page (POST /api/ai/app-page); everything that
 * makes it an installable app is added here, the same way every time: the
 * manifest (name, colour, how it opens, the Joint-Agent icon), a service
 * worker so it opens without a connection, the tags phones read, and a
 * README saying how to put it online and install it.
 */
import type { AppSettings } from "./buildApp";

export interface PackageFile {
  name: string;
  data: Uint8Array;
}

const text = (s: string) => new TextEncoder().encode(s);

/** One of the app's own PNGs (the Joint-Agent icon), checked to really be a PNG. */
export async function fetchPng(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  const bytes = response.ok ? new Uint8Array(await response.arrayBuffer()) : new Uint8Array();
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8 || png.some((b, i) => bytes[i] !== b)) throw new Error("The Joint-Agent icon couldn't be loaded. Check the connection and try again.");
  return bytes;
}

/** A file-system-safe name: "Plant Monitor" → "plant-monitor", "Ada's Lamp" → "adas-lamp". */
export function appSlug(name: string): string {
  const slug = name.normalize("NFKD").replace(/[\u0300-\u036f'\u2019]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return slug || "app";
}

function htmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** What phones read in the page: the manifest, colour, iPhone name and icon, and the service worker. */
export function appPageHead(settings: AppSettings): string {
  const short = htmlEscape(settings.shortName);
  return [
    `<link rel="manifest" href="manifest.webmanifest">`,
    `<meta name="theme-color" content="${settings.themeColor}">`,
    `<meta name="mobile-web-app-capable" content="yes">`,
    `<meta name="apple-mobile-web-app-capable" content="yes">`,
    settings.display === "fullscreen" ? `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">` : "",
    `<meta name="apple-mobile-web-app-title" content="${short}">`,
    `<link rel="apple-touch-icon" href="icons/icon-192.png">`,
    `<link rel="icon" type="image/png" href="icons/icon-192.png">`,
    // Where workers aren't allowed (a private window, a sandboxed preview),
    // reaching for one throws: the app then simply runs without its offline copy.
    `<script>addEventListener("load", function () { try { navigator.serviceWorker.register("sw.js").catch(function () {}); } catch (e) {} });</script>`,
  ].filter(Boolean).join("\n");
}

/**
 * The agent's page, made the app's: its own manifest, icon and worker tags
 * (if it wrote any) replaced by the package's, and a viewport and charset
 * when it has none.
 */
export function prepareAppPage(html: string, settings: AppSettings): string {
  let page = html
    .replace(/<link\b[^>]*\brel\s*=\s*["']?(?:manifest|apple-touch-icon|icon|shortcut icon)["']?[^>]*>/gi, "")
    .replace(/<meta\b[^>]*\bname\s*=\s*["']?(?:theme-color|mobile-web-app-capable|apple-mobile-web-app-[a-z-]+)["']?[^>]*>/gi, "");
  const head = [
    /<meta\b[^>]*\bcharset\b/i.test(page) ? "" : `<meta charset="utf-8">`,
    /<meta\b[^>]*\bname\s*=\s*["']?viewport/i.test(page) ? "" : `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    appPageHead(settings),
  ].filter(Boolean).join("\n");
  if (/<head(?=[\s>])[^>]*>/i.test(page)) return page.replace(/<head(?=[\s>])[^>]*>/i, (m) => `${m}\n${head}`);
  if (/<html(?=[\s>])[^>]*>/i.test(page)) return page.replace(/<html(?=[\s>])[^>]*>/i, (m) => `${m}\n<head>\n${head}\n</head>`);
  return `<!DOCTYPE html>\n<html>\n<head>\n${head}\n</head>\n<body>\n${page}\n</body>\n</html>\n`;
}

export function appManifest(settings: AppSettings): string {
  return JSON.stringify({
    id: "./",
    name: settings.name,
    short_name: settings.shortName,
    start_url: "./",
    scope: "./",
    display: settings.display,
    background_color: "#ffffff",
    theme_color: settings.themeColor,
    icons: [
      { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  }, null, 2) + "\n";
}

/**
 * Opens the app without a connection: the app's own files are kept, and
 * fetched fresh whenever there is one, so an update shows up. Requests to
 * anywhere else (the project's internet service) are left alone.
 */
export function appServiceWorker(version: string): string {
  return `// The app's offline copy. Made by Joint-Agent IDE.
const CACHE = "app-${version}";
const FILES = ["index.html", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES).then(() => cache.add("./").catch(() => {}))));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit || (request.mode === "navigate" ? caches.match("index.html") : undefined)))
      .then((response) => response || Response.error())
  );
});
`;
}

export function appReadme(settings: AppSettings, kind: "bluetooth" | "internet", notes: string): string {
  const lines = [
    `${settings.name}`,
    `${"=".repeat(Array.from(settings.name).length)}`,
    ``,
    `A phone app for your project, made with Joint-Agent IDE.`,
    ``,
    `1. Put it online (free)`,
    `   An app installs only from a secure (https) website. Either:`,
    `   - Netlify Drop: open https://app.netlify.com/drop and drag this whole`,
    `     folder onto the page. You get an https link in a few seconds.`,
    `   - GitHub Pages: upload the files in this folder to a GitHub repository,`,
    `     then turn on Pages under Settings > Pages.`,
    ``,
    `2. Install it`,
    `   Open the https link on the phone or computer, then:`,
    `   - Android (Chrome): menu > Install app (or Add to Home screen).`,
    `   - iPhone / iPad (Safari): Share > Add to Home Screen.`,
    `   - Computer (Chrome or Edge): the install icon at the end of the address bar.`,
    ``,
  ];
  if (kind === "bluetooth") {
    lines.push(
      `Bluetooth`,
      `   The app talks to your board over Bluetooth Low Energy. This works in`,
      `   Chrome and Edge on Android, Windows, Mac, Linux and Chromebooks.`,
      `   iPhone and iPad browsers can't use Bluetooth, so the app can't`,
      `   reach the board from them.`,
      ``,
    );
  } else {
    lines.push(
      `Internet`,
      `   The app talks to the same internet service your board uses. Any`,
      `   password or key it needs is typed into the app's settings and kept`,
      `   only on that phone; none is stored in these files.`,
      ``,
    );
  }
  if (notes.trim()) lines.push(`Notes from the agent`, ...notes.trim().split("\n").map((l) => `   ${l}`), ``);
  lines.push(`Files: index.html (the app), manifest.webmanifest (its name and icon),`, `sw.js (lets it open offline), icons/ (the Joint-Agent icon).`, ``);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// .zip, stored (no compression): what's in an app is small, and every
// unzip tool on every computer and phone reads it.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(files: PackageFile[], when = new Date()): Uint8Array {
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2);
  const date = ((Math.max(1980, when.getFullYear()) - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = text(file.name);
    const crc = crc32(file.data);
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(6, 0x0800, true); // names are UTF-8
    l.setUint16(8, 0, true); // stored
    l.setUint16(10, time, true);
    l.setUint16(12, date, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, file.data.length, true);
    l.setUint32(22, file.data.length, true);
    l.setUint16(26, name.length, true);
    l.setUint16(28, 0, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, file.data.length, true);
    c.setUint32(24, file.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, file.data);
    centrals.push(central);
    offset += local.length + file.data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, centralSize, true);
  e.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, at); at += part.length; }
  return out;
}

/** Every file in the app package, in a folder named after the app. */
export function appPackageFiles(opts: {
  html: string;
  notes: string;
  settings: AppSettings;
  kind: "bluetooth" | "internet";
  icon192: Uint8Array;
  icon512: Uint8Array;
  version: string;
}): PackageFile[] {
  const dir = appSlug(opts.settings.name);
  return [
    { name: `${dir}/index.html`, data: text(prepareAppPage(opts.html, opts.settings)) },
    { name: `${dir}/manifest.webmanifest`, data: text(appManifest(opts.settings)) },
    { name: `${dir}/sw.js`, data: text(appServiceWorker(opts.version)) },
    { name: `${dir}/icons/icon-192.png`, data: opts.icon192 },
    { name: `${dir}/icons/icon-512.png`, data: opts.icon512 },
    { name: `${dir}/README.txt`, data: text(appReadme(opts.settings, opts.kind, opts.notes)) },
  ];
}
