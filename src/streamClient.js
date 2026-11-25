// Shared stream resolver for the player AND the Recommended cards.
//
// Fast path  : /api/stream?token=ID&json=1  (direct innertube lookup, ~1s)
// Fallback   : /api/stream?id=ID            (yt-dlp, slow but most tolerant)
// A forced refresh (after a playback error) skips straight to the fallback.
//
// Results are cached for the lifetime of the page and in-flight requests are
// shared, so hovering a card (warmStream) and then clicking it costs one call.

const API_BASE = import.meta.env?.VITE_API_BASE_URL || "";
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours (googlevideo urls stay valid ~6 h)
// Covers a cold start + tiered clients + the server-side yt-dlp last resort
// (the server now runs that itself, so the browser no longer repeats it).
const FAST_TIMEOUT_MS = 28000;
// yt-dlp is slow (10-14s) and CPU heavy, so it is a LAST RESORT: it only starts
// once the fast resolver has actually failed — never in parallel with it.
const HEDGE_AFTER_MS = null;

// --- Playback-resolution gate ------------------------------------------------
// While the user's clicked song is still resolving (until the <audio> element
// fires `playing`), every BACKGROUND request (next-track prefetch, hover warm,
// playlist metadata) waits here instead of competing with it for the network
// and the local function server.
let resolving = 0;
let idleWaiters = [];
const releaseWaiters = () => {
  const w = idleWaiters;
  idleWaiters = [];
  w.forEach((fn) => fn());
};
/** Call when a user-initiated track starts resolving. */
export function beginPlaybackResolve() { resolving += 1; }
/** Call on `playing`, or when the resolve failed / was cancelled. */
export function endPlaybackResolve() {
  resolving = Math.max(0, resolving - 1);
  if (resolving === 0) releaseWaiters();
}
/** Force-clear (e.g. track switched before the old one ever played). */
export function resetPlaybackResolve() { resolving = 0; releaseWaiters(); }
export const isPlaybackResolving = () => resolving > 0;
/** Resolves immediately if idle, else once playback has started. Safety cap so a stuck track can never block background work forever. */
export function whenPlaybackIdle(maxWaitMs = 30000) {
  if (resolving === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, maxWaitMs);
    idleWaiters.push(() => { clearTimeout(t); resolve(); });
  });
}

// --- "Limited" mode ---------------------------------------------------------
// When the server can only get a stream that YouTube cuts after ~850 KB, every further
// server lookup is wasted time. The player then switches to the YouTube player for a while
// and background lookups (prefetch / hover warm) are skipped.
let limitedUntil = 0;
export const isLimitedMode = () => Date.now() < limitedUntil;
export const setLimitedMode = (ms = 15 * 60 * 1000) => { limitedUntil = Date.now() + ms; };
export const clearLimitedMode = () => { limitedUntil = 0; };

const cache = new Map();    // id -> { data, expires }
const failedClients = new Map(); // id -> Set of client names whose URL failed in the browser
const inflight = new Map(); // key -> Promise

// `fresh` = bypass server cache; `exclude` = client(s) whose URL just failed.
async function fastResolve(id, { fresh = false, exclude = [] } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FAST_TIMEOUT_MS);
  try {
    // A forced refresh also asks the backend for the Piped-proxied stream
    // first (`fallback=true`) — it is not tied to the server's IP.
    const extra = (fresh ? "&fresh=1&fallback=true" : "") + (exclude.length ? `&exclude=${encodeURIComponent(exclude.join(","))}` : "");
    const res = await fetch(`${API_BASE}/api/stream?token=${encodeURIComponent(id)}&json=1${extra}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`fast resolve failed (${res.status})`);
    const data = await res.json();
    if (!data?.url) throw new Error("fast resolve returned no url");
    if (data.limited) setLimitedMode(); else clearLimitedMode();
    return data;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function slowResolve(id, retry) {
  const res = await fetch(`${API_BASE}/api/stream?id=${encodeURIComponent(id)}${retry ? "&retry=1" : ""}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Stream resolve failed (${res.status})`);
    err.details = body.details;
    throw err;
  }
  const data = await res.json();
  if (!data?.url) throw new Error("No stream URL returned");
  return data;
}

// Runs `fast`; if it fails OR is still pending after HEDGE_AFTER_MS, also runs
// `slow` in parallel. First success wins; rejects only if both fail.
function hedged(fast, slow) {
  return new Promise((resolve, reject) => {
    let slowP = null;
    let fastErr = null;
    let slowErr = null;
    let done = false;
    const ok = (v) => { if (!done) { done = true; if (timer) clearTimeout(timer); resolve(v); } };
    const startSlow = () => {
      if (slowP) return;
      slowP = slow().then(ok, (e) => {
        slowErr = e;
        if (fastErr && !done) { done = true; reject(slowErr); }
      });
    };
    const timer = HEDGE_AFTER_MS == null ? null : setTimeout(startSlow, HEDGE_AFTER_MS);
    fast().then(ok, (e) => {
      fastErr = e;
      startSlow();
      if (slowErr && !done) { done = true; if (timer) clearTimeout(timer); reject(slowErr); }
    });
  });
}

export function fetchStream(id, { forceRefresh = false, background = false, ytdlp = false } = {}) {
  if (!id) return Promise.reject(new Error("Missing track id"));
  // Background (prefetch / hover) work never races a user-clicked song: a
  // cache hit is still instant, a miss waits until playback has started.
  if (background && !forceRefresh) {
    const hit = cache.get(id);
    if (hit && hit.expires > Date.now()) return Promise.resolve(hit.data);
    if (isLimitedMode()) {
      return Promise.reject(Object.assign(new Error("skipped (limited mode)"), { skipped: true }));
    }
    if (resolving > 0) {
      return whenPlaybackIdle().then(() => fetchStream(id, { background: false }));
    }
  }
  // Remember which extraction client produced the URL that just failed so the
  // retry asks a different one (and never gets the same broken URL back).
  let exclude = [];
  if (forceRefresh) {
    const bad = failedClients.get(id) || new Set();
    const c = cache.get(id)?.data?.client;
    if (c) bad.add(c);
    failedClients.set(id, bad);
    exclude = [...bad];
  }
  if (forceRefresh) cache.delete(id);
  else {
    const hit = cache.get(id);
    if (hit && hit.expires > Date.now()) return Promise.resolve(hit.data);
  }
  const key = ytdlp ? `${id}#ytdlp` : forceRefresh ? `${id}#retry` : id;
  if (inflight.has(key)) return inflight.get(key);

  // `ytdlp`: skip the fast resolver entirely (its direct + proxy urls already
  // failed in the browser) and go straight to yt-dlp with the server's cookies.
  const p = (ytdlp ? slowResolve(id, true) : forceRefresh
    // Retry: a different fast client, with yt-dlp (slow, most tolerant) started
    // in parallel if the fast one is slow or fails — no more waiting in series.
    ? fastResolve(id, { fresh: true, exclude })
    : fastResolve(id))
    .then((data) => {
      cache.set(id, { data, expires: Date.now() + CACHE_TTL_MS });
      return data;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Fire-and-forget pre-resolve (hover / touch / next-in-queue). */
export function warmStream(id) {
  if (id) fetchStream(id, { background: true }).catch(() => {});
}

/** Synchronous cache lookup (no network). Lets the player swap to the next
 *  track inside the audio "ended" event itself — before a locked / backgrounded
 *  tab gets a chance to be throttled or frozen. Returns null on a miss. */
export function peekStream(id) {
  const hit = id ? cache.get(id) : null;
  return hit && hit.expires > Date.now() ? hit.data : null;
}
