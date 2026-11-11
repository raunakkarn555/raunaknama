// GET /api/artist?q=<search text>
//   -> { artist: { name, image, about, description, url } | null }
//
// Looks the query up on Wikipedia and returns the matching *musician* (photo +
// short bio). Returns { artist: null } when the query is not clearly an
// artist's name — e.g. a song title — so the UI only shows an artist card
// when it is confident.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE = 500;
const cache = new Map(); // normalized query -> { data, expires }

const MUSIC_RE =
  /\b(singer|vocalist|rapper|musician|composer|songwriter|playback|music director|record producer|disc jockey|dj|band|duo|guitarist|pianist|violinist|sitarist|qawwal|ghazal|lyricist)\b/i;
const NOT_PERSON_RE = /\b(song|film|album|single|soundtrack|television|series|ep|discography|tour|festival|award)\b/i;

const WORD_RE = /[\p{L}\p{N}]+/gu;
const tokens = (s) => (String(s || "").toLowerCase().match(WORD_RE) || []);
// Fillers people tack onto an artist search ("arijit singh songs").
const FILLER = new Set(["song", "songs", "gana", "gaane", "hits", "hit", "best", "top", "new", "latest", "mp3", "all", "singer", "music", "official"]);

function titleMatches(query, title) {
  const q = tokens(query).filter((t) => !FILLER.has(t));
  const t = tokens(String(title).replace(/\(.*?\)/g, " "));
  if (!q.length || !t.length) return false;
  if (q.join(" ") === t.join(" ")) return true; // exact name, even a short one ("KK")
  if (q.join("").length < 4) return false;
  // every word of the page title appears in the query ("arijit singh" in "arijit singh songs")
  if (t.every((w) => q.includes(w))) return true;
  // or the query is a (partial) name: "arijit", "lata mangesh"
  return q.every((w, i) => t.some((x) => x === w || (w.length >= 4 && x.startsWith(w) && i === q.length - 1)));
}

const json = (statusCode, body, extra = {}) => ({
  statusCode,
  headers: { "Content-Type": "application/json", ...CORS, ...extra },
  body: JSON.stringify(body),
});

async function wikiLookup(q) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: q,
    gsrlimit: "4",
    redirects: "1",
    prop: "pageimages|extracts|description|info",
    inprop: "url",
    piprop: "thumbnail",
    pithumbsize: "640",
    exintro: "1",
    explaintext: "1",
    exsentences: "6",
    exlimit: "max",
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Raunaknama/1.0 (personal radio site)", Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
    const data = await res.json();
    const pages = Object.values(data?.query?.pages || {}).sort((a, b) => (a.index || 99) - (b.index || 99));
    for (const p of pages) {
      const desc = p.description || "";
      const looksMusical = MUSIC_RE.test(desc) || (!desc && MUSIC_RE.test((p.extract || "").slice(0, 160)));
      if (!looksMusical || NOT_PERSON_RE.test(desc)) continue;
      if (!titleMatches(q, p.title)) continue;
      return {
        name: p.title.replace(/\s*\(.*?\)\s*$/, ""),
        image: p.thumbnail?.source || null,
        about: (p.extract || "").trim(),
        description: desc,
        url: p.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}`,
      };
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

  const q = String(event.queryStringParameters?.q || "").trim().slice(0, 80);
  if (q.length < 2) return json(200, { artist: null });

  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return json(200, { artist: hit.data }, { "Cache-Control": "public, max-age=3600" });

  try {
    const artist = await wikiLookup(q);
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(key, { data: artist, expires: Date.now() + CACHE_TTL_MS });
    return json(200, { artist }, { "Cache-Control": "public, max-age=3600" });
  } catch (err) {
    // Never break search over a missing artist card.
    console.warn("[artist] lookup failed:", err.message);
    return json(200, { artist: null });
  }
};
