import { searchCache, getCached, setCached, CORS_HEADERS, CDN_CACHE } from "./_shared/ytdlpService.mjs";
import { searchSongs } from "./_shared/ytMusic.mjs";

// GET /api/music-search?q=<text>
//   -> { query, songs: [{ id, title, channel, artists, album, duration, thumbnailUrl, isMusic }] }
//
// YouTube Music *songs* (audio tracks) for a query — what the search page shows
// in its "Songs" section. Never fails the page: on any error it answers
// { songs: [] } so the plain YouTube results still show up on their own.

const json = (statusCode, body, extra = {}) => ({
  statusCode,
  headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extra },
  body: JSON.stringify(body),
});

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS_HEADERS, body: "" };

  const q = String(event.queryStringParameters?.q || "").trim().slice(0, 100);
  if (!q) return json(400, { error: "Query parameter 'q' is required" });

  const cacheKey = `music|${q.toLowerCase()}`;
  const cached = getCached(searchCache, cacheKey);
  if (cached) return json(200, cached, { "Cache-Control": CDN_CACHE });

  try {
    const songs = await searchSongs(q);
    const payload = { query: q, songs };
    if (songs.length) setCached(searchCache, cacheKey, payload);
    return json(200, payload, { "Cache-Control": songs.length ? CDN_CACHE : "no-store" });
  } catch (err) {
    console.warn("[music-search] failed:", String(err?.message || err).slice(0, 160));
    return json(200, { query: q, songs: [], error: "music search unavailable" }, { "Cache-Control": "no-store" });
  }
};
