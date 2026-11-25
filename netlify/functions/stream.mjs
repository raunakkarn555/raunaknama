import { resolveStreamFast } from "./_shared/streamResolver.mjs";
import { createProxyToken, needsProxy } from "./_shared/audioProxyToken.mjs";
import { isGooglevideo } from "./_shared/googlevideo.mjs";

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

// YTJS_IOS / YTJS_MWEB (and legacy IOS) googlevideo URLs are bound to the
// client User-Agent that extracted them: a browser <audio> element requesting
// them directly gets 403. For those we hand the player a signed URL of our own
// streaming proxy (audio-proxy.mjs), which replays the right User-Agent and
// forwards Range requests. Other clients' URLs are returned untouched.
function originOf(event) {
  try {
    if (event.rawUrl) return new URL(event.rawUrl).origin;
  } catch { /* fall through */ }
  const h = event.headers || {};
  const host = h["x-forwarded-host"] || h.host;
  if (!host) return "";
  const proto = h["x-forwarded-proto"] || (/^(localhost|127\.|\[::1\])/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}

// Direct googlevideo url first (the browser plays it as-is); the signed
// audio-proxy url rides along as the first backup. AUDIO_PROXY_CLIENTS can
// still force the proxy to be primary for specific clients.
function playable(hit, origin, videoId) {
  const proxyUrl = () => {
    const token = createProxyToken({ url: hit.url, userAgent: hit.userAgent, videoId, client: hit.client });
    return `${origin}/.netlify/functions/audio-proxy?t=${token}`;
  };
  // HLS via audio-proxy (rewritten audio-only playlist); the plain url rides along as backup.
  if (hit.type === "hls" && hit.hlsProxy) {
    const t = createProxyToken({ url: hit.url, userAgent: hit.userAgent, videoId, client: hit.client, kind: "hls", ttlMs: 3 * 60 * 60 * 1000 });
    const alt = hit.alt && isGooglevideo(hit.alt.url)
      ? { url: `${origin}/.netlify/functions/audio-proxy?t=${createProxyToken({ url: hit.alt.url, userAgent: hit.alt.userAgent, videoId, client: hit.alt.client })}`, client: `${hit.alt.client}+PROXY` }
      : null;
    return { url: `${origin}/.netlify/functions/audio-proxy?t=${t}`, proxied: true, proxyBackup: alt };
  }
  // HLS manifests (yt-dlp last resort) are played by hls.js directly.
  if (hit.type === "hls") return { url: hit.url, proxied: false, proxyBackup: null };
  if (needsProxy(hit.client)) return { url: proxyUrl(), proxied: true, proxyBackup: null };
  const canProxy = origin && hit.userAgent !== undefined && isGooglevideo(hit.url);
  return {
    url: hit.url,
    proxied: false,
    proxyBackup: canProxy ? { url: proxyUrl(), client: `${hit.client}+PROXY` } : null,
  };
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
    const { client, fallbacks = [] } = hit;
    const { url, proxied, proxyBackup } = playable(hit, originOf(event), String(token || ""));
    const backups = [...(proxyBackup ? [proxyBackup] : []), ...fallbacks];

    // ?json=1 -> same fast resolver, but hands the URL back as JSON so the
    // player can set audio.src itself (and cache it) instead of following a redirect.
    if (wantJson) {
      const res = json(200, { url, type: hit.type === "hls" ? "hls" : "direct", source: "fast", client, proxied, fallbacks: backups.map((f) => ({ url: f.url, type: "direct", client: f.client })) });
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
