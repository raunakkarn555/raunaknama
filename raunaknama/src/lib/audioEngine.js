// Dual-<audio> playback engine.
//
// WHY: mobile browsers (Android Chrome especially) freeze background JS / network once the
// screen locks, and refuse to start a brand-new audio source from async code. The only thing
// that reliably keeps working is calling play() on an element that ALREADY holds a buffered
// stream, synchronously inside the "ended" event of the current one.
//
//   primary  : the element the listener is hearing right now
//   standby  : holds the NEXT track's stream, loaded + buffered ahead of time
//   fade     : persistent helper element for the crossfade tail (foreground only)
//   keep     : tiny silent WAV loop, played only during a track transition that could not be
//              served from standby, so the OS never sees the page go silent (which is when it
//              suspends the tab / dismisses the lock-screen card)
//
// All four elements are created ONCE, live in <body>, and are never destroyed or recreated.

const EVENTS = [
  "play", "playing", "pause", "ended", "timeupdate", "loadedmetadata",
  "durationchange", "error", "seeked", "ratechange",
];

// ---- silent WAV (generated once, no giant literal) ----------------------------------------
const makeSilentWav = (seconds = 1, rate = 8000) => {
  const n = rate * seconds; // 8-bit mono PCM, 128 = silence
  const buf = new Uint8Array(44 + n);
  const dv = new DataView(buf.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
  str(0, "RIFF"); dv.setUint32(4, 36 + n, true); str(8, "WAVE"); str(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate, true);
  dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
  str(36, "data"); dv.setUint32(40, n, true); buf.fill(128, 44);
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x2000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x2000));
  return `data:audio/wav;base64,${btoa(bin)}`;
};

let els = null; // { list: [a, b], fade, keep }
let activeIdx = 0;
let standby = { id: null, url: null };
let keepTimer = null;
let silentUri = null;
let unlockInstalled = false;
const listeners = new Set();

const KEEP_MAX_MS = 45000; // safety: never leave the silent loop running forever

function build() {
  if (els || typeof document === "undefined") return;
  const host = document.createElement("div");
  host.id = "rn-audio-engine";
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:fixed;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none;";
  const make = () => {
    const a = document.createElement("audio");
    a.preload = "auto";
    a.setAttribute("playsinline", "");
    a.setAttribute("webkit-playsinline", "");
    host.appendChild(a);
    return a;
  };
  const list = [make(), make()];
  const fade = make();
  const keep = make();
  keep.loop = true;
  silentUri = makeSilentWav();
  keep.src = silentUri;
  document.body.appendChild(host);

  list.forEach((el) => {
    EVENTS.forEach((type) => {
      el.addEventListener(type, (e) => {
        const isActive = e.target === els.list[activeIdx];
        listeners.forEach((fn) => {
          try { fn(type, e, isActive); } catch (err) { console.warn("audioEngine listener error:", err); }
        });
      });
    });
  });
  els = { list, fade, keep };
}

const ready = () => { build(); return !!els; };

export const audioEngine = {
  init: ready,
  getActive() { ready(); return els?.list[activeIdx] || null; },
  getStandby() { ready(); return els?.list[1 - activeIdx] || null; },
  getFade() { ready(); return els?.fade || null; },

  /** fn(type, event, isActive). Returns unsubscribe. */
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  // ---- standby (next track, pre-buffered) ----
  /** Put `url` into the standby element and start buffering it right now. */
  preload(id, url) {
    if (!id || !url || !ready()) return false;
    const st = this.getStandby();
    if (standby.id === id && standby.url === url) return true;
    try {
      st.pause();
      st.loop = false;
      st.src = url;
      st.load();
      standby = { id, url };
      return true;
    } catch {
      standby = { id: null, url: null };
      return false;
    }
  },
  standbyFor(id) { return !!id && standby.id === id; },
  standbyId() { return standby.id; },
  clearStandby() {
    if (!ready()) return;
    const st = this.getStandby();
    standby = { id: null, url: null };
    try { st.pause(); st.removeAttribute("src"); st.load(); } catch { /* ignore */ }
  },

  /**
   * Instant swap: play() the pre-loaded standby element synchronously (so it works inside an
   * "ended" event on a locked phone), make it the active element, retire the old one.
   * Returns { id, el, promise } or null when nothing is preloaded.
   */
  activateStandby({ volume = 1, loop = false } = {}) {
    if (!ready() || !standby.id) return null;
    const next = this.getStandby();
    const prev = this.getActive();
    if (!next.getAttribute("src")) { standby = { id: null, url: null }; return null; }
    const id = standby.id;
    let promise;
    try {
      next.muted = false;
      next.volume = volume;
      next.loop = !!loop;
      promise = next.play(); // <- the call that must happen synchronously
    } catch (err) {
      return null;
    }
    activeIdx = 1 - activeIdx; // from here on `next` is the active element
    standby = { id: null, url: null };
    try {
      prev.pause();
      prev.loop = false;
      prev.removeAttribute("src");
      prev.load();
    } catch { /* ignore */ }
    return { id, el: next, promise };
  },

  // ---- silent keep-alive loop ----
  startKeepAlive() {
    if (!ready()) return;
    const k = els.keep;
    try {
      if (k.src !== silentUri) k.src = silentUri;
      k.loop = true;
      const p = k.play();
      if (p && p.catch) p.catch(() => {});
    } catch { /* ignore */ }
    clearTimeout(keepTimer);
    keepTimer = setTimeout(() => this.stopKeepAlive(), KEEP_MAX_MS);
  },
  stopKeepAlive() {
    clearTimeout(keepTimer);
    keepTimer = null;
    if (!els) return;
    try { els.keep.pause(); els.keep.currentTime = 0; } catch { /* ignore */ }
  },

  /**
   * iOS / some Android WebViews only let an element start later from async code if it was
   * played once inside a user gesture. Prime standby + keep-alive on the first touch/click.
   */
  installUnlock() {
    if (unlockInstalled || typeof document === "undefined" || !ready()) return;
    unlockInstalled = true;
    const prime = (el, isStandby) => {
      if (el.getAttribute("src")) return; // already in real use
      el.src = silentUri;
      el.muted = true;
      const p = el.play();
      const clean = () => {
        if (el.src === silentUri && (!isStandby || !standby.id)) {
          el.pause();
          if (isStandby) { el.removeAttribute("src"); el.load(); }
        }
        el.muted = false;
      };
      if (p && p.then) p.then(clean, () => { el.muted = false; });
      else clean();
    };
    const run = () => {
      ["pointerdown", "touchend", "click", "keydown"].forEach((t) => document.removeEventListener(t, run, true));
      try {
        prime(this.getStandby(), true);
        const k = els.keep;
        k.muted = true;
        const p = k.play();
        const done = () => { k.pause(); k.currentTime = 0; k.muted = false; };
        if (p && p.then) p.then(done, () => { k.muted = false; });
      } catch { /* ignore */ }
    };
    ["pointerdown", "touchend", "click", "keydown"].forEach((t) => document.addEventListener(t, run, true));
  },
};

export default audioEngine;
