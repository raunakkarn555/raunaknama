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
    // Without this, yt-dlp can print warning text (e.g. about a fallback
    // extractor client) into the same stdout stream we JSON.parse below,
    // corrupting it — this is what search.mjs already does, playlist.mjs
    // just didn't match it.
    "--no-warnings",
    ...authArgs(),
    selected.url,
  ]);

  if (code !== 0) {
    const err = new Error("Failed to fetch playlist metadata");
    err.status = 502;
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
    // stdoutData exited with code 0 but wasn't valid JSON — log the raw
    // output server-side (visible in Netlify's function logs) and also
    // return a snippet in `details` so the frontend can surface it,
    // instead of swallowing the one piece of information that actually
    // explains what went wrong.
    console.error("[playlist] yt-dlp exited 0 but stdout wasn't valid JSON.");
    console.error("[playlist] stdout (first 1000 chars):", stdoutData.slice(0, 1000));
    if (stderrData) console.error("[playlist] stderr (first 1000 chars):", stderrData.slice(0, 1000));

    const parseErr = new Error("Failed to parse playlist response");
    parseErr.status = 500;
    const snippet = (stdoutData || "").trim().slice(0, 300);
    parseErr.details = snippet
      ? `yt-dlp returned non-JSON output: "${snippet}"`
      : "yt-dlp exited successfully but returned empty output.";
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
