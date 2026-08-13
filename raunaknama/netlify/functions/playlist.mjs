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
    // BUG FIX: `--no-warnings` was previously set here on the (incorrect)
    // assumption that yt-dlp's warning text could leak into the same
    // stdout stream we JSON.parse below. It doesn't — yt-dlp writes
    // WARNING/ERROR lines to stderr, which spawnYtDlp already captures
    // separately from stdout. Suppressing warnings just threw away the
    // one piece of diagnostic text (e.g. "Sign in to confirm you're not a
    // bot", PO-token/player-client fallback notices) that explains *why*
    // a request came back empty, which is exactly what produced the
    // unhelpful generic "no output and no error" message.
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
