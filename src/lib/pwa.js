// Install-as-app (PWA) helpers: service worker registration + the "Install" prompt.

let deferred = null;
const subs = new Set();
const notify = () => subs.forEach((fn) => { try { fn(); } catch { /* ignore */ } });

export function registerPwa() {
  if (typeof window === "undefined") return;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; notify(); });
  window.addEventListener("appinstalled", () => { deferred = null; notify(); });
  if ("serviceWorker" in navigator && import.meta.env?.PROD) {
    window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch(() => {}); });
  }
}

export const isStandalone = () =>
  typeof window !== "undefined" && (window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true);
export const isIos = () => typeof navigator !== "undefined" && /iphone|ipad|ipod/i.test(navigator.userAgent || "");
export const canPromptInstall = () => !!deferred;
export const subscribeInstall = (fn) => { subs.add(fn); return () => subs.delete(fn); };
export async function promptInstall() {
  if (!deferred) return "unavailable";
  const p = deferred;
  deferred = null;
  notify();
  try { p.prompt(); const r = await p.userChoice; return r?.outcome || "dismissed"; } catch { return "dismissed"; }
}
