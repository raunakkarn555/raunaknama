import {
  searchCache,
  getCached,
  setCached,
  authArgs,
  spawnYtDlp,
  cookieAwareErrorDetails,
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

  const { code, stdoutData, stderrData } = await spawnYtDlp([
    "-J",
    "--flat-playlist",
    "--no-warnings",
    ...authArgs(),
    `ytsearch12:${q}`,
  ]);

  if (code !== 0) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify({
        error: "Failed to search YouTube",
        details: cookieAwareErrorDetails(stderrData),
      }),
    };
  }

  try {
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
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify({ error: "Failed to parse search response" }),
    };
  }
};
