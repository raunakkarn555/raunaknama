import {
  streamUrlCache,
  getCached,
  setCached,
  authArgs,
  spawnYtDlp,
  cookieAwareErrorDetails,
  STREAM_CACHE_TTL_MS,
  CORS_HEADERS,
} from "./ytdlpService.mjs";

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
//   4. Last resort: "best" (a combined video+audio format). A handful of
//      videos expose no audio-ONLY format to any client at all (yt-dlp then
//      errors with "Requested format is not available" even on "bestaudio",
//      which was previously the end of the chain and left those tracks
//      completely unplayable). An <audio>/<video> element can still play
//      just the audio track out of a combined file, so this recovers those
//      tracks instead of failing outright.
const FORMAT_SELECTOR =
  "ba[ext=m4a][protocol!*=m3u8]/ba[protocol!*=m3u8]/ba[ext=m4a]/bestaudio/best";

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

  // BUG FIX (root cause of the widespread "Requested format is not
  // available" failures reported Sept 2026): this used to hardcode
  // `--extractor-args youtube:player_client=ios,android` (and
  // `ios,android,tv_embedded` on retry). That made sense when it was
  // written, but YouTube's PO-token enforcement has since expanded to
  // cover the `ios` and `android` clients' format URLs too — as of mid/late
  // 2026 both clients frequently return zero downloadable formats without a
  // GVS PO token yt-dlp has no way to supply here, which is exactly what
  // "Requested format is not available" means (the FORMAT_SELECTOR's whole
  // chain, down to plain "best", had nothing to match against because the
  // *format list itself* came back empty for those clients). This bit
  // everyone, not just some tracks, which is why it reproduced on every
  // video ID.
  //
  // The fix is to stop hardcoding a client list at all and let yt-dlp use
  // its own built-in default (currently `tv,ios,web`, or `tv,web` when
  // cookies are present) — exactly the reasoning already documented on
  // authArgs() above, which this handler was inconsistently overriding.
  // yt-dlp's maintainers update that default with every release specifically
  // to track which clients still serve PO-token-free formats, and we always
  // run the latest nightly build (see scripts/download-ytdlp.mjs), so
  // deferring to it keeps this working without needing another manual fix
  // the next time YouTube shifts the goalposts.
  //
  // On a forced retry we do still override, but with "mweb" — the client
  // yt-dlp's own PO-token guide currently recommends as the fallback when
  // the default clients are having trouble, and one that benefits most from
  // the cookies we already attach via authArgs().
  const args = [
    "-f", FORMAT_SELECTOR,
    "-j", // dump-json: gives us both the resolved URL and its protocol/ext
    "--no-warnings",
    ...(isRetry ? ["--extractor-args", "youtube:player_client=mweb,tv_embedded"] : []),
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
