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

  // BUG FIX: this used to only check `code !== 0` here, and treated an
  // empty-but-exit-0 stdout as a *separate* "failed to parse" case further
  // below — one that never looked at stderrData at all. In practice
  // YouTube very often blocks/rate-limits requests coming from a cloud
  // server IP (Netlify's) in a way yt-dlp reports as a *warning* rather
  // than a hard error (e.g. "Sign in to confirm you're not a bot"), so
  // yt-dlp still exits 0 — just having printed nothing to stdout, with the
  // one piece of information that explains why sitting in stderrData. The
  // old code silently dropped that (only console.error'd it, never put it
  // in `details`), so the frontend — and anyone debugging this — only ever
  // saw the meaningless "returned empty output" message and never the
  // actual reason. `stream.mjs` already got this right (see its
  // `code !== 0 || !stdoutData.trim()` check); this now matches it.
  if (code !== 0 || !stdoutData.trim()) {
    const err = new Error("Failed to fetch playlist metadata");
    err.status = 502;
    err.details = stderrData?.trim()
      ? cookieAwareErrorDetails(stderrData)
      : "yt-dlp produced no output and no error message. This almost always " +
        "means YouTube silently blocked or rate-limited requests from this " +
        "server's IP address. Set YTDLP_COOKIES_B64 (or YTDLP_COOKIES_PATH) " +
        "to a valid YouTube cookies.txt export to fix this.";
    console.error("[playlist] yt-dlp failed (code=" + code + "):", err.details);
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
    // We only get here now when stdoutData had *some* content but it
    // wasn't valid JSON (e.g. stray warning text mixed in) — the
    // exit-0-with-truly-empty-stdout case is now handled above, where
    // stderrData actually gets surfaced.
    console.error("[playlist] yt-dlp exited 0 but stdout wasn't valid JSON.");
    console.error("[playlist] stdout (first 1000 chars):", stdoutData.slice(0, 1000));
    if (stderrData) console.error("[playlist] stderr (first 1000 chars):", stderrData.slice(0, 1000));

    const parseErr = new Error("Failed to parse playlist response");
    parseErr.status = 500;
    const snippet = (stdoutData || "").trim().slice(0, 300);
    parseErr.details = stderrData?.trim()
      ? `yt-dlp returned non-JSON output: "${snippet}" (stderr: ${stderrData.trim().slice(0, 300)})`
      : `yt-dlp returned non-JSON output: "${snippet}"`;
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
