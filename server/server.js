const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const { YtDlp, helpers } = require("ytdlp-nodejs");
const fs = require("fs");

const app = express();
app.use(cors());

const ytdlpClient = new YtDlp();
let YTDLP_PATH = ytdlpClient.binaryPath;
let FFMPEG_PATH = ytdlpClient.ffmpegPath || helpers.findFFmpegBinary();
const PLAYLIST_URL = "https://youtube.com/playlist?list=PLP1mkQtMYc3s";

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

app.get("/api/playlists", (req, res) => {
  res.json({
    playlists: PLAYLISTS.map(({ id, label }) => ({ id, label })),
  });
});

app.get("/api/playlist", (req, res) => {
  const { playlistId } = req.query;
  const selected =
    PLAYLISTS.find((p) => p.id === playlistId) || PLAYLISTS[0];

  console.log(`Fetching playlist details from YouTube... (${selected.label})`);

  const ytdlp = spawn(YTDLP_PATH, ["-J", "--flat-playlist", selected.url]);

  let stdoutData = "";
  let stderrData = "";

  ytdlp.stdout.on("data", (chunk) => { stdoutData += chunk; });
  ytdlp.stderr.on("data", (chunk) => { stderrData += chunk.toString(); });

  ytdlp.on("error", (err) => {
    console.error("yt-dlp spawn error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to start yt-dlp", details: err.message });
    }
  });

  ytdlp.on("close", (code) => {
    if (res.headersSent) return;
    if (code !== 0) {
      console.error("yt-dlp process error:", stderrData);
      return res.status(500).json({
        error: "Failed to fetch playlist metadata",
        details: stderrData,
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

app.get("/api/search", (req, res) => {
  const { q } = req.query;

  if (!q || !q.trim()) {
    return res.status(400).json({ error: "Query parameter 'q' is required" });
  }

  console.log(`Searching YouTube for: ${q}`);

  const ytdlp = spawn(YTDLP_PATH, ["-J", "--flat-playlist", "--no-warnings", `ytsearch12:${q}`]);

  let stdoutData = "";
  let stderrData = "";

  ytdlp.stdout.on("data", (chunk) => { stdoutData += chunk; });
  ytdlp.stderr.on("data", (chunk) => { stderrData += chunk.toString(); });

  ytdlp.on("error", (err) => {
    console.error("yt-dlp spawn error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to start yt-dlp", details: err.message });
    }
  });

  ytdlp.on("close", (code) => {
    if (res.headersSent) return;
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
// -------------------------------------------------------------------------
// yt-dlp's raw "bestaudio" pick is almost always webm/opus or m4a, NOT mp3
// — but we declare Content-Type: audio/mpeg. That mismatch is exactly what
// makes browsers throw "NotSupportedError: no supported source" even
// though bytes ARE arriving. Fix: transcode to real mp3 via ffmpeg
// (-x --audio-format mp3) so the header always matches the actual bytes.
// -------------------------------------------------------------------------
app.get("/api/stream", (req, res) => {
  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ error: "Track ID parameter required" });
  }

  const videoUrl = `https://www.youtube.com/watch?v=${id}`;
  console.log(`Streaming audio for track ID: ${id}`);

  const args = [
    "-o", "-",
    "-f", "bestaudio/best",
    "-x",
    "--audio-format", "mp3",
    "--no-warnings",
  ];
  if (FFMPEG_PATH) {
    args.push("--ffmpeg-location", FFMPEG_PATH);
  }
  args.push(videoUrl);

  const ytdlp = spawn(YTDLP_PATH, args);

  let stderrData = "";
  let headerSent = false;

  ytdlp.stdout.once("data", () => {
    if (!res.headersSent) {
      res.setHeader("Content-Type", "audio/mpeg");
      headerSent = true;
    }
  });

  ytdlp.stdout.pipe(res);

  ytdlp.stderr.on("data", (chunk) => {
    stderrData += chunk.toString();
  });

  ytdlp.on("error", (err) => {
    console.error("yt-dlp spawn error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to start yt-dlp", details: err.message });
    } else {
      res.end();
    }
  });

  ytdlp.on("close", (code) => {
    if (code !== 0 && !headerSent && !res.headersSent) {
      console.error("yt-dlp stream error:", stderrData);
      res.status(500).json({ error: "Failed to stream audio", details: stderrData });
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  // Clean up spawn process if user closes tab or changes song
  req.on("close", () => {
    if (ytdlp && !ytdlp.killed) {
      ytdlp.kill();
    }
  });
});

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || "0.0.0.0";

async function start() {
  if (!YTDLP_PATH || !fs.existsSync(YTDLP_PATH)) {
    console.log("yt-dlp binary not found — downloading it now (one-time setup)...");
    YTDLP_PATH = await helpers.downloadYtDlp();
    ytdlpClient.binaryPath = YTDLP_PATH;
    console.log(`yt-dlp binary ready at: ${YTDLP_PATH}`);
  }

  if (!FFMPEG_PATH || !fs.existsSync(FFMPEG_PATH)) {
    console.log("ffmpeg binary not found — downloading it now (one-time setup)...");
    FFMPEG_PATH = await helpers.downloadFFmpeg();
    ytdlpClient.ffmpegPath = FFMPEG_PATH;
    console.log(`ffmpeg binary ready at: ${FFMPEG_PATH}`);
  }

  app.listen(PORT, HOST, () => {
    console.log(`🎵 Audio streaming server running on http://${HOST}:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});