import {
  searchCache,
  getCached,
  setCached,
  authArgs,
  spawnYtDlp,
  cookieAwareErrorDetails,
  CORS_HEADERS,
} from "./_shared/ytdlpService.mjs";
import { searchSongs } from "./_shared/ytMusic.mjs";

// GET /api/artist-songs?name=<artist>&page=<0..>&source=music|youtube
//   -> { results: [{id,title,channel,duration,...}], page, hasMore, source }
//
// source=music   (default) YouTube Music SONGS by the artist — audio tracks with
//                real artist / album data, like the Recommended cards.
// source=youtube plain YouTube VIDEO results for the artist (the old behaviour).
//
// Each page runs a DIFFERENT flavour of search for the artist ("songs",
// "hit songs", "romantic", "live"…), so scrolling keeps surfacing new tracks
// at constant cost instead of re-fetching an ever-longer list.

const VARIANTS = [
  "songs",
  "hit songs",
  "best of",
  "romantic songs",
  "latest songs",
  "sad songs",
  "live performance",
  "unplugged acoustic",
  "duet songs",
  "old songs",
];
// Music search already returns clean song tracks, so its flavours are plainer.
const MUSIC_VARIANTS = [
  "",
  "hits",
  "best of",
  "romantic",
  "latest",
  "sad",
  "unplugged",
  "duet",
  "old",
  "evergreen",
  "live",
  "popular",
];
const PER_PAGE = 20;
const MIN_SECS = 60;
const MAX_SECS = 10 * 60; // skip jukeboxes / mixes / podcasts

const json = (statusCode, body, extra = {}) => ({
  statusCode,
  headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extra },
  body: JSON.stringify(body),
});

const norm = (s) => String(s || "").toLowerCase();

async function musicPage(name, page) {
  const hasMore = page < MUSIC_VARIANTS.length - 1;
  const cacheKey = `artist-music|${norm(name)}|${page}`;
  const cached = getCached(searchCache, cacheKey);
  if (cached) return json(200, cached, { "Cache-Control": "public, max-age=600" });

  try {
    const query = `${name} ${MUSIC_VARIANTS[page]}`.trim();
    const firstWord = norm(name).split(/\s+/).find((w) => w.length >= 3) || norm(name);
    const seen = new Set();
    const results = [];
    for (const song of await searchSongs(query)) {
      if (seen.has(song.id)) continue;
      const d = Number(song.duration) || 0;
      if (d && (d < MIN_SECS || d > MAX_SECS)) continue;
      // Music results carry real artist credits: keep songs that credit this artist.
      const credits = `${song.artists.map(norm).join(" ")} ${norm(song.channel)}`;
      if (!credits.includes(firstWord)) continue;
      seen.add(song.id);
      results.push(song);
    }
    const payload = { results, page, hasMore, source: "music" };
    if (results.length) setCached(searchCache, cacheKey, payload, 60 * 60 * 1000);
    return json(200, payload, { "Cache-Control": "public, max-age=600" });
  } catch (err) {
    console.warn("[artist-songs] music search failed:", String(err?.message || err).slice(0, 160));
    return json(502, { error: "Failed to load songs", details: String(err?.message || err) });
  }
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS_HEADERS, body: "" };

  const name = String(event.queryStringParameters?.name || "").trim().slice(0, 80);
  const page = Math.max(0, Math.min(VARIANTS.length - 1, parseInt(event.queryStringParameters?.page, 10) || 0));
  if (!name) return json(400, { error: "Query parameter 'name' is required" });

  const source = String(event.queryStringParameters?.source || "music").toLowerCase() === "youtube" ? "youtube" : "music";
  if (source === "music") return musicPage(name, Math.min(page, MUSIC_VARIANTS.length - 1));

  const hasMore = page < VARIANTS.length - 1;
  const cacheKey = `artist|${norm(name)}|${page}`;
  const cached = getCached(searchCache, cacheKey);
  if (cached) return json(200, { ...cached, source }, { "Cache-Control": "public, max-age=600" });

  try {
    const { code, stdoutData, stderrData } = await spawnYtDlp([
      "-J",
      "--flat-playlist",
      "--no-warnings",
      ...authArgs(),
      `ytsearch${PER_PAGE}:${name} ${VARIANTS[page]}`,
    ]);

    if (code !== 0 || !stdoutData.trim()) {
      const details = stderrData?.trim() ? cookieAwareErrorDetails(stderrData) : "yt-dlp produced no output";
      console.error("[artist-songs] yt-dlp failed:", details);
      return json(502, { error: "Failed to load songs", details });
    }

    const firstWord = norm(name).split(/\s+/).find((w) => w.length >= 3) || norm(name);
    const seen = new Set();
    const results = [];
    for (const item of JSON.parse(stdoutData).entries || []) {
      if (!item?.id || seen.has(item.id)) continue;
      const d = Number(item.duration) || 0;
      if (d && (d < MIN_SECS || d > MAX_SECS)) continue;
      const channel = item.uploader || item.channel || "";
      // keep it about this artist (title or channel mentions them)
      if (!`${norm(item.title)} ${norm(channel)}`.includes(firstWord)) continue;
      seen.add(item.id);
      results.push({ id: item.id, title: item.title, channel, duration: item.duration });
    }

    const payload = { results, page, hasMore };
    setCached(searchCache, cacheKey, payload, 60 * 60 * 1000);
    return json(200, { ...payload, source }, { "Cache-Control": "public, max-age=600" });
  } catch (err) {
    console.error("[artist-songs] error:", err);
    return json(500, { error: err.message || "Unexpected error" });
  }
};
