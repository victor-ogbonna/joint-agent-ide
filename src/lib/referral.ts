/**
 * A creator's link (jointagentide.com/?ref=TOBI20) leaves its code here until
 * the visitor has signed in, when the app puts it on their account
 * (server/creators.ts). Kept 30 days, so signing up later still counts. The
 * code is taken off the address straight away, so it isn't shared onwards
 * by accident.
 */
const KEY = "jointagent_ref";
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,23}$/;

export function captureRefFromUrl(): void {
  try {
    const url = new URL(window.location.href);
    const raw = url.searchParams.get("ref");
    if (raw === null) return;
    const code = raw.trim();
    if (CODE.test(code)) localStorage.setItem(KEY, JSON.stringify({ code: code.toUpperCase(), at: Date.now() }));
    url.searchParams.delete("ref");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  } catch {
    /* storage or history unavailable: the code can still be typed on the Plans page */
  }
}

export function storedRef(): string | null {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!saved || typeof saved.code !== "string" || !CODE.test(saved.code)) return null;
    if (typeof saved.at !== "number" || Date.now() - saved.at > KEEP_MS) {
      localStorage.removeItem(KEY);
      return null;
    }
    return saved.code;
  } catch {
    return null;
  }
}

export function clearStoredRef(): void {
  try { localStorage.removeItem(KEY); } catch { /* nothing stored */ }
}
