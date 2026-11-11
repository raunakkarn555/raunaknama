import { resolveStreamFast } from "./_shared/streamResolver.mjs";

// GET /api/stream?token=<mediaId>
//   -> 302/307 redirect to the highest-bitrate audio URL. Node never touches
//      the audio bytes: the browser's <audio> element follows the redirect and
//      issues its own Range requests (RFC 7233) straight to the CDN.
//
// GET /api/stream?id=<mediaId>   (legacy)
//   -> the old yt-dlp JSON response, so the existing Player.jsx keeps working
//      until it is migrated. The yt-dlp code is only loaded on that path.

const REDIRECT_STATUS = Number(process.env.STREAM_REDIRECT_STATUS) === 307 ? 307 : 302;
const CACHE_TTL_MS = 90 * 60 * 1000; // googlevideo URLs live ~6h
const MAX_CACHE_ENTRIES = 500;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Content-Type",
  "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length",
};

const cache = new Map(); // token -> { url, client, fallbacks, expires }
const inflight = new Map(); // key -> Promise<{url, client}|null>

// `fresh` bypasses the cache (a URL that just failed in the browser must not
// be handed out again) and `exclude` skips the client that produced it.
function resolveUrl(token, { fresh = false, exclude = [], fallback = false } = {}) {
  if (!fresh) {
    const hit = cache.get(token);
    if (hit && hit.expires > Date.now()) return Promise.resolve({ url: hit.url, client: hit.client, fallbacks: hit.fallbacks || [] });
  }

  // Concurrent clicks/hover-warmups for the same track share one upstream call.
  const key = fresh ? `${token}#fresh#${fallback ? "fb#" : ""}${exclude.join(",")}` : token;
  if (inflight.has(key)) return inflight.get(key);

  const p = resolveStreamFast(token, {
    exclude,
    fallback,
    // Piped answered after we already replied: attach it to the cached entry
    // so the next request for this track carries a backup URL.
    onLateFallback: (list) => {
      const e = cache.get(token);
      if (e && !(e.fallbacks || []).length) e.fallbacks = list;
    },
  })
    .then((hit) => {
      if (hit) {
        if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
        cache.set(token, { ...hit, expires: Date.now() + CACHE_TTL_MS });
      }
      return hit;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", ...CORS },
  body: JSON.stringify(body),
});

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }

  const { token, id, json: wantJson, fresh, exclude, fallback } = event.queryStringParameters || {};

  if (!token && id) {
    const legacy = await import("./_shared/legacyStream.mjs");
    return legacy.handler(event);
  }

  try {
    const hit = await resolveUrl(String(token || ""), {
      fresh: fresh === "1" || fallback === "true",
      fallback: fallback === "true",
      exclude: exclude ? String(exclude).split(",").filter(Boolean) : [],
    });
    if (!hit) return json(404, { error: "No audio format available for this track" });
    const { url, client, fallbacks = [] } = hit;

    // ?json=1 -> same fast resolver, but hands the URL back as JSON so the
    // player can set audio.src itself (and cache it) instead of following a redirect.
    if (wantJson) {
      const res = json(200, { url, type: "direct", source: "fast", client, fallbacks: fallbacks.map((f) => ({ url: f.url, type: "direct", client: f.client })) });
      // A forced/fresh lookup must never be served from a browser/CDN cache.
      res.headers["Cache-Control"] = fresh === "1" || fallback === "true" ? "no-store" : "private, max-age=300";
      return res;
    }

    return {
      statusCode: REDIRECT_STATUS,
      headers: {
        Location: url,
        // Lets the browser skip this function entirely on a repeat click.
        "Cache-Control": "private, max-age=300",
        ...CORS,
      },
      body: "",
    };
  } catch (err) {
    return json(err.statusCode === 400 ? 400 : 502, { error: err.message });
  }
};
