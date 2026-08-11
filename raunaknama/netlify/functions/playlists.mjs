import { PLAYLISTS, CORS_HEADERS } from "./_shared/ytdlpService.mjs";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify({
      playlists: PLAYLISTS.map(({ id, label }) => ({ id, label })),
    }),
  };
};
