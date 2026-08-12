// Quick sanity-check endpoint: hit /api/health directly in a browser tab
// after deploying. If this doesn't return JSON, the Netlify Functions
// aren't deployed at all (see README section 5) — that's a deployment/
// config problem, not a bug in playlists/playlist/search/stream.
import { CORS_HEADERS } from "./_shared/ytdlpService.mjs";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify({
      ok: true,
      message: "Netlify Functions are reachable.",
      hasCookies: Boolean(process.env.YTDLP_COOKIES_B64 || process.env.YTDLP_COOKIES_PATH),
      timestamp: new Date().toISOString(),
    }),
  };
};
