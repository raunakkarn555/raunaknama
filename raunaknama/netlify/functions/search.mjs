import {
  searchCache,
  getCached,
  setCached,
  authArgs,
  spawnYtDlp,
  cookieAwareErrorDetails,
  CORS_HEADERS, CDN_CACHE,
} from "./_shared/ytdlpService.mjs";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  const { q } = event.queryStringParameters || {};

  if (!q || !q.trim()) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify({ error: "Query parameter 'q' is required" }),
    };
  }

  const cacheKey = q.trim().toLowerCase();
  const cached = getCached(searchCache, cacheKey);
  if (cached) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": CDN_CACHE, ...CORS_HEADERS },
      body: JSON.stringify(cached),
    };
  }

  try {
    const { code, stdoutData, stderrData } = await spawnYtDlp([
      "-J",
      "--flat-playlist",
      "--no-warnings",
      ...authArgs(),
      `ytsearch12:${q}`,
    ]);

    // BUG FIX: previously this only checked `code !== 0`. When yt-dlp
    // exits 0 with empty stdout (YouTube silently blocking/rate-limiting
    // this server's IP is the usual cause — see ytdlpService.mjs), control
    // fell through to `JSON.parse(stdoutData)` below, which threw on the
    // empty string, landed in the generic catch, and returned only
    // `err.message` — stderrData (the actual reason) was discarded
    // entirely, never even logged. Matches the same fix in playlist.mjs.
    if (code !== 0 || !stdoutData.trim()) {
      const details = stderrData?.trim()
        ? cookieAwareErrorDetails(stderrData)
        : "yt-dlp produced no output and no error message. This almost always " +
          "means YouTube silently blocked or rate-limited requests from this " +
          "server's IP address. Set YTDLP_COOKIES_B64 (or YTDLP_COOKIES_PATH) " +
          "to a valid YouTube cookies.txt export to fix this.";
      console.error("[search] yt-dlp failed (code=" + code + "):", details);
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        body: JSON.stringify({ error: "Failed to search YouTube", details }),
      };
    }

    const parsed = JSON.parse(stdoutData);
    const results = (parsed.entries || []).map((item) => ({
      id: item.id,
      title: item.title,
      channel: item.uploader || item.channel || "",
      duration: item.duration,
    }));

    const payload = { query: q, results };
    setCached(searchCache, cacheKey, payload);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": CDN_CACHE, ...CORS_HEADERS },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    // Covers both JSON.parse failures and any rejection from spawnYtDlp
    // (e.g. the yt-dlp binary bootstrap failing) — always answer with real
    // JSON instead of letting Netlify's generic HTML error page leak
    // through to the frontend.
    console.error("Search error:", err);
    return {
      statusCode: err.status || 500,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify({
        error: err.message || "Failed to parse search response",
        details: err.details,
      }),
    };
  }
};
