/**
 * Paystack's checkout script, loaded without holding up the page: it used to
 * sit in index.html's <head>, where the browser had to fetch it from
 * Paystack before showing anything. Now it loads once the page is up
 * (warmPaystack, from main.tsx), and a payment waits for it (loadPaystack)
 * in case it isn't there yet.
 */
const PAYSTACK_SRC = "https://js.paystack.co/v1/inline.js";

let loading: Promise<boolean> | null = null;

/** Resolves true once window.PaystackPop is there; false if the script couldn't load (a later call tries again). */
export function loadPaystack(): Promise<boolean> {
  if (window.PaystackPop) return Promise.resolve(true);
  if (!loading) {
    loading = new Promise<boolean>((resolve) => {
      const script = document.createElement("script");
      script.src = PAYSTACK_SRC;
      script.async = true;
      script.onload = () => {
        if (!window.PaystackPop) loading = null;
        resolve(!!window.PaystackPop);
      };
      script.onerror = () => {
        script.remove();
        loading = null;
        resolve(false);
      };
      document.head.appendChild(script);
    });
  }
  return loading;
}

/** Fetches the script in the background once the page has loaded, so a payment opens straight away. */
export function warmPaystack(): void {
  const start = () => setTimeout(() => { void loadPaystack(); }, 2000);
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
}
