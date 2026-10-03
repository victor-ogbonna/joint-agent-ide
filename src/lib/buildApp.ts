/**
 * "Build App (PWA)": what kind of phone app a project can become, and, when
 * the board serves its own web page, the changes that make that page one.
 *
 * Two kinds, because of two browser rules that clash:
 *   - an app that installs fully has to come from a secure (https) site;
 *   - a secure site may not talk to a board on local Wi-Fi (plain http).
 * So a board that serves its own page keeps serving it, now with an app
 * name and icon ("board"), and a Bluetooth or internet-connected project
 * gets an app package to put on any https site ("package", appPackage.ts).
 *
 * Every change here is made to the sketch's text without an AI: one
 * #include, one JointAgentApp::serve(...) line in setup(), and the app's
 * tags in each page's <head>. Applying again updates them in place, and
 * removing takes exactly them back out.
 */
import { extractHtml } from "../components/WebPreviewPanel";
import { APP_HEADER, APP_HEADER_ASYNC } from "./appHeaders";

export interface AppSettings {
  /** The app's full name, under 30 characters. */
  name: string;
  /** The name under the home-screen icon, 12 characters at most. */
  shortName: string;
  /** "#rrggbb": the colour of the bar above the app. */
  themeColor: string;
  /** "standalone" keeps the phone's status bar; "fullscreen" hides it. */
  display: "standalone" | "fullscreen";
}

export const APP_NAME_MAX = 30;
export const APP_SHORT_NAME_MAX = 12;

/**
 * A name as it may appear in the app: letters and digits in any language,
 * spaces and a few marks. Nothing that means something inside C++ strings,
 * HTML attributes or a page the board fills in (quotes, backslashes, %,
 * angle brackets, ?), so it can go anywhere unescaped but for HTML's & and '.
 */
export function cleanAppName(raw: string, max = APP_NAME_MAX): string {
  return Array.from(
    String(raw ?? "")
      .replace(/[^\p{L}\p{M}\p{N} '&.,!()+\-_:]/gu, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ).slice(0, max).join("").trim();
}

/** What may be typed into a name field: the same characters, spaces kept as typed. */
export function filterNameInput(raw: string, max = APP_NAME_MAX): string {
  return Array.from(String(raw ?? "").replace(/[^\p{L}\p{M}\p{N} '&.,!()+\-_:]/gu, "")).slice(0, max).join("");
}

/** A home-screen name from the full name: whole words up to 12 characters ("Plant Monitor" → "Plant"). */
export function shortNameFrom(name: string): string {
  const clean = cleanAppName(name);
  let out = "";
  for (const word of clean.split(" ")) {
    const next = out ? `${out} ${word}` : word;
    if (Array.from(next).length > APP_SHORT_NAME_MAX) break;
    out = next;
  }
  return out || cleanAppName(clean, APP_SHORT_NAME_MAX);
}

export function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

// ---------------------------------------------------------------------------
// Reading the sketch
// ---------------------------------------------------------------------------

interface Literal {
  /** Where the literal's text starts and ends (quotes and delimiters excluded). */
  start: number;
  end: number;
}

interface Scan {
  /** The code with comments blanked out (same length, newlines kept). */
  noComments: string;
  /** The same, with the text of string and character literals blanked too. */
  codeOnly: string;
  literals: Literal[];
}

/**
 * Comments, string literals (raw ones too) and character literals found the
 * way a compiler would, so nothing inside one is mistaken for code. Blanked
 * copies keep every position, so a place found in them is the same place in
 * the sketch.
 */
function scan(code: string): Scan {
  const noComments = code.split("");
  const codeOnly = code.split("");
  const literals: Literal[] = [];
  const blank = (arr: string[], from: number, to: number) => {
    for (let k = from; k < to; k++) if (arr[k] !== "\n" && arr[k] !== "\r") arr[k] = " ";
  };
  const ident = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c);
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const next = code[i + 1];
    if (c === "/" && next === "/") {
      let j = code.indexOf("\n", i);
      if (j < 0) j = code.length;
      blank(noComments, i, j);
      blank(codeOnly, i, j);
      i = j;
    } else if (c === "/" && next === "*") {
      let j = code.indexOf("*/", i + 2);
      j = j < 0 ? code.length : j + 2;
      blank(noComments, i, j);
      blank(codeOnly, i, j);
      i = j;
    } else if (c === "R" && next === '"' && (!ident(code[i - 1]) || /(?:^|[^A-Za-z0-9_])(?:u8|u|U|L)$/.test(code.slice(Math.max(0, i - 3), i)))) {
      // R"delim( ... )delim"
      const open = code.indexOf("(", i + 2);
      const delim = open < 0 ? "" : code.slice(i + 2, open);
      if (open < 0 || delim.length > 16 || /[\s\\)]/.test(delim)) { i++; continue; }
      const close = code.indexOf(`)${delim}"`, open + 1);
      const end = close < 0 ? code.length : close;
      literals.push({ start: open + 1, end });
      blank(codeOnly, open + 1, end);
      i = close < 0 ? code.length : close + delim.length + 2;
    } else if (c === '"') {
      let j = i + 1;
      while (j < code.length && code[j] !== '"' && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1;
      literals.push({ start: i + 1, end: Math.min(j, code.length) });
      blank(codeOnly, i + 1, Math.min(j, code.length));
      i = j + 1;
    } else if (c === "'" && !ident(code[i - 1])) {
      // A character literal; after a digit or letter, ' is a digit separator.
      let j = i + 1;
      while (j < code.length && code[j] !== "'" && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1;
      blank(codeOnly, i + 1, Math.min(j, code.length));
      i = j + 1;
    } else {
      i++;
    }
  }
  return { noComments: noComments.join(""), codeOnly: codeOnly.join(""), literals };
}

/** The headers a sketch includes, without ".h": "WiFi", "BLEDevice". Commented-out lines don't count. */
function includedHeaders(noComments: string): string[] {
  return [...noComments.matchAll(/^[ \t]*#[ \t]*include[ \t]*[<"]([^>"\r\n]+)[>"]/gm)]
    .map((m) => m[1].trim().split("/").pop()!.replace(/\.(h|hpp)$/i, ""));
}

export type ServerKind = "WebServer" | "AsyncWebServer";

export interface AppProject {
  /** The board serves a web page this can make an app of: its server. */
  board: { kind: ServerKind; variable: string } | null;
  /** Why the page the board serves can't be made an app here, when that's so. */
  boardProblem: string | null;
  /** The sketch holds a web page. */
  hasPage: boolean;
  /** Bluetooth Low Energy (the ESP32's own, or an HM-10-style module), which
   *  Chrome talks to with Web Bluetooth: not on iPhone. */
  ble: boolean;
  /** Classic Bluetooth serial (the ESP32's BluetoothSerial, or an HC-05/HC-06
   *  module), which Chrome on Android and computers talks to with Web Serial
   *  once the board is paired: not on iPhone. */
  classicBluetooth: boolean;
  /** Joins Wi-Fi. */
  wifi: boolean;
  /** A SIM card / mobile data module. */
  cellular: boolean;
  /** Talks to a service on the internet (MQTT, HTTP, Firebase...). */
  cloud: boolean;
  /** The app is already added to this sketch. */
  applied: boolean;
}

const BLE_HEADERS = ["BLEDevice", "BLEServer", "BLEUtils", "NimBLEDevice", "ArduinoBLE"];
/**
 * A Bluetooth module on a serial port says nothing in the code itself, so it
 * is known by its name (in a comment or anywhere) or by a serial port named
 * for it: "SoftwareSerial BTSerial(10, 11);" then "BTSerial.begin(9600);".
 */
const CLASSIC_MODULE = /\b(?:HC-?0?[56]|JDY-?3[013])\b/i;
const BLE_MODULE = /\b(?:HM-?1[09]|AT-?09|JDY-?(?:08|10|23))\b/i;
const BT_SERIAL_PORT = /\b(?:bt|bt_?serial|bt_?module|bluetooth\w*|hc_?0?[56]\w*)\s*\.\s*(?:begin|read|readString|readStringUntil|write|print|println|available)\s*\(/i;
const CELLULAR = /^(TinyGsm\w*|TinyGSM\w*|SIM\d{3,4}\w*|Sim\d{3,4}\w*|Adafruit_FONA|MKRGSM|GSM)$/;
const CLOUD_HEADERS = [
  "HTTPClient", "PubSubClient", "WiFiClientSecure", "ArduinoMqttClient", "MQTT", "AsyncMqttClient",
  "ThingSpeak", "UniversalTelegramBot", "ArduinoHttpClient", "WebSocketsClient", "ArduinoWebsockets",
  "Firebase_ESP_Client", "FirebaseESP32", "FirebaseClient", "BlynkSimpleEsp32", "BlynkSimpleEsp32_SSL",
  "BlynkSimpleTinyGSM", "ESP_Mail_Client", "ArduinoIoTCloud",
];

/** What a sketch does that a phone app could use. */
export function inspectProject(code: string): AppProject {
  const s = scan(code);
  const headers = includedHeaders(s.noComments);
  const has = (names: string[]) => names.some((n) => headers.includes(n));
  const html = extractHtml(code);
  const hasPage = html !== null;
  const bleModule = BLE_MODULE.test(code);
  const ble = has(BLE_HEADERS) || bleModule;
  const classicBluetooth = headers.includes("BluetoothSerial") || CLASSIC_MODULE.test(code) ||
    (!bleModule && !has(BLE_HEADERS) && BT_SERIAL_PORT.test(s.codeOnly));
  const cellular = headers.some((h) => CELLULAR.test(h));
  const cloud = has(CLOUD_HEADERS);
  const wifi = headers.includes("WiFi") || has(["WebServer", "ESPAsyncWebServer", "WiFiManager"]);
  const applied = /\bJointAgentApp\s*::\s*serve\s*\(/.test(s.codeOnly) || /<!-- Joint-Agent app (\(head\) )?-->/.test(code);

  let board: AppProject["board"] = null;
  let boardProblem: string | null = null;
  const declared = findServer(s.codeOnly);
  if (declared && hasPage) {
    board = declared;
  } else if (declared && !hasPage) {
    boardProblem = /\bserveStatic\s*\(|\b(SPIFFS|LittleFS|FFat)\b/.test(s.codeOnly)
      ? "Your page is stored in the board's file storage, not in the sketch, so the app details can't be added to it here. Ask the agent to put the page in the sketch, then build the app again."
      : null;
  } else if (hasPage) {
    if (/\bESP8266WebServer\b/.test(s.codeOnly)) {
      boardProblem = "This sketch uses the ESP8266 web server, which isn't supported here. Ask the agent to serve the page with the ESP32's WebServer, then build the app again.";
    } else if (/\b(WebServer|AsyncWebServer)\s*\*/.test(s.codeOnly)) {
      boardProblem = "This sketch creates its web server with new, so the app details can't be added automatically. Ask the agent to declare it as \"WebServer server(80);\", then build the app again.";
    } else if (/\b(WiFiServer|EthernetServer)\b/.test(s.codeOnly)) {
      boardProblem = "This sketch answers web requests itself (WiFiServer), so the app details can't be added automatically. Ask the agent to serve the page with the WebServer library, then build the app again.";
    }
  }
  return { board, boardProblem, hasPage, ble, classicBluetooth, wifi, cellular, cloud, applied };
}

function findServer(codeOnly: string): AppProject["board"] {
  const found: { kind: ServerKind; variable: string }[] = [];
  for (const m of codeOnly.matchAll(/\b(WebServer|AsyncWebServer)\b[ \t]+([A-Za-z_]\w*)[ \t]*(?:\(|\{|;|=)/g)) {
    found.push({ kind: m[1] as ServerKind, variable: m[2] });
  }
  // Two servers: the one that is started.
  return found.find((f) => startsAt(codeOnly, f.variable) >= 0) ?? found[0] ?? null;
}

function startsAt(codeOnly: string, variable: string): number {
  const m = new RegExp(`\\b${variable}\\s*\\.\\s*begin\\s*\\(`).exec(codeOnly);
  return m ? m.index : -1;
}

// ---------------------------------------------------------------------------
// Changing the sketch
// ---------------------------------------------------------------------------

const HEAD_OPEN = "<!-- Joint-Agent app -->";
/** Opens the tags instead when the page had no <head> and the app added one around them. */
const HEAD_OPEN_ADDED = "<!-- Joint-Agent app (head) -->";
const HEAD_CLOSE = "<!-- /Joint-Agent app -->";
const SERVE_NOTE = "// Lets a phone add this page to its home screen as an app (Build App (PWA)).";
const SERVE_NOTE_PATTERN = SERVE_NOTE.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");

function htmlAttr(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/'/g, "&#39;");
}

/** The tags each page's <head> gets, between markers so they can be updated and removed. */
export function appHeadTags(settings: AppSettings, open = HEAD_OPEN): string {
  const short = htmlAttr(settings.shortName);
  return open +
    "<link rel='manifest' href='/manifest.webmanifest'>" +
    `<meta name='theme-color' content='${settings.themeColor}'>` +
    "<meta name='mobile-web-app-capable' content='yes'>" +
    "<meta name='apple-mobile-web-app-capable' content='yes'>" +
    (settings.display === "fullscreen" ? "<meta name='apple-mobile-web-app-status-bar-style' content='black-translucent'>" : "") +
    `<meta name='apple-mobile-web-app-title' content='${short}'>` +
    "<link rel='apple-touch-icon' href='/apple-touch-icon.png'>" +
    "<link rel='icon' type='image/png' href='/app-icon.png'>" +
    HEAD_CLOSE;
}

/** Everything a previous Build App added, taken back out. */
export function removeApp(code: string): string {
  const eol = "\\r?\\n";
  return code
    // A <head> the app had to add because the page had none.
    .replace(/<head><!-- Joint-Agent app \(head\) -->.*?<!-- \/Joint-Agent app --><\/head>/g, "")
    .replace(/<!-- Joint-Agent app -->.*?<!-- \/Joint-Agent app -->/g, "")
    .replace(new RegExp(`^[ \\t]*#[ \\t]*include[ \\t]*[<"](?:JointAgentApp|JointAgentAppAsync)\\.h[>"][^\\r\\n]*${eol}`, "gm"), "")
    .replace(new RegExp(`^[ \\t]*${SERVE_NOTE_PATTERN}[ \\t]*${eol}(?=[ \\t]*JointAgentApp\\s*::\\s*serve\\s*\\()`, "gm"), "")
    .replace(new RegExp(`^[ \\t]*JointAgentApp\\s*::\\s*serve\\s*\\([^\\r\\n]*${eol}`, "gm"), "");
}

/** Flat, not a union: this project's TypeScript settings can't narrow one (see aiClient.ts). */
export interface ApplyResult {
  ok: boolean;
  /** The changed sketch, when ok. */
  code?: string;
  /** Why it couldn't be changed, when not. */
  reason?: string;
}

/**
 * The sketch with the app added (or updated, if it was added before): the
 * helper's #include, the serve(...) line before the server's first route,
 * and the app's tags in every page's <head>.
 */
export function applyApp(code: string, raw: AppSettings): ApplyResult {
  const settings: AppSettings = {
    name: cleanAppName(raw.name),
    shortName: cleanAppName(raw.shortName, APP_SHORT_NAME_MAX),
    themeColor: isHexColor(raw.themeColor) ? raw.themeColor.toLowerCase() : "#0b0d12",
    display: raw.display === "fullscreen" ? "fullscreen" : "standalone",
  };
  if (!settings.name) return { ok: false, reason: "Give the app a name." };
  if (!settings.shortName) settings.shortName = shortNameFrom(settings.name);

  const base = removeApp(code);
  const eol = base.includes("\r\n") ? "\r\n" : "\n";
  const project = inspectProject(base);
  if (!project.board) {
    return { ok: false, reason: project.boardProblem ?? "This sketch doesn't serve a web page from the board." };
  }
  const { kind, variable } = project.board;

  // Each change is found in the unchanged text and made from the end back,
  // so a position found earlier is never moved by a change made first.
  const edits: { at: number; text: string }[] = [];

  const headEdits = headInsertions(base, settings);
  if (!headEdits.length) return { ok: false, reason: "The page has no <head> or <html> tag to add the app's details to." };
  edits.push(...headEdits);

  const s = scan(base);
  const serveAt = serveLine(s, variable);
  if (serveAt === null) {
    return { ok: false, reason: `Couldn't find where "${variable}" gets its pages in setup(), so the app line can't be placed safely. Ask the agent to register the server's pages in setup(), then build the app again.` };
  }
  const indent = /^[ \t]*/.exec(base.slice(serveAt))![0];
  const args = [variable, settings.name, settings.shortName, settings.themeColor, settings.display]
    .map((v, n) => (n === 0 ? v : `"${v}"`)).join(", ");
  edits.push({ at: serveAt, text: `${indent}${SERVE_NOTE}${eol}${indent}JointAgentApp::serve(${args});${eol}` });

  const includeAt = includeLine(s.noComments, kind);
  if (includeAt === null) return { ok: false, reason: "Couldn't find the sketch's #include lines." };
  edits.push({ at: includeAt, text: `#include <${kind === "AsyncWebServer" ? APP_HEADER_ASYNC : APP_HEADER}>${eol}` });

  let out = base;
  for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.text + out.slice(e.at);
  return { ok: true, code: out };
}

/** Where the tags go in every page: just inside <head>, or a new <head> right after <html>. */
function headInsertions(code: string, settings: AppSettings): { at: number; text: string }[] {
  const tags = appHeadTags(settings);
  const { literals } = scan(code);
  const heads: { at: number; text: string }[] = [];
  for (const lit of literals) {
    const text = code.slice(lit.start, lit.end);
    for (const m of text.matchAll(/<head(?=[\s>])[^>]*>/gi)) heads.push({ at: lit.start + m.index! + m[0].length, text: tags });
  }
  if (heads.length) return heads;
  const htmls: { at: number; text: string }[] = [];
  for (const lit of literals) {
    const text = code.slice(lit.start, lit.end);
    for (const m of text.matchAll(/<html(?=[\s>])[^>]*>/gi)) htmls.push({ at: lit.start + m.index! + m[0].length, text: `<head>${appHeadTags(settings, HEAD_OPEN_ADDED)}</head>` });
  }
  return htmls;
}

/**
 * The start of the line where serve(...) goes: the server's first route
 * (or, with none, its begin()), when that line starts a statement of its
 * own inside a function. Not after an "if (...)" without braces, where a
 * new line would change what the "if" covers.
 */
function serveLine(s: Scan, variable: string): number | null {
  const re = new RegExp(`\\b${variable}\\s*\\.\\s*(?:on|onNotFound|onFileUpload|addHandler|serveStatic|begin)\\s*\\(`, "g");
  for (const m of s.codeOnly.matchAll(re)) {
    const lineStart = s.codeOnly.lastIndexOf("\n", m.index!) + 1;
    if (s.codeOnly.slice(lineStart, m.index!).trim() !== "") continue;
    if (braceDepth(s.codeOnly, lineStart) < 1) continue;
    const before = s.codeOnly.slice(0, lineStart).replace(/\s+$/, "");
    const last = before[before.length - 1];
    if (last !== ";" && last !== "{" && last !== "}") continue;
    return lineStart;
  }
  return null;
}

function braceDepth(codeOnly: string, upTo: number): number {
  let depth = 0;
  for (let i = 0; i < upTo; i++) {
    if (codeOnly[i] === "{") depth++;
    else if (codeOnly[i] === "}") depth--;
  }
  return depth;
}

/** The start of the line after the server's own #include, or after the sketch's first block of #includes. */
function includeLine(noComments: string, kind: ServerKind): number | null {
  const own = kind === "AsyncWebServer" ? "ESPAsyncWebServer" : "WebServer";
  const lines = [...noComments.matchAll(/^[ \t]*#[ \t]*include[ \t]*[<"]([^>"\r\n]+)[>"][^\n]*(?:\n|$)/gm)];
  if (!lines.length) return null;
  const mine = lines.find((m) => m[1].trim().replace(/\.h$/i, "") === own);
  if (mine) return mine.index! + mine[0].length;
  // Otherwise after the last #include before any code, outside any #if.
  let after: number | null = null;
  let depth = 0;
  for (const line of noComments.slice(0, firstCode(noComments)).matchAll(/^[ \t]*#[ \t]*(\w+)[^\n]*(?:\n|$)/gm)) {
    const directive = line[1];
    if (/^if/.test(directive)) depth++;
    else if (directive === "endif") depth--;
    else if (directive === "include" && depth === 0) after = line.index! + line[0].length;
  }
  return after;
}

/** Where the first line that isn't a preprocessor line or blank starts. */
function firstCode(noComments: string): number {
  const m = /^(?![ \t]*#)[ \t]*\S/m.exec(noComments);
  return m ? m.index : noComments.length;
}

/** The settings a sketch was last made an app with, to start the form from. */
export function appliedSettings(code: string): Partial<AppSettings> | null {
  const m = /\bJointAgentApp\s*::\s*serve\s*\(\s*\w+\s*,\s*"([^"\r\n]*)"\s*,\s*"([^"\r\n]*)"\s*,\s*"(#[0-9a-fA-F]{6})"\s*(?:,\s*"(standalone|fullscreen)"\s*)?\)/.exec(code);
  if (!m) return null;
  return { name: m[1], shortName: m[2], themeColor: m[3].toLowerCase(), display: (m[4] as AppSettings["display"]) || "standalone" };
}
