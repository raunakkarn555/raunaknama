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
    let res;
    try {
      res = await fetch(url, { ...options, signal: ctrl.signal });
    } catch (err) {
      if (err?.name === "AbortError" || ctrl.signal.aborted) throw new Error(`${new URL(url).host} timeout`);
      throw err;
    }
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

// ---------- validation: make sure a lyrics hit is really THIS song ----------
// Matching on a few shared words alone returned the wrong song for common titles
// ("I Love You", "Zara Sa", ...). A candidate must now pass a title check AND be
// confirmed by the artist (named in the YouTube title / channel) or by its duration,
// and lyrics in a script that does not fit the song (e.g. Chinese for a Hindi title) are rejected.

const TITLE_NOISE = new Set(["the", "a", "an", "of", "from", "feat", "ft", "version", "movie", "film", "song", "songs", "full", "video", "audio", "lyrics", "lyrical"]);
const titleWords = (s) => new Set(normalize(s).split(" ").filter((w) => w && !TITLE_NOISE.has(w)));

function titleSimilarity(variants, gotTitle) {
  const got = titleWords(cleanTrackName(gotTitle) || gotTitle);
  if (!got.size) return 0;
  let best = 0;
  for (const v of variants) {
    const want = titleWords(v);
    if (!want.size) continue;
    let hits = 0;
    for (const w of want) if (got.has(w)) hits += 1;
    let sim = hits / Math.max(want.size, got.size);
    // "Song" inside a longer YouTube title, or the title with a few extra words.
    if (got.size >= 3 && hits === got.size) sim = Math.max(sim, 0.8);
    if (want.size >= 3 && hits === want.size && got.size - hits <= 2) sim = Math.max(sim, 0.85);
    // One-word titles must match exactly.
    if (want.size === 1 || got.size === 1) sim = hits === want.size && hits === got.size ? 1 : 0;
    if (sim > best) best = sim;
  }
  return best;
}

// Do the candidate's artist name(s) appear in the YouTube title / channel text?
function artistMatches(hayNorm, candArtist) {
  if (!candArtist) return false;
  const hay = new Set(hayNorm.split(" ").filter(Boolean));
  return String(candArtist)
    .split(/,|&|\/|;|\band\b|\bfeat\.?\b|\bft\.?\b/i)
    .some((name) => {
      const toks = normalize(name).split(" ").filter((w) => w.length >= 2 && !TITLE_NOISE.has(w));
      if (!toks.length) return false;
      const hit = toks.filter((w) => hay.has(w)).length;
      return hit >= 1 && hit >= Math.ceil(toks.length / 2);
    });
}

// Every script is accepted now (Hindi, Roman, Urdu, Punjabi, Tamil, Arabic, Chinese, Korean, ...).
// Correctness no longer depends on the script: a hit must pass the title + artist + duration checks
// in judgeCandidate() (and the synced-length check below) to count as "this song".
function scriptOk() {
  return true;
}

// Synced lyrics cannot run longer than the song: a last timestamp well past the song's end means another recording.
function syncedFits(lrc, durationSecs) {
  if (!lrc || !durationSecs) return true;
  let last = 0;
  for (const m of lrc.matchAll(/\[(\d{1,3}):(\d{2}(?:\.\d+)?)\]/g)) {
    const t = Number(m[1]) * 60 + Number(m[2]);
    if (t > last) last = t;
  }
  return last <= durationSecs + 8;
}

/**
 * Score a candidate song from a provider. 0 = not the same song.
 * meta: { track, artist, duration }  cand: { title, artist, duration }
 */
function judgeCandidate(meta, cand, { requireArtist = false } = {}) {
  const sim = titleSimilarity(titleVariants(meta.track), cand.title || "");
  if (sim < 0.75) return 0;
  const hay = normalize(`${meta.track} ${meta.artist || ""}`);
  const artistOk = artistMatches(hay, cand.artist);
  const dur = meta.duration && cand.duration ? Math.abs(meta.duration - cand.duration) : null;
  if (requireArtist && !artistOk) return 0;
  if (artistOk) {
    if (dur !== null && dur > 20) return 0; // right artist but a different recording (live / remix)
  } else {
    // Same title is NOT enough ("I Love You", "Zara Sa" ... exist by many artists): without the
    // artist confirming it, only a (near) identical title AND an almost identical length is accepted.
    if (dur === null || dur > 2 || sim < 0.95) return 0;
  }
  return sim + (artistOk ? 0.5 : 0) + (dur !== null ? Math.max(0, (20 - dur) / 40) : 0);
}

const isTimeout = (err) => /timeout|timed out|aborted/i.test(String(err?.message || err));
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
  const meta = { track, artist, duration: durationSecs };
  const pick = (results) => {
    const list = Array.isArray(results) ? results : results ? [results] : [];
    let best = null;
    let bestScore = 0;
    for (const r of list) {
      if (!(r.syncedLyrics || r.plainLyrics)) continue;
      const score = judgeCandidate(meta, { title: r.trackName, artist: r.artistName, duration: r.duration });
      if (!score) continue;
      if (!scriptOk(`${track} ${artist || ""}`, r.syncedLyrics || r.plainLyrics)) continue;
      if (r.syncedLyrics && !syncedFits(r.syncedLyrics, durationSecs)) continue;
      const total = score + (r.syncedLyrics ? 0.05 : 0);
      if (total > bestScore) { best = r; bestScore = total; }
    }
    return best;
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
      attempts.push(async () =>
        pick(await lrclibFetch(`/api/get?${new URLSearchParams({ track_name: t, artist_name: artist, duration: String(durationSecs) })}`))
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
      if (!isTimeout(err)) console.warn("[lyrics] lrclib attempt failed:", err.message);
    }
  }
  return null;
}

// ---------- source 2: JioSaavn (great for Bollywood) ----------

async function fromSaavn({ track, artist, duration }) {
  const meta = { track, artist, duration: Number.isFinite(duration) ? Math.round(duration) : null };
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
      const saavnArtists = (s) =>
        s.more_info?.artistMap?.primary_artists?.map((a) => a.name).join(", ") || s.more_info?.music || s.primary_artists || s.subtitle || "";
      const candidates = list
        .filter((s) => String(s.more_info?.has_lyrics ?? s.has_lyrics ?? "true") !== "false")
        .map((s) => ({
          song: s,
          score: judgeCandidate(meta, {
            title: htmlToText(s.title || s.song || ""),
            artist: htmlToText(String(saavnArtists(s))),
            duration: Number(s.more_info?.duration || s.duration) || null,
          }),
        }))
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((c) => c.song);
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
        if (text && text.length > 40 && scriptOk(`${track} ${artist || ""}`, text)) return { synced: null, plain: text, instrumental: false };
      }
    } catch (err) {
      if (!isTimeout(err)) console.warn("[lyrics] saavn attempt failed:", err.message);
    }
  }
  return null;
}

// ---------- source 3: NetEase Music ----------

const NETEASE_TIMEOUT_MS = 3000;
const NETEASE_HEADERS = {
  "User-Agent": BROWSER_UA,
  Referer: "https://music.163.com/",
  Accept: "application/json",
};

async function fromNetease({ track, artist, duration }) {
  const meta = { track, artist, duration: Number.isFinite(duration) ? Math.round(duration) : null };
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
      }, NETEASE_TIMEOUT_MS);
      const songs = search?.result?.songs || [];
      // NetEase is a mostly-Chinese catalogue full of same-titled songs: the artist MUST match.
      const matches = songs
        .map((s) => ({
          song: s,
          score: judgeCandidate(
            meta,
            { title: s.name || "", artist: (s.artists || s.ar || []).map((a) => a.name).join(", "), duration: s.duration ? s.duration / 1000 : null },
            { requireArtist: true }
          ),
        }))
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((c) => c.song);
      for (const song of matches.slice(0, 3)) {
        const data = await fetchJson(
          `https://music.163.com/api/song/lyric?${new URLSearchParams({ id: String(song.id), lv: "1", kv: "1", tv: "-1" })}`,
          { headers: NETEASE_HEADERS },
          NETEASE_TIMEOUT_MS
        );
        const lrc = data?.lrc?.lyric || "";
        if (!lrc || lrc.length < 30) continue;
        if (!scriptOk(`${track} ${artist || ""}`, lrc)) continue;
        if (!syncedFits(lrc, meta.duration)) continue;
        const hasTime = /\[\d{1,2}:\d{2}/.test(lrc);
        // Strip credit lines like "作词 : xxx" that some uploads include.
        return hasTime
          ? { synced: lrc, plain: null, instrumental: false }
          : { synced: null, plain: lrc.trim(), instrumental: false };
      }
    } catch (err) {
      // NetEase is often unreachable from outside China: one timeout means the
      // next two queries would time out as well, so give up on it right away.
      if (isTimeout(err)) return null;
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
      if (text && text.length > 40 && scriptOk(`${track} ${artist || ""}`, text)) return { synced: null, plain: text, instrumental: false };
    } catch (err) {
      if (!isTimeout(err)) console.warn("[lyrics] lyrics.ovh failed:", err.message);
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
    const plain = lines.join("\n");
    if (!scriptOk("", plain)) return null;
    return { synced: null, plain, instrumental: false };
  } catch (err) {
    // "Transcript panel not found" / HTTP 400 just mean this video has no
    // transcript — that is normal, not an error worth printing.
    if (!/transcript|status code 400|timeout|timed out/i.test(String(err?.message || err))) {
      console.warn("[lyrics] youtube captions failed:", err.message);
    }
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
  // Fire the four lightweight text providers at once, then walk them in
  // priority order. Total latency is the slowest provider we actually have to
  // wait for (each is capped), not the sum of all of them.
  const guard = (s) =>
    withTimeout(s.run(query), SOURCE_TIMEOUT_MS + 1500, s.name).catch((err) => {
      if (!isTimeout(err)) console.warn(`[lyrics] ${s.name} failed:`, err.message);
      return null;
    });
  const quick = SOURCES.filter((s) => s.name !== "YouTube captions");
  const running = quick.map(guard);
  for (let i = 0; i < quick.length; i++) {
    const result = await running[i];
    if (hasContent(result)) return { ...result, source: quick[i].name };
  }
  // YouTube captions need a full player request for the video, so they only
  // run when nothing else had the song.
  const yt = SOURCES.find((s) => s.name === "YouTube captions");
  const result = await guard(yt);
  return hasContent(result) ? { ...result, source: yt.name } : null;
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
  const cacheKey = `v3::${track.trim().toLowerCase()}::${artistClean.toLowerCase()}::${durationNum || ""}::${id || ""}`;

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

// exported only so the matching rules can be unit-tested
export const __test = { judgeCandidate, scriptOk, titleSimilarity, artistMatches, titleVariants, cleanArtist, normalize };
