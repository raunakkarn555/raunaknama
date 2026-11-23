// Piped API fallback. Piped instances return *proxied* audio URLs (served from
// the instance's own proxy host), so they are not bound to this server's IP
// and play from the browser regardless of where the function runs.
//
// Public Piped instances come and go, and the former built-in defaults
// (pipedapi.kavin.rocks, pipedapi.adminforge.de, piped-api.private.coffee)
// were failing on every request (502/525/403/fetch failed), only adding
// 300-1000ms of dead wait. There is therefore NO default list any more:
// Piped is skipped entirely unless PIPED_API_INSTANCES is explicitly set
// (comma-separated base URLs of instances you have verified work), e.g.
//   PIPED_API_INSTANCES=https://my-piped-api.example.com,https://other.example.org

export const PIPED_INSTANCES = (process.env.PIPED_API_INSTANCES || "")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const PIPED_TIMEOUT_MS = 3500;
const LOG = process.env.STREAM_LOG !== "0";
const log = (...a) => { if (LOG) console.log("[piped]", ...a); };

function pickAudio(streams) {
  const audio = (Array.isArray(streams) ? streams : []).filter(
    (s) => s?.url && !s.videoOnly && String(s.mimeType || "").startsWith("audio/")
  );
  const byBitrate = (a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0);
  const mp4 = audio.filter((s) => String(s.mimeType).startsWith("audio/mp4")).sort(byBitrate);
  const webm = audio.filter((s) => String(s.mimeType).startsWith("audio/webm")).sort(byBitrate);
  return (
    mp4.find((s) => s.itag === 140) || mp4[0] || webm.find((s) => s.itag === 251) || webm[0] || null
  );
}

async function askInstance(base, videoId) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PIPED_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/streams/${encodeURIComponent(videoId)}`, {
      signal: ctrl.signal,
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; raunaknama)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data?.error) throw new Error(String(data.message || data.error).slice(0, 100));
    const best = pickAudio(data?.audioStreams);
    if (!best) throw new Error("no audio stream");
    return { url: best.url, client: "PIPED", itag: best.itag, instance: base, ms: Date.now() - t0 };
  } catch (err) {
    log(`${videoId} ${base} failed in ${Date.now() - t0}ms: ${err.name === "AbortError" ? "timeout" : err.message}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Races every configured Piped instance. Never rejects: resolves a hit or null. */
export async function resolveWithPiped(videoId) {
  if (!PIPED_INSTANCES.length) return null;
  try {
    const hit = await Promise.any(PIPED_INSTANCES.map((b) => askInstance(b, videoId)));
    log(`${videoId} OK ${hit.instance} itag=${hit.itag} in ${hit.ms}ms`);
    return hit;
  } catch {
    return null;
  }
}
