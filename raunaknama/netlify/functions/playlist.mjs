import {
  PLAYLISTS,
  playlistCache,
  getCached,
  setCached,
  authArgs,
  spawnYtDlpJsonWithRetry,
  CORS_HEADERS,
} from "./_shared/ytdlpService.mjs";

async function fetchPlaylist(selected) {
  const cached = getCached(playlistCache, selected.id);
  if (cached) return cached;

  const parsed = await spawnYtDlpJsonWithRetry([
    "-J",
    "--flat-playlist",
    // Without this, yt-dlp can print warning text (e.g. about a fallback
    // extractor client) into the same stdout stream we JSON.parse below,
    // corrupting it — this is what search.mjs already does, playlist.mjs
    // just didn't match it.
    "--no-warnings",
    ...authArgs(),
    selected.url,
  ]);

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
