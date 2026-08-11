const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const { YtDlp, helpers } = require("ytdlp-nodejs");

const app = express();
app.use(cors());

// ---------------------------------------------------------------------------
// yt-dlp binary — previously a hardcoded local .exe path (Windows-only).
// ytdlp-nodejs normally downloads a yt-dlp binary for the current platform
// via its postinstall script. Some npm setups block package install scripts
// (e.g. npm's allowScripts), so as a fallback we download the binary
// ourselves here with the package's own helper if none was found. Either
// way, YTDLP_PATH ends up pointing at a real executable, and every
// spawn() call below is unchanged.
// ---------------------------------------------------------------------------
const ytdlpClient = new YtDlp();
let YTDLP_PATH = ytdlpClient.binaryPath;
const PLAYLIST_URL = "https://youtube.com/playlist?list=PLP1mkQtMYc3s";

// ---------------------------------------------------------------------------
// Playlist registry — the original single playlist stays first/default so
// any existing call to /api/playlist (no query params) behaves exactly as
// before. Two more playlists were added on request.
// ---------------------------------------------------------------------------
const PLAYLISTS = [
  { id: "default", label: "Saloon Classics", url: PLAYLIST_URL },
  {
    id: "playlist-2",
    label: "Retro Rewind",
    url: "https://youtube.com/playlist?list=PLMRKdK25AuPVjHl9Kdb-gkBy0Cm7Zi2xo",
  },
  {
    id: "playlist-3",
    label: "Golden Hits",
    url: "https://youtube.com/playlist?list=PL33748924FF32D510",
  },
];

// 0. List available playlists (id + label only — cheap, no yt-dlp call)
app.get("/api/playlists", (req, res) => {
  res.json({
    playlists: PLAYLISTS.map(({ id, label }) => ({ id, label })),
  });
});

// 1. Fetch Playlist Metadata
// Accepts an optional ?playlistId= query param to pick which registered
// playlist to load. When omitted, falls back to the original default
// playlist — so existing calls keep working unchanged.
app.get("/api/playlist", (req, res) => {
  const { playlistId } = req.query;
  const selected =
    PLAYLISTS.find((p) => p.id === playlistId) || PLAYLISTS[0];

  console.log(`Fetching playlist details from YouTube... (${selected.label})`);

  const ytdlp = spawn(YTDLP_PATH, [
    "-J",
    "--flat-playlist",
    selected.url
  ]);

  let stdoutData = "";
  let stderrData = "";

  ytdlp.stdout.on("data", (chunk) => {
    stdoutData += chunk;
  });

  ytdlp.stderr.on("data", (chunk) => {
    stderrData += chunk.toString();
  });

  ytdlp.on("close", (code) => {
    if (code !== 0) {
      console.error("yt-dlp process error:", stderrData);
      return res.status(500).json({ 
        error: "Failed to fetch playlist metadata", 
        details: stderrData 
      });
    }

    try {
      const parsed = JSON.parse(stdoutData);
      const tracks = (parsed.entries || []).map((item) => ({
        id: item.id,
        title: item.title,
        url: `https://www.youtube.com/watch?v=${item.id}`,
        duration: item.duration,
      }));

      res.json({
        playlistId: selected.id,
        playlistTitle: parsed.title || selected.label || "YouTube Playlist",
        tracks: tracks,
      });
    } catch (err) {
      console.error("JSON parse error:", err);
      res.status(500).json({ error: "Failed to parse playlist response" });
    }
  });
});

// 1b. Search YouTube for any song (independent of the registered playlists)
app.get("/api/search", (req, res) => {
  const { q } = req.query;

  if (!q || !q.trim()) {
    return res.status(400).json({ error: "Query parameter 'q' is required" });
  }

  console.log(`Searching YouTube for: ${q}`);

  const ytdlp = spawn(YTDLP_PATH, [
    "-J",
    "--flat-playlist",
    "--no-warnings",
    `ytsearch12:${q}`
  ]);

  let stdoutData = "";
  let stderrData = "";

  ytdlp.stdout.on("data", (chunk) => {
    stdoutData += chunk;
  });

  ytdlp.stderr.on("data", (chunk) => {
    stderrData += chunk.toString();
  });

  ytdlp.on("close", (code) => {
    if (code !== 0) {
      console.error("yt-dlp search error:", stderrData);
      return res.status(500).json({
        error: "Failed to search YouTube",
        details: stderrData,
      });
    }

    try {
      const parsed = JSON.parse(stdoutData);
      const results = (parsed.entries || []).map((item) => ({
        id: item.id,
        title: item.title,
        channel: item.uploader || item.channel || "",
        duration: item.duration,
      }));

      res.json({ query: q, results });
    } catch (err) {
      console.error("JSON parse error:", err);
      res.status(500).json({ error: "Failed to parse search response" });
    }
  });
});

// 2. Direct MP3 Audio Stream
app.get("/api/stream", (req, res) => {
  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ error: "Track ID parameter required" });
  }

  const videoUrl = `https://www.youtube.com/watch?v=${id}`;
  console.log(`Streaming audio for track ID: ${id}`);

  res.setHeader("Content-Type", "audio/mpeg");

  const ytdlp = spawn(YTDLP_PATH, [
    "-o", "-",
    "-f", "bestaudio/best",
    "--no-warnings",
    videoUrl
  ]);

  ytdlp.stdout.pipe(res);

  // Clean up spawn process if user closes tab or changes song
  req.on("close", () => {
    if (ytdlp && !ytdlp.killed) {
      ytdlp.kill();
    }
  });
});

// ---------------------------------------------------------------------------
// Listen — hosting platforms like Render/Railway/Fly assign the port via the
// PORT env var and require binding to 0.0.0.0 (not 127.0.0.1, which only
// accepts local connections and would make the service unreachable from
// outside the container). Locally, this still defaults to port 5000 exactly
// like before.
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || "0.0.0.0";

async function start() {
  // If ytdlp-nodejs's postinstall script didn't run (e.g. npm blocked it
  // via allowScripts) there will be no binary yet — download one now.
  if (!YTDLP_PATH || !require("fs").existsSync(YTDLP_PATH)) {
    console.log("yt-dlp binary not found — downloading it now (one-time setup)...");
    YTDLP_PATH = await helpers.downloadYtDlp();
    ytdlpClient.binaryPath = YTDLP_PATH;
    console.log(`yt-dlp binary ready at: ${YTDLP_PATH}`);
  }

  app.listen(PORT, HOST, () => {
    console.log(`🎵 Audio streaming server running on http://${HOST}:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});