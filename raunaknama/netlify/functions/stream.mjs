import {
  streamUrlCache,
  getCached,
  setCached,
  authArgs,
  spawnYtDlp,
  cookieAwareErrorDetails,
  STREAM_CACHE_TTL_MS,
  CORS_HEADERS,
} from "./_shared/ytdlpService.mjs";

// Format selector, in priority order:
//   1. m4a audio that is NOT served over HLS ([protocol!*=m3u8]) — this is
//      the fast path: a single progressive/DASH URL the <audio> element (or
//      a direct fetch) can play with zero extra JS.
//   2. Any other non-HLS bestaudio (webm/opus etc).
//   3. As of 2026, YouTube increasingly only exposes audio via HLS for a
//      growing share of videos (anti-bot hardening removed the old
//      direct-URL formats for those). If that's all that's available, fall
//      back to bestaudio even if it IS HLS — the frontend knows how to play
//      that via hls.js, it's just a different code path.
const FORMAT_SELECTOR =
  "ba[ext=m4a][protocol!*=m3u8]/ba[protocol!*=m3u8]/ba[ext=m4a]/bestaudio";

function isHlsFormat(info) {
  const protocol = String(info?.protocol || "");
  const url = String(info?.url || "");
  return protocol.includes("m3u8") || url.includes(".m3u8") || info?.ext === "m3u8";
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  const { id, retry } = event.queryStringParameters || {};

  if (!id) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify({ error: "Track ID parameter required" }),
    };
  }

  // A forced retry (frontend calls this after a resolved URL turned out to
  // be unplayable in the browser — throttled/gated CDN URL, a known
  // YouTube anti-bot pattern) deliberately skips the cache: the whole point
  // is to get a different, hopefully-working result instead of the same
  // broken one.
  const isRetry = retry === "1";

  const cached = isRetry ? null : getCached(streamUrlCache, id);
  if (cached) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify(cached),
    };
  }

  const videoUrl = `https://www.youtube.com/watch?v=${id}`;
  console.log(`Extracting audio stream info for track ID: ${id}${isRetry ? " (forced retry)" : ""}`);

  const args = [
    "-f", FORMAT_SELECTOR,
    "-j", // dump-json: gives us both the resolved URL and its protocol/ext
    "--no-warnings",
    // On a forced retry, ask yt-dlp for a different player client than its
    // default choice. The default (usually "web") is the one most affected
    // by YouTube's SABR/PO-token gating, which can produce a URL that
    // resolves fine server-side but a browser can't actually fetch. "ios"
    // and "android" clients are far less likely to hand back a gated URL.
    ...(isRetry ? ["--extractor-args", "youtube:player_client=ios,android"] : []),
    ...authArgs(),
    videoUrl,
  ];

  try {
    const { code, stdoutData, stderrData } = await spawnYtDlp(args);

    if (code !== 0 || !stdoutData.trim()) {
      console.error(`Error resolving audio stream for track ${id}:`, stderrData);
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        body: JSON.stringify({
          error: "Failed to extract playable audio stream for this track",
          details: cookieAwareErrorDetails(stderrData),
        }),
      };
    }

    let info;
    try {
      info = JSON.parse(stdoutData.trim().split("\n")[0]);
    } catch (parseErr) {
      console.error(`Failed to parse yt-dlp JSON for track ${id}:`, parseErr.message);
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        body: JSON.stringify({ error: "Could not parse stream info from yt-dlp" }),
      };
    }

    if (!info?.url) {
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        body: JSON.stringify({ error: "yt-dlp did not return a playable URL" }),
      };
    }

    const payload = {
      url: info.url,
      type: isHlsFormat(info) ? "hls" : "direct",
      ext: info.ext || null,
    };

    // Cache resolved stream info for 2 hours (YouTube CDN URLs last ~6h).
    setCached(streamUrlCache, id, payload, STREAM_CACHE_TTL_MS);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    // Without this catch, a rejected promise here (e.g. the yt-dlp binary
    // bootstrap failing) crashes the whole invocation and Netlify returns a
    // generic HTML error page — which is what broke JSON parsing on the
    // frontend. Always return real JSON instead.
    console.error(`Unhandled stream error for track ${id}:`, err);
    return {
      statusCode: err.status || 500,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify({ error: err.message || "Unexpected streaming error" }),
    };
  }
};
