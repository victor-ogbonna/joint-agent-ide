/**
 * The environment a build runs in: what the compiler needs, and nothing that
 * is secret.
 *
 * Builds used to inherit the server's whole environment, which holds every key
 * this product has (the AI providers, Paystack, Firebase, the admin password).
 * A library can carry build steps of its own, so a build is the one place
 * where code we did not write runs on this server, and it has no use for any
 * of them. Only the names below pass through: the system basics, the network
 * proxy settings, and the compiler's own settings, minus its account token.
 */
const KEEP = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM",
  "LANG", "LANGUAGE", "TZ",
  "TMPDIR", "TEMP", "TMP",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
  "PYTHONIOENCODING", "PYTHONUTF8",
  // Windows, where the compiler cannot start without them.
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
]);

/** The compiler's account token is a credential like any other. */
const DROP = new Set(["PLATFORMIO_AUTH_TOKEN"]);
const TELEMETRY = "PLATFORMIO_SETTING_ENABLE_TELEMETRY";

export function buildEnv(coreDir?: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    // Case-blind: Windows spells it "Path", and proxies are often lower case.
    const key = name.toUpperCase();
    if (DROP.has(key)) continue;
    if (KEEP.has(key) || key.startsWith("LC_") || key.startsWith("PLATFORMIO_")) env[name] = value;
  }
  if (coreDir) env.PLATFORMIO_CORE_DIR = coreDir;
  // The compiler reports each run to its makers' server unless told not to.
  // Off, unless the server's own settings say otherwise.
  if (!Object.keys(env).some((name) => name.toUpperCase() === TELEMETRY)) env[TELEMETRY] = "no";
  return env;
}
