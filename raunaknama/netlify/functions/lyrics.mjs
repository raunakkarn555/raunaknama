import { getCached, setCached, CACHE_TTL_MS, CORS_HEADERS } from "./_shared/ytdlpService.mjs";

// ---------------------------------------------------------------------------
// Lyrics — powered by lrclib.net (free, no API key, ships real LRC timing
// data). We never proxy audio here, just small JSON — well within Netlify's
// 10s function limit.
// ---------------------------------------------------------------------------

// lrclib.net asks integrators to identify themselves with a descriptive
// User-Agent (their docs call this out explicitly) — requests without one
// are more likely to get throttled.
const LRCLIB_USER_AGENT = "Raunaknama/2.0 (https://github.com/raunaknama)";

const LYRICS_CACHE_TTL_MS = CACHE_TTL_MS; // 20 min — plenty for a session's replays.
const lyricsCache = new Map();

// YouTube titles are noisy ("Song Name (Official Video) | Movie | Singer").
// Strip the common wrapper junk so what's left is close to the real track
// name lrclib actually indexes.
function cleanTrackName(raw) {
  if (!raw) return "";
  return raw
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(
      /\b(official|video|audio|lyrics?|lyric video|full song|full video|hd|4k|music video|visualizer|explicit|clean|remastered)\b/gi,
      " "
    )
    .replace(/[|•\-–—].*$/, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function lrclibFetch(path) {
  const res = await fetch(`https://lrclib.net${path}`, {
    headers: {
      "User-Agent": LRCLIB_USER_AGENT,
      Accept: "application/json",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`lrclib responded ${res.status}`);
  }
  return res.json();
}

// Tries, in order: exact `/api/get` (track+artist+duration — lrclib's most
// precise match), then progressively looser `/api/search` calls. Returns
// the first hit that actually carries synced or plain lyrics.
async function findLyrics({ track, artist, duration }) {
  const cleanedTrack = cleanTrackName(track);
  const durationSecs = Number.isFinite(duration) ? Math.round(duration) : null;

  const attempts = [];

  if (cleanedTrack && artist && durationSecs) {
    attempts.push(() => {
      const params = new URLSearchParams({
        track_name: cleanedTrack,
        artist_name: artist,
        duration: String(durationSecs),
      });
      return lrclibFetch(`/api/get?${params.toString()}`);
    });
  }

  if (cleanedTrack && durationSecs) {
    attempts.push(() => {
      const params = new URLSearchParams({
        track_name: cleanedTrack,
        duration: String(durationSecs),
      });
      return lrclibFetch(`/api/get?${params.toString()}`);
    });
  }

  if (cleanedTrack) {
    attempts.push(async () => {
      const params = new URLSearchParams({ track_name: cleanedTrack });
      if (artist) params.set("artist_name", artist);
      const results = await lrclibFetch(`/api/search?${params.toString()}`);
      if (!Array.isArray(results) || !results.length) return null;
      return (
        results.find((r) => r.syncedLyrics) ||
        results.find((r) => r.plainLyrics) ||
        null
      );
    });

    // Last resort: raw (uncleaned) title as a free-text search query — some
    // tracks only match on the exact string YouTube shipped.
    attempts.push(async () => {
      const params = new URLSearchParams({ q: track });
      const results = await lrclibFetch(`/api/search?${params.toString()}`);
      if (!Array.isArray(results) || !results.length) return null;
      return (
        results.find((r) => r.syncedLyrics) ||
        results.find((r) => r.plainLyrics) ||
        null
      );
    });
  }

  for (const attempt of attempts) {
    try {
      const hit = await attempt();
      if (hit && (hit.syncedLyrics || hit.plainLyrics)) return hit;
    } catch (err) {
      // One strategy failing (network blip, lrclib hiccup) shouldn't stop
      // the remaining fallbacks from being tried.
      console.warn("[lyrics] lookup attempt failed:", err.message);
    }
  }

  return null;
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  const { track, artist, duration } = event.queryStringParameters || {};

  if (!track || !track.trim()) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify({ error: "Query parameter 'track' is required" }),
    };
  }

  const durationNum = duration ? Number(duration) : null;
  const cacheKey = `${track.trim().toLowerCase()}::${(artist || "").trim().toLowerCase()}::${
    durationNum || ""
  }`;

  const cached = getCached(lyricsCache, cacheKey);
  if (cached) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify(cached),
    };
  }

  try {
    const hit = await findLyrics({ track, artist: artist || null, duration: durationNum });

    const payload = hit
      ? {
          available: true,
          synced: hit.syncedLyrics || null,
          plain: hit.plainLyrics || null,
          trackName: hit.trackName || track,
          artistName: hit.artistName || artist || null,
          instrumental: !!hit.instrumental,
        }
      : { available: false };

    setCached(lyricsCache, cacheKey, payload, LYRICS_CACHE_TTL_MS);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    console.error("Lyrics lookup error:", err);
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify({ error: err.message || "Failed to fetch lyrics", available: false }),
    };
  }
};
