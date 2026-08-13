import {
  searchCache,
  getCached,
  setCached,
  authArgs,
  spawnYtDlpJsonWithRetry,
  CORS_HEADERS,
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
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify(cached),
    };
  }

  try {
    const parsed = await spawnYtDlpJsonWithRetry([
      "-J",
      "--flat-playlist",
      // BUG FIX: see the matching note in playlist.mjs — warnings go to
      // stderr, not stdout, so `--no-warnings` was only hiding the real
      // diagnostic text, not protecting the JSON parse.
      ...authArgs(),
      `ytsearch12:${q}`,
    ]);

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
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    // Covers both JSON.parse failures and any rejection from
    // spawnYtDlpJsonWithRetry (e.g. the yt-dlp binary bootstrap failing) —
    // always answer with real JSON instead of letting Netlify's generic
    // HTML error page leak through to the frontend.
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
