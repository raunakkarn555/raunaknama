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

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  const { id } = event.queryStringParameters || {};

  if (!id) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify({ error: "Track ID parameter required" }),
    };
  }

  // Check cache for existing YouTube CDN audio URL
  const cachedUrl = getCached(streamUrlCache, id);
  if (cachedUrl) {
    return {
      statusCode: 302,
      headers: { Location: cachedUrl, ...CORS_HEADERS },
      body: "",
    };
  }

  const videoUrl = `https://www.youtube.com/watch?v=${id}`;
  console.log(`Extracting direct audio URL for track ID: ${id}`);

  const args = [
    "-g",
    "-f", "ba[ext=m4a]/ba[acodec^=mp4a]/ba/bestaudio",
    "--no-warnings",
    ...authArgs(),
    videoUrl,
  ];

  try {
    const { code, stdoutData, stderrData } = await spawnYtDlp(args);

    if (code !== 0 || !stdoutData.trim()) {
      console.error(`Error resolving audio URL for track ${id}:`, stderrData);
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        body: JSON.stringify({
          error: "Failed to extract playable audio stream for this track",
          details: cookieAwareErrorDetails(stderrData),
        }),
      };
    }

    const directAudioUrl = stdoutData.trim().split("\n")[0];

    // Cache stream URL for 2 hours
    setCached(streamUrlCache, id, directAudioUrl, STREAM_CACHE_TTL_MS);

    return {
      statusCode: 302,
      headers: { Location: directAudioUrl, ...CORS_HEADERS },
      body: "",
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
