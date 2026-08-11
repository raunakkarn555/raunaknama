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

// 2. Direct native audio stream — NO ffmpeg transcoding
// -------------------------------------------------------------------------
// The old code forced yt-dlp to re-encode every track to mp3 (-x
// --audio-format mp3). On a low-CPU host (e.g. Render's free tier) that
// transcode is slow and can fail/time out mid-stream, so the browser gets
// truncated or empty bytes under an audio/mpeg header -> NotSupportedError.
//
// Fix: request YouTube's native audio-only format directly (m4a/AAC — every
// modern browser plays this natively) and pipe the raw bytes straight
// through with NO -x / --audio-format flag, so ffmpeg is never invoked.
// This starts almost instantly, even on very limited CPU.
//
// We try m4a first, and if a given video genuinely has no m4a track we
// fall back to yt-dlp's best audio-only pick (normally webm/opus) with a
// matching Content-Type, so playback still works instead of breaking.
// -------------------------------------------------------------------------
const STREAM_FORMATS = [
  { selector: "bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]", contentType: "audio/mp4" },
  { selector: "bestaudio[ext=webm]/bestaudio[acodec^=opus]", contentType: "audio/webm" },
  { selector: "bestaudio/best", contentType: "audio/webm" },
];

app.get("/api/stream", (req, res) => {
  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ error: "Track ID parameter required" });
  }

  const videoUrl = `https://www.youtube.com/watch?v=${id}`;
  console.log(`Streaming audio for track ID: ${id}`);

  // We never proxy byte-range requests to yt-dlp (it re-fetches from
  // scratch each time), so tell the browser up front not to expect them —
  // this avoids <audio> stalling while waiting on a 206 that never comes.
  res.setHeader("Accept-Ranges", "none");
  res.setHeader("Cache-Control", "no-store");

  let currentChild = null;
  let clientClosed = false;

  req.on("close", () => {
    clientClosed = true;
    if (currentChild && !currentChild.killed) {
      currentChild.kill("SIGKILL");
    }
  });

  const tryFormat = (formatIndex) => {
    if (clientClosed) return;

    const format = STREAM_FORMATS[formatIndex];
    if (!format) {
      // Exhausted every option — nothing we can do for this video.
      if (!res.headersSent) {
        res.status(500).json({ error: "No playable audio stream found for this track" });
      } else {
        res.end();
      }
      return;
    }

    const args = [
      "-o", "-",
      "-f", format.selector,
      "--no-warnings",
      "--no-part",
      "--no-playlist",
      videoUrl,
    ];

    const ytdlp = spawn(YTDLP_PATH, args);
    currentChild = ytdlp;

    let stderrData = "";
    let gotBytes = false;

    ytdlp.stdout.once("data", (firstChunk) => {
      gotBytes = true;
      if (!res.headersSent) {
        res.status(200);
        res.setHeader("Content-Type", format.contentType);
      }
      res.write(firstChunk);
      ytdlp.stdout.pipe(res);
    });

    ytdlp.stderr.on("data", (chunk) => {
      stderrData += chunk.toString();
    });

    ytdlp.on("error", (err) => {
      console.error("yt-dlp spawn error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to start yt-dlp", details: err.message });
      } else if (!res.writableEnded) {
        res.end();
      }
    });

    ytdlp.on("close", (code) => {
      if (clientClosed) return;

      if (!gotBytes) {
        // This format wasn't available for this particular video — fall
        // back to the next one instead of failing the whole request.
        console.warn(
          `Format "${format.selector}" unavailable for ${id}, trying fallback. yt-dlp said: ${stderrData.slice(-300)}`
        );
        tryFormat(formatIndex + 1);
        return;
      }

      if (code !== 0) {
        console.error("yt-dlp stream error mid-transfer:", stderrData.slice(-500));
      }
      if (!res.writableEnded) {
        res.end();
      }
    });
  };

  tryFormat(0);
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

  // ffmpeg is no longer required: /api/stream now pipes YouTube's native
  // m4a/webm audio straight through with no transcoding step, so we don't
  // spend startup time downloading/verifying an ffmpeg binary anymore.

  app.listen(PORT, HOST, () => {
    console.log(`🎵 Audio streaming server running on http://${HOST}:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});