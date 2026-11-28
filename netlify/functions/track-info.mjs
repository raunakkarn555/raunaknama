import { searchCache, getCached, setCached, CORS_HEADERS, CDN_CACHE } from "./_shared/ytdlpService.mjs";
import { searchSongs } from "./_shared/ytMusic.mjs";
import { __test as M } from "./lyrics.mjs";

// GET /api/track-info?id=<videoId>&title=<title>&channel=<uploader>&duration=<secs>
//   -> { found: true, artists: [...], channel: "A, B", album, thumbnailUrl }   (or { found: false })
//
// Playlist tracks come from plain YouTube videos, so their "channel" is the UPLOADER (T-Series,
// Zee Music, ...), not the singer. This looks the song up on YouTube Music and returns its real
// artists / album / cover, but only when it is really the same song (same video id, or matching
// title + artist/duration). Display data only: it never touches playback.

const json = (statusCode, body, extra = {}) => ({
  statusCode,
  headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extra },
  body: JSON.stringify(body),
});

function pickSong(songs, meta, variants) {
  const hay = M.normalize(`${meta.title} ${meta.channel || ""}`);
  let best = null;
  let bestScore = 0;
  for (const s of songs) {
    if (s.id === meta.id) return s; // exactly this video
    const sim = M.titleSimilarity(variants, s.title);
    if (sim < 0.8) continue;
    const artistOk = (s.artists || []).some((a) => M.artistMatches(hay, a));
    const dur = meta.duration && s.duration ? Math.abs(meta.duration - s.duration) : null;
    if (dur === null) {
      if (!(artistOk && sim >= 0.95)) continue;
    } else if (artistOk) {
      if (dur > 25) continue;              // same artist but a different recording
    } else if (dur > 4 || sim < 0.9) {
      continue;                            // no artist to confirm: needs a near-identical length
    }
    const score = sim + (artistOk ? 0.5 : 0) + (dur !== null ? Math.max(0, (25 - dur) / 50) : 0);
    if (score > bestScore) { best = s; bestScore = score; }
  }
  return best;
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS_HEADERS, body: "" };

  const q = event.queryStringParameters || {};
  const id = String(q.id || "").trim();
  const title = String(q.title || "").trim().slice(0, 200);
  if (!/^[\w-]{11}$/.test(id) || !title) return json(400, { error: "id and title are required" });

  const duration = q.duration ? Number(q.duration) : null;
  const hint = M.cleanArtist(String(q.channel || "")) || "";
  const cacheKey = `trackinfo|${id}`;
  const cached = getCached(searchCache, cacheKey);
  if (cached) return json(200, cached, { "Cache-Control": CDN_CACHE });

  const meta = { id, title, channel: hint, duration: Number.isFinite(duration) ? duration : null };
  const variants = M.titleVariants(title);
  const base = variants[0] || title;
  const queries = [...new Set([base, hint ? `${base} ${hint}` : null].filter(Boolean))].slice(0, 2);

  let payload = { found: false };
  try {
    for (const query of queries) {
      const songs = await searchSongs(query, { timeoutMs: 6000 });
      const hit = pickSong(songs, meta, variants);
      if (hit && hit.artists?.length) {
        payload = { found: true, artists: hit.artists, channel: hit.artists.join(", "), album: hit.album || null, thumbnailUrl: hit.thumbnailUrl || null };
        break;
      }
    }
  } catch (err) {
    console.warn("[track-info] failed:", String(err?.message || err).slice(0, 160));
    return json(200, { found: false }, { "Cache-Control": "no-store" });
  }
  setCached(searchCache, cacheKey, payload, payload.found ? 6 * 60 * 60 * 1000 : 5 * 60 * 1000);
  return json(200, payload, { "Cache-Control": payload.found ? CDN_CACHE : "no-store" });
};

// exported only for unit tests
export const __pick = pickSong;
