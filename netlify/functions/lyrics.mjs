import { getCached, setCached, CACHE_TTL_MS, CORS_HEADERS } from "./_shared/ytdlpService.mjs";

// ---------------------------------------------------------------------------
// Lyrics — multi-source lookup so (almost) every track gets lyrics.
//
// lrclib.net alone has gaps (especially for Bollywood / regional songs), so
// we now query several providers IN PARALLEL and take the best answer in
// priority order:
//
//   1. lrclib.net        – synced + plain, great for popular tracks
//   2. JioSaavn          – huge Bollywood / Indian catalogue
//   3. NetEase Music     – large catalogue, good coverage of Hindi songs
//   4. lyrics.ovh        – plain text fallback
//   5. YouTube captions  – last resort, via the video id (youtubei.js)
//
// Every provider is individually time-boxed and failure-tolerant: one being
// down / blocked never stops the others. Small JSON only, so it stays well
// inside Netlify's function limits.
// ---------------------------------------------------------------------------

const LRCLIB_USER_AGENT = "Raunaknama/2.0 (https://github.com/raunaknama)";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const SOURCE_TIMEOUT_MS = 6500;
const LYRICS_CACHE_TTL_MS = CACHE_TTL_MS;
const lyricsCache = new Map();

// ---------- helpers ----------

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function fetchJson(url, options = {}, ms = SOURCE_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      // Some endpoints (JioSaavn) wrap JSON with stray characters.
      const start = text.indexOf("{");
      const arrStart = text.indexOf("[");
      const from = start === -1 ? arrStart : arrStart === -1 ? start : Math.min(start, arrStart);
      if (from === -1) return null;
      return JSON.parse(text.slice(from));
    }
  } finally {
    clearTimeout(t);
  }
}

// YouTube titles are noisy ("Song Name (Official Video) | Movie | Singer").
function cleanTrackName(raw) {
  if (!raw) return "";
  return raw
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(
      /\b(official|video|audio|lyrical|lyrics?|lyric video|full song|full video|full|song|hd|hq|4k|8k|music video|visualizer|explicit|clean|remastered|remix version|with lyrics|video song|audio song|new song|latest)\b/gi,
      " "
    )
    .replace(/#\S+/g, " ")
    .replace(/[|•–—].*$/, " ")
    .replace(/\s-\s.*$/, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// "Kesariya - Brahmastra | Arijit Singh" -> multiple candidate titles.
function titleVariants(raw) {
  const out = new Set();
  const full = (raw || "").trim();
  const cleaned = cleanTrackName(full);
  if (cleaned) out.add(cleaned);

  // First segment before | or - or – (usually the song name).
  const seg = full.split(/\s*[|•–—]\s*|\s+-\s+/)[0];
  const segClean = cleanTrackName(seg);
  if (segClean) out.add(segClean);

  // Strip "(From "Movie")" style leftovers but keep the main name.
  const noParen = full.replace(/\s*[\(\[][^\)\]]*[\)\]]/g, "").trim();
  const npClean = cleanTrackName(noParen);
  if (npClean) out.add(npClean);

  return [...out].filter((v) => v.length > 1);
}

function cleanArtist(raw) {
  if (!raw) return "";
  return raw
    .replace(/\s*-\s*topic\s*$/i, "")
    .replace(/\b(vevo|official|music|records?|t-series|tseries|zee music company|sony music india|saregama|YRF|tips (official|music|films)?|lyrical)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const normalize = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

// Rough "is this the same song?" check — token overlap between the cleaned
// title we asked for and the title a provider returned.
function titleMatches(wanted, got) {
  const a = normalize(cleanTrackName(wanted)).split(" ").filter(Boolean);
  const b = normalize(got).split(" ").filter(Boolean);
  if (!a.length || !b.length) return false;
  const setB = new Set(b);
  const hits = a.filter((w) => setB.has(w)).length;
  return hits / a.length >= 0.6 || (hits >= 1 && a.length === 1);
}

function htmlToText(html) {
  return (html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const hasContent = (r) => r && ((r.synced && r.synced.trim()) || (r.plain && r.plain.trim()));

// ---------- source 1: lrclib.net ----------

async function lrclibFetch(path) {
  return fetchJson(`https://lrclib.net${path}`, {
    headers: { "User-Agent": LRCLIB_USER_AGENT, Accept: "application/json" },
  });
}

async function fromLrclib({ track, artist, duration }) {
  const titles = titleVariants(track);
  const durationSecs = Number.isFinite(duration) ? Math.round(duration) : null;
  const pick = (results) => {
    if (!Array.isArray(results) || !results.length) return null;
    const good = results.filter((r) => titleMatches(track, r.trackName || ""));
    const pool = good.length ? good : [];
    return pool.find((r) => r.syncedLyrics) || pool.find((r) => r.plainLyrics) || null;
  };
  const wrap = (hit) =>
    hit && (hit.syncedLyrics || hit.plainLyrics)
      ? {
          synced: hit.syncedLyrics || null,
          plain: hit.plainLyrics || null,
          instrumental: !!hit.instrumental,
        }
      : null;

  const attempts = [];
  for (const t of titles) {
    if (artist && durationSecs) {
      attempts.push(() =>
        lrclibFetch(`/api/get?${new URLSearchParams({ track_name: t, artist_name: artist, duration: String(durationSecs) })}`)
      );
    }
    attempts.push(async () => {
      const p = new URLSearchParams({ track_name: t });
      if (artist) p.set("artist_name", artist);
      return pick(await lrclibFetch(`/api/search?${p}`));
    });
    attempts.push(async () => pick(await lrclibFetch(`/api/search?${new URLSearchParams({ q: artist ? `${t} ${artist}` : t })}`)));
    attempts.push(async () => pick(await lrclibFetch(`/api/search?${new URLSearchParams({ q: t })}`)));
  }
  attempts.push(async () => pick(await lrclibFetch(`/api/search?${new URLSearchParams({ q: track })}`)));

  for (const attempt of attempts) {
    try {
      const r = wrap(await attempt());
      if (hasContent(r)) return r;
    } catch (err) {
      console.warn("[lyrics] lrclib attempt failed:", err.message);
    }
  }
  return null;
}

// ---------- source 2: JioSaavn (great for Bollywood) ----------

async function fromSaavn({ track, artist }) {
  const titles = titleVariants(track);
  const queries = [];
  for (const t of titles) {
    if (artist) queries.push(`${t} ${artist}`);
    queries.push(t);
  }
  for (const q of [...new Set(queries)].slice(0, 3)) {
    try {
      const search = await fetchJson(
        `https://www.jiosaavn.com/api.php?${new URLSearchParams({
          __call: "search.getResults",
          _format: "json",
          _marker: "0",
          api_version: "4",
          ctx: "web6dot0",
          n: "8",
          p: "1",
          q,
        })}`,
        { headers: { "User-Agent": BROWSER_UA, Accept: "application/json" } }
      );
      const list = search?.results || search?.data?.results || [];
      const candidates = list.filter(
        (s) => titleMatches(track, s.title || s.song || "") && String(s.more_info?.has_lyrics ?? s.has_lyrics ?? "true") !== "false"
      );
      for (const song of candidates.slice(0, 3)) {
        const lyricsId = song.more_info?.lyrics_id || song.lyrics_id || song.id;
        if (!lyricsId) continue;
        const data = await fetchJson(
          `https://www.jiosaavn.com/api.php?${new URLSearchParams({
            __call: "lyrics.getLyrics",
            ctx: "web6dot0",
            api_version: "4",
            _format: "json",
            _marker: "0",
            lyrics_id: String(lyricsId),
          })}`,
          { headers: { "User-Agent": BROWSER_UA, Accept: "application/json" } }
        );
        const text = htmlToText(data?.lyrics || data?.data?.lyrics || "");
        if (text && text.length > 40) return { synced: null, plain: text, instrumental: false };
      }
    } catch (err) {
      console.warn("[lyrics] saavn attempt failed:", err.message);
    }
  }
  return null;
}

// ---------- source 3: NetEase Music ----------

const NETEASE_HEADERS = {
  "User-Agent": BROWSER_UA,
  Referer: "https://music.163.com/",
  Accept: "application/json",
};

async function fromNetease({ track, artist }) {
  const titles = titleVariants(track);
  const queries = [];
  for (const t of titles.slice(0, 2)) {
    if (artist) queries.push(`${t} ${artist}`);
    queries.push(t);
  }
  for (const q of [...new Set(queries)].slice(0, 3)) {
    try {
      const search = await fetchJson("https://music.163.com/api/search/get/web", {
        method: "POST",
        headers: { ...NETEASE_HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ s: q, type: "1", offset: "0", total: "true", limit: "8" }).toString(),
      });
      const songs = search?.result?.songs || [];
      const matches = songs.filter((s) => titleMatches(track, s.name || ""));
      for (const song of matches.slice(0, 3)) {
        const data = await fetchJson(
          `https://music.163.com/api/song/lyric?${new URLSearchParams({ id: String(song.id), lv: "1", kv: "1", tv: "-1" })}`,
          { headers: NETEASE_HEADERS }
        );
        const lrc = data?.lrc?.lyric || "";
        if (!lrc || lrc.length < 30) continue;
        const hasTime = /\[\d{1,2}:\d{2}/.test(lrc);
        // Strip credit lines like "作词 : xxx" that some uploads include.
        return hasTime
          ? { synced: lrc, plain: null, instrumental: false }
          : { synced: null, plain: lrc.trim(), instrumental: false };
      }
    } catch (err) {
      console.warn("[lyrics] netease attempt failed:", err.message);
    }
  }
  return null;
}

// ---------- source 4: lyrics.ovh ----------

async function fromOvh({ track, artist }) {
  if (!artist) return null;
  for (const t of titleVariants(track).slice(0, 2)) {
    try {
      const data = await fetchJson(
        `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(t)}`
      );
      const text = (data?.lyrics || "").trim();
      if (text && text.length > 40) return { synced: null, plain: text, instrumental: false };
    } catch (err) {
      console.warn("[lyrics] lyrics.ovh failed:", err.message);
    }
  }
  return null;
}

// ---------- source 5: YouTube captions (by video id) ----------

let ytClientPromise = null;
async function getYtClient() {
  if (!ytClientPromise) {
    ytClientPromise = import("youtubei.js")
      .then(({ Innertube, Log }) => {
        try { Log?.setLevel?.(Log.Level.NONE); } catch { /* ignore */ }
        return Innertube.create({ generate_session_locally: true, retrieve_player: false });
      })
      .catch((err) => {
        ytClientPromise = null;
        throw err;
      });
  }
  return ytClientPromise;
}

async function fromYoutube({ videoId }) {
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) return null;
  try {
    const yt = await getYtClient();
    const info = await yt.getInfo(videoId);
    const transcript = await info.getTranscript();
    const segments =
      transcript?.transcript?.content?.body?.initial_segments ||
      transcript?.transcript?.content?.body?.segments ||
      [];
    const lines = segments
      .map((s) => (s?.snippet?.text || s?.snippet?.toString?.() || "").trim())
      .filter((l) => l && !/^\[.*\]$/.test(l));
    if (lines.length < 4) return null;
    return { synced: null, plain: lines.join("\n"), instrumental: false };
  } catch (err) {
    console.warn("[lyrics] youtube captions failed:", err.message);
    return null;
  }
}

// ---------- orchestration ----------

const SOURCES = [
  { name: "lrclib.net", run: fromLrclib },
  { name: "JioSaavn", run: fromSaavn },
  { name: "NetEase Music", run: fromNetease },
  { name: "lyrics.ovh", run: fromOvh },
  { name: "YouTube captions", run: fromYoutube },
];

async function findLyrics(query) {
  // Fire every source at once, then walk them in priority order. Total
  // latency is the slowest source we actually have to wait for (each is
  // capped), not the sum of all of them.
  const running = SOURCES.map((s) =>
    withTimeout(s.run(query), SOURCE_TIMEOUT_MS + 1500, s.name).catch((err) => {
      console.warn(`[lyrics] ${s.name} failed:`, err.message);
      return null;
    })
  );
  for (let i = 0; i < SOURCES.length; i++) {
    const result = await running[i];
    if (hasContent(result)) return { ...result, source: SOURCES[i].name };
  }
  return null;
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  const { track, artist, duration, id } = event.queryStringParameters || {};

  if (!track || !track.trim()) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify({ error: "Query parameter 'track' is required" }),
    };
  }

  const durationNum = duration ? Number(duration) : null;
  const artistClean = cleanArtist(artist || "");
  const cacheKey = `${track.trim().toLowerCase()}::${artistClean.toLowerCase()}::${durationNum || ""}::${id || ""}`;

  const cached = getCached(lyricsCache, cacheKey);
  if (cached) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify(cached),
    };
  }

  try {
    const hit = await findLyrics({
      track,
      artist: artistClean || null,
      duration: durationNum,
      videoId: id || null,
    });

    const payload = hit
      ? {
          available: true,
          synced: hit.synced || null,
          plain: hit.plain || null,
          trackName: track,
          artistName: artistClean || null,
          instrumental: !!hit.instrumental,
          source: hit.source,
        }
      : { available: false };

    // Only cache hits for the full TTL; misses are retried sooner.
    setCached(lyricsCache, cacheKey, payload, hit ? LYRICS_CACHE_TTL_MS : 60 * 1000);

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
