/**
 * Hiding secrets in a shared sketch.
 *
 * A shared project shows its code to anyone with the link, and sketches are
 * full of WiFi names and passwords, API keys and tokens. Every string in the
 * code that looks like one of those is replaced with HIDDEN before the code
 * leaves the server. It errs on the side of hiding: a string hidden that
 * didn't need to be costs nothing, one shown that should have been hidden
 * can't be taken back. Comments are left as they are.
 *
 * A string is hidden when:
 *   - it is #defined, assigned, compared or initialised to a name that reads
 *     like a secret (password, key, token, ssid, user, auth, ...);
 *   - it is passed to a function named like a secret, or to a login-style
 *     call (begin, softAP, connect, ...) together with another string, as in
 *     WiFi.begin("home", "hunter2");
 *   - it looks like a key or token itself (a long run of letters and digits),
 *     or holds a certificate or private key;
 * and inside any string, a URL's password and secret-looking query values
 * (?api_key=..., &token=...) are hidden.
 */

export const HIDDEN = "********";

interface Literal {
  /** Where the string's text starts and ends (inside the quotes). */
  from: number;
  to: number;
}

/** Splits apiKey, WIFI_PASSWORD, mqttUser into their words. */
function wordsOf(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

const SECRET_WORDS = new Set([
  "pass", "password", "passwd", "pwd", "pw", "psk", "passphrase", "pin",
  "secret", "secrets", "token", "tokens", "key", "keys", "apikey", "auth", "authorization",
  "ssid", "api", "cred", "creds", "credential", "credentials", "private", "bearer",
  "cert", "certificate", "user", "username", "login", "email", "mail",
]);

function isSecretName(name: string): boolean {
  return wordsOf(name).some((w) => SECRET_WORDS.has(w) || w.startsWith("pass") || w.startsWith("secret") || w.startsWith("token") || (w.length > 3 && w.endsWith("key")));
}

/** Calls that take credentials, when given two or more strings. */
const LOGIN_CALLS = new Set(["begin", "softap", "addap", "connect", "setcredentials", "setauth", "login", "authenticate", "config"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeToken(text: string): boolean {
  if (text.length < 20 || /\s/.test(text) || text.startsWith("/") || text.includes("://") || UUID.test(text)) return false;
  if (!/^[A-Za-z0-9_\-+/=.:]+$/.test(text)) return false;
  return /[A-Za-z]/.test(text) && /[0-9]/.test(text);
}

/**
 * Finds every string literal, and a copy of the code with comments and the
 * insides of strings blanked out, so brackets and '=' can be read safely.
 */
function scan(code: string): { literals: Literal[]; masked: string } {
  const literals: Literal[] = [];
  const out = code.split("");
  const blank = (a: number, b: number) => { for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " "; };
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const next = code[i + 1];
    if (c === "/" && next === "/") {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? code.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      const stop = end === -1 ? code.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === "'") {
      // A character literal: skipped whole, escapes included.
      let j = i + 1;
      while (j < code.length && code[j] !== "'" && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1;
      blank(i + 1, Math.min(j, code.length));
      i = j + 1;
    } else if (c === '"') {
      // A raw string, R"delim( ... )delim", or an ordinary one.
      const raw = /R$/.test(code.slice(Math.max(0, i - 3), i)) && /^[^\s()\\"]{0,16}\(/.test(code.slice(i + 1, i + 18));
      if (raw) {
        const open = code.indexOf("(", i + 1);
        const delim = code.slice(i + 1, open);
        const close = code.indexOf(`)${delim}"`, open + 1);
        const to = close === -1 ? code.length : close;
        literals.push({ from: open + 1, to });
        blank(i + 1, to);
        i = close === -1 ? code.length : close + delim.length + 2;
      } else {
        let j = i + 1;
        while (j < code.length && code[j] !== '"' && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1;
        const to = Math.min(j, code.length);
        literals.push({ from: i + 1, to });
        blank(i + 1, to);
        i = to + 1;
      }
    } else {
      i += 1;
    }
  }
  return { literals, masked: out.join("") };
}

const prevChar = (text: string, k: number) => { for (let m = k - 1; m >= 0; m--) if (!/\s/.test(text[m])) return text[m]; return ""; };
const nextChar = (text: string, k: number) => { for (let m = k + 1; m < text.length; m++) if (!/\s/.test(text[m])) return text[m]; return ""; };

/**
 * Where the statement holding position `at` begins: after a ";", a block's
 * "{" or "}", or a preprocessor line. The braces of an initialiser list,
 * = {{"a", "b"}, {"c", "d"}}, don't count.
 */
function statementStart(masked: string, at: number): number {
  for (let k = at - 1; k >= 0; k--) {
    const ch = masked[k];
    if (ch === ";") return k + 1;
    if (ch === "{") {
      if (["=", ",", "{", "("].includes(prevChar(masked, k))) continue;
      return k + 1;
    }
    if (ch === "}") {
      if ([",", "}"].includes(nextChar(masked, k))) continue;
      return k + 1;
    }
    if (ch === "\n") {
      const lineStart = masked.lastIndexOf("\n", k - 1) + 1;
      if (/^\s*#/.test(masked.slice(lineStart, k))) return k + 1;
    }
  }
  return 0;
}

/** The unclosed "(" around position `at` in its statement, if any. */
function enclosingParen(masked: string, from: number, at: number): number | null {
  let depth = 0;
  for (let k = at - 1; k >= from; k--) {
    const ch = masked[k];
    if (ch === ")") depth++;
    else if (ch === "(") {
      if (depth === 0) return k;
      depth--;
    }
  }
  return null;
}

const identifiers = (text: string) => text.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];

/** Secret-looking parts of a string: a URL's password, query values named like secrets. */
function hideInside(text: string): string {
  return text
    .replace(/(:\/\/)([^\/\s:@]+):([^\/\s@]+)@/g, `$1$2:${HIDDEN}@`)
    .replace(/([?&;](?:[A-Za-z0-9_\-]*(?:key|token|secret|pass|password|pwd|auth|sig|signature)[A-Za-z0-9_\-]*|appid|app_id)=)([^&#\s"]+)/gi, `$1${HIDDEN}`);
}

export function hideSecrets(code: string): string {
  if (typeof code !== "string" || !code) return "";
  const { literals, masked } = scan(code);
  const hide = new Set<Literal>();

  // Strings passed together to the same call, for login-style calls.
  const byCall = new Map<number, Literal[]>();

  for (const lit of literals) {
    const quote = lit.from - 1;
    const text = code.slice(lit.from, lit.to);
    if (looksLikeToken(text) || text.includes("-----BEGIN")) { hide.add(lit); continue; }

    const start = statementStart(masked, quote);
    const before = masked.slice(start, quote);

    // #define WIFI_PASSWORD "..."
    const define = /^\s*#\s*define\s+([A-Za-z_]\w*)\b/.exec(before);
    if (define) {
      if (isSecretName(define[1])) hide.add(lit);
      continue;
    }

    // const char* password = "...", creds[] = {{"a","b"}}, if (pin == "1234")
    const eq = before.lastIndexOf("=");
    if (eq !== -1 && identifiers(before.slice(0, eq)).some(isSecretName)) { hide.add(lit); continue; }

    // String token("..."), WiFi.begin("home", "pass")
    const paren = enclosingParen(masked, start, quote);
    if (paren !== null) {
      const callee = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(masked.slice(Math.max(start, paren - 64), paren));
      if (callee && isSecretName(callee[1])) { hide.add(lit); continue; }
      if (callee && LOGIN_CALLS.has(callee[1].toLowerCase())) {
        const group = byCall.get(paren) || [];
        group.push(lit);
        byCall.set(paren, group);
      }
    }
  }
  for (const group of byCall.values()) if (group.length >= 2) group.forEach((l) => hide.add(l));

  let out = "";
  let last = 0;
  for (const lit of literals) {
    out += code.slice(last, lit.from);
    const text = code.slice(lit.from, lit.to);
    out += hide.has(lit) ? HIDDEN : hideInside(text);
    last = lit.to;
  }
  return out + code.slice(last);
}
