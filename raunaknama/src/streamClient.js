// Shared stream resolver for the player AND the Recommended cards.
//
// Fast path  : /api/stream?token=ID&json=1  (direct innertube lookup, ~1s)
// Fallback   : /api/stream?id=ID            (yt-dlp, slow but most tolerant)
// A forced refresh (after a playback error) skips straight to the fallback.
//
// Results are cached for the lifetime of the page and in-flight requests are
// shared, so hovering a card (warmStream) and then clicking it costs one call.

const API_BASE = import.meta.env?.VITE_API_BASE_URL || "";
const CACHE_TTL_MS = 100 * 60 * 1000;
const FAST_TIMEOUT_MS = 9000; // backend runs tiered clients + Piped, worst case ~7s
// If the fast lookup hasn't answered after this long, start the slow yt-dlp
// lookup in parallel instead of waiting for the fast one to fail first.
const HEDGE_AFTER_MS = 4500;

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
    return data;
  } finally {
    clearTimeout(timer);
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
    const ok = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const startSlow = () => {
      if (slowP) return;
      slowP = slow().then(ok, (e) => {
        slowErr = e;
        if (fastErr && !done) { done = true; reject(slowErr); }
      });
    };
    const timer = setTimeout(startSlow, HEDGE_AFTER_MS);
    fast().then(ok, (e) => {
      fastErr = e;
      startSlow();
      if (slowErr && !done) { done = true; clearTimeout(timer); reject(slowErr); }
    });
  });
}

export function fetchStream(id, { forceRefresh = false } = {}) {
  if (!id) return Promise.reject(new Error("Missing track id"));
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
  const key = forceRefresh ? `${id}#retry` : id;
  if (inflight.has(key)) return inflight.get(key);

  const p = (forceRefresh
    // Retry: a different fast client, with yt-dlp (slow, most tolerant) started
    // in parallel if the fast one is slow or fails — no more waiting in series.
    ? hedged(() => fastResolve(id, { fresh: true, exclude }), () => slowResolve(id, true))
    : hedged(() => fastResolve(id), () => slowResolve(id, false)))
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
  if (id) fetchStream(id).catch(() => {});
}

/** Synchronous cache lookup (no network). Lets the player swap to the next
 *  track inside the audio "ended" event itself — before a locked / backgrounded
 *  tab gets a chance to be throttled or frozen. Returns null on a miss. */
export function peekStream(id) {
  const hit = id ? cache.get(id) : null;
  return hit && hit.expires > Date.now() ? hit.data : null;
}
