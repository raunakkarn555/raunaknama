import {
  PLAYLISTS,
  playlistCache,
  getCached,
  setCached,
  authArgs,
  spawnYtDlp,
  cookieAwareErrorDetails,
  CORS_HEADERS,
} from "./_shared/ytdlpService.mjs";

async function fetchPlaylist(selected) {
  const cached = getCached(playlistCache, selected.id);
  if (cached) return cached;

  const { code, stdoutData, stderrData } = await spawnYtDlp([
    "-J",
    "--flat-playlist",
    ...authArgs(),
    selected.url,
  ]);

  if (code !== 0) {
    const err = new Error("Failed to fetch playlist metadata");
    err.status = 500;
    err.details = cookieAwareErrorDetails(stderrData);
    throw err;
  }

  try {
    const parsed = JSON.parse(stdoutData);
    const tracks = (parsed.entries || []).map((item) => ({
      id: item.id,
      title: item.title,
      url: `https://www.youtube.com/watch?v=${item.id}`,
      duration: item.duration,
    }));

    const payload = {
      playlistId: selected.id,
      playlistTitle: parsed.title || selected.label || "YouTube Playlist",
      tracks: tracks,
    };

    setCached(playlistCache, selected.id, payload);
    return payload;
  } catch (err) {
    const parseErr = new Error("Failed to parse playlist response");
    parseErr.status = 500;
    throw parseErr;
  }
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  const { playlistId } = event.queryStringParameters || {};
  const selected = PLAYLISTS.find((p) => p.id === playlistId) || PLAYLISTS[0];

  try {
    const payload = await fetchPlaylist(selected);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    return {
      statusCode: err.status || 500,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify({ error: err.message, details: err.details }),
    };
  }
};
