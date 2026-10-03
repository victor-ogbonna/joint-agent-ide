/**
 * Installing Joint-Agent as an app (Chrome's "Install app"), and, on an
 * iPhone or iPad — which has no install prompt at all, by Apple's choice —
 * the Safari steps that do the same thing.
 *
 * Opened from its home-screen icon, the app runs fullscreen by itself
 * (display "fullscreen" in public/manifest.webmanifest). Chrome shows no "To
 * exit full screen, drag from the top" message then, since the page never
 * asked for fullscreen, and the keyboard still pushes the page up: an
 * installed app keeps the keyboard's insets, where a page that requested
 * fullscreen has them zeroed (Chrome's EdgeToEdgeControllerImpl), which is
 * what hid the chat box under the keys.
 *
 * Chrome announces that the site can be installed with beforeinstallprompt,
 * often before the workspace has mounted (on the home page, or during the
 * launch screen). Caught here at startup and kept until the profile menu's
 * "Install app" uses it — and left to Chrome as well, so its own install
 * affordance (the omnibox icon on desktop; Android's own banner, when
 * Chrome judges the moment right) shows too. Either route ends the same way.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

export function startInstallSupport() {
  window.addEventListener("beforeinstallprompt", (e) => {
    // Not prevented: Chrome's own install affordance shows as well as the
    // profile menu's. (Chromium shows at most a small, dismissible one —
    // never a full-screen takeover — so there's nothing to protect the
    // workspace from here.)
    deferredPrompt = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    notify();
  });

  // Chrome offers installation only to a site with a service worker.
  // Production only: under the dev server there is nothing to install.
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => { /* the site works the same without it */ });
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }
}

/**
 * iPhone or iPad: Safari (and every other iOS browser, which must use
 * Safari's engine) never fires beforeinstallprompt — Apple's own choice, not
 * a bug here — so the only way to install is Share, then "Add to Home
 * Screen", which the profile menu walks the person through instead.
 *
 * iPadOS reports itself as a Mac, so the touch-point check is what tells an
 * iPad apart from a MacBook running Safari (which has no install step at
 * all: Safari on macOS does not support installing web apps either).
 */
function isIOSDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/** Already running from the home screen: nothing to offer. */
function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((navigator as any).standalone) || window.matchMedia?.("(display-mode: standalone)").matches
    || window.matchMedia?.("(display-mode: fullscreen)").matches;
}

/** Chrome's own install prompt is ready to use. */
export function canInstallApp() {
  return deferredPrompt !== null;
}

/**
 * Whether the profile menu's "Install app" has anything to offer: Chrome's
 * prompt, or — on an iPhone or iPad not already installed — the Safari
 * steps. Null everywhere else (a desktop browser without the Chrome prompt,
 * or an app already installed).
 */
export function installKind(): "prompt" | "ios" | null {
  if (canInstallApp()) return "prompt";
  if (isIOSDevice() && !isStandalone()) return "ios";
  return null;
}

export function onInstallAvailabilityChange(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Opens Chrome's install dialog. Chrome allows each event to be used once. */
export async function installApp() {
  const event = deferredPrompt;
  if (!event) return;
  deferredPrompt = null;
  notify();
  try {
    await event.prompt();
    await event.userChoice;
  } catch { /* dismissed or refused: nothing to undo */ }
}

/**
 * True when running as the installed app, opened from its icon: fullscreen
 * by the manifest, not by a fullscreen request. Chrome also reports
 * display-mode fullscreen while a page in a browser tab holds fullscreen,
 * hence the second check.
 */
export function isInstalledFullscreenApp() {
  const doc: any = document;
  return Boolean(
    window.matchMedia?.("(display-mode: fullscreen)").matches
      && !(doc.fullscreenElement || doc.webkitFullscreenElement),
  );
}
