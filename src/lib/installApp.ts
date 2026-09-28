/**
 * Installing Joint-Agent as an app (Chrome's "Install app").
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
 * launch screen). So the event is caught here at startup and kept until the
 * profile menu's "Install app" uses it.
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
    // Keeps Chrome's own install bar from sliding up over the workspace; the
    // profile menu offers the same install instead.
    e.preventDefault();
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

export function canInstallApp() {
  return deferredPrompt !== null;
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
    window.matchMedia?.("(display-mode: fullscreen)").matches &&
      !(doc.fullscreenElement || doc.webkitFullscreenElement),
  );
}
