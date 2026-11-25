// Temporary on-device cache for songs that were just played (so "Previous" / replay is instant).
//
// - Audio is stored in the browser's Cache Storage (disk), NOT in memory.
// - Entries are auto-deleted: older than TTL_MS, or beyond MAX_ENTRIES (oldest first),
//   so the device space is freed again a little while after listening.
// - Everything is best-effort: any failure (no Cache API, offline, quota, CORS) is ignored
//   and playback simply falls back to the normal streaming path.

const CACHE_NAME = "rn-track-cache-v1";
const KEY_PREFIX = "/__rn_track_cache__/";
const TTL_MS = 20 * 60 * 1000;      // a played song stays cached for 20 minutes
const MAX_ENTRIES = 3;               // ...and at most the last 3 songs
const MAX_BYTES = 30 * 1024 * 1024;  // never cache anything bigger than 30 MB
const SWEEP_EVERY_MS = 60 * 1000;

const supported = () => typeof caches !== "undefined" && typeof URL !== "undefined";
const keyFor = (id) => `${KEY_PREFIX}${encodeURIComponent(id)}`;

const objectUrls = new Map(); // id -> blob: url currently handed to <audio>
const saving = new Set();     // ids being downloaded right now
let sweepTimer = null;

const inUse = (url) => {
  try {
    return Array.from(document.querySelectorAll("#rn-audio-engine audio")).some((a) => a.src === url);
  } catch { return false; }
};

async function open() {
  return supported() ? caches.open(CACHE_NAME) : null;
}

export async function sweep() {
  try {
    const cache = await open();
    if (!cache) return;
    const keys = await cache.keys();
    const rows = [];
    for (const req of keys) {
      const res = await cache.match(req);
      const at = Number(res?.headers.get("x-cached-at")) || 0;
      rows.push({ req, at });
    }
    rows.sort((a, b) => b.at - a.at); // newest first
    const now = Date.now();
    for (let i = 0; i < rows.length; i++) {
      const { req, at } = rows[i];
      if (i < MAX_ENTRIES && now - at < TTL_MS) continue;
      const id = decodeURIComponent(new URL(req.url).pathname.replace(KEY_PREFIX, ""));
      const url = objectUrls.get(id);
      if (url && inUse(url)) continue; // never pull the file out from under a playing element
      await cache.delete(req);
      if (url) { URL.revokeObjectURL(url); objectUrls.delete(id); }
    }
    if (!rows.length) stopSweeper();
  } catch { /* ignore */ }
}

function startSweeper() {
  if (sweepTimer || typeof setInterval === "undefined") return;
  sweepTimer = setInterval(sweep, SWEEP_EVERY_MS);
}
function stopSweeper() {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

export const trackCache = {
  /** Remove expired leftovers from earlier sessions. Call once on app start. */
  init() { if (supported()) { sweep(); startSweeper(); } },

  /** Download a song in the background and keep it temporarily. */
  async save(id, url) {
    if (!id || !url || !supported() || saving.has(id) || url.startsWith("blob:")) return false;
    saving.add(id);
    try {
      const cache = await open();
      if (!cache) return false;
      if (await cache.match(keyFor(id))) return true;
      const res = await fetch(url);
      if (!res.ok || res.status === 206) return false;
      const len = Number(res.headers.get("content-length")) || 0;
      if (len > MAX_BYTES) return false;
      const blob = await res.blob();
      if (!blob.size || blob.size > MAX_BYTES) return false;
      await cache.put(keyFor(id), new Response(blob, {
        headers: {
          "content-type": res.headers.get("content-type") || "audio/mp4",
          "x-cached-at": String(Date.now()),
        },
      }));
      startSweeper();
      sweep();
      return true;
    } catch {
      return false;
    } finally {
      saving.delete(id);
    }
  },

  /** blob: URL for a cached song, or null. */
  async getUrl(id) {
    if (!id || !supported()) return null;
    try {
      const cache = await open();
      const res = cache && (await cache.match(keyFor(id)));
      if (!res) return null;
      const at = Number(res.headers.get("x-cached-at")) || 0;
      if (Date.now() - at > TTL_MS) { cache.delete(keyFor(id)); return null; }
      const old = objectUrls.get(id);
      if (old) return old;
      const url = URL.createObjectURL(await res.blob());
      objectUrls.set(id, url);
      return url;
    } catch {
      return null;
    }
  },

  async remove(id) {
    try {
      const cache = await open();
      if (cache) await cache.delete(keyFor(id));
      const url = objectUrls.get(id);
      if (url) { URL.revokeObjectURL(url); objectUrls.delete(id); }
    } catch { /* ignore */ }
  },
};

export default trackCache;
