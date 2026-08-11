const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const { YtDlp, helpers } = require("ytdlp-nodejs");
const fs = require("fs");
const os = require("os");
const path = require("path");

const app = express();
app.use(cors());

const ytdlpClient = new YtDlp();
let YTDLP_PATH = ytdlpClient.binaryPath;
const PLAYLIST_URL = "https://youtube.com/playlist?list=PLP1mkQtMYc3s";

// ---------------------------------------------------------------------------
// YouTube cookies (REQUIRED on hosts like Render / AWS / GCP)
// ---------------------------------------------------------------------------
function resolveCookiesPath() {
  if (process.env.YTDLP_COOKIES_PATH && fs.existsSync(process.env.YTDLP_COOKIES_PATH)) {
    try {
      const tmpPath = path.join(os.tmpdir(), "yt-cookies.txt");
      fs.copyFileSync(process.env.YTDLP_COOKIES_PATH, tmpPath);
      console.log(`Using cookies from YTDLP_COOKIES_PATH -> ${tmpPath}`);
      return tmpPath;
    } catch (err) {
      console.error("Failed to copy YTDLP_COOKIES_PATH:", err.message);
    }
  }

  if (process.env.YTDLP_COOKIES_B64) {
    try {
      const decoded = Buffer.from(process.env.YTDLP_COOKIES_B64, "base64").toString("utf8");
      const tmpPath = path.join(os.tmpdir(), "yt-cookies.txt");
      fs.writeFileSync(tmpPath, decoded, "utf8");
      console.log("Loaded YouTube cookies from YTDLP_COOKIES_B64");
      return tmpPath;
    } catch (err) {
      console.error("Failed to decode YTDLP_COOKIES_B64:", err.message);
    }
  }

  console.warn("⚠️ No YouTube cookies configured. Server may be blocked on cloud IPs.");
  return null;
}

const COOKIES_PATH = resolveCookiesPath();

// Balanced arguments to prevent format extraction failures on mobile/web clients
function authArgs() {
  const args = [
    "--extractor-args",
    "youtube:player_client=android,ios,web",
  ];
  if (COOKIES_PATH) {
    args.push("--cookies", COOKIES_PATH);
  }
  return args;
}

// ---------------------------------------------------------------------------
// In-memory Cache
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 20 * 60 * 1000; // 20 min
const playlistCache = new Map();
const searchCache = new Map();

function getCached(cache, key) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.data;
  if (hit) cache.delete(key);
  return null;
}

function setCached(cache, key, data) {
  cache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

function cookieAwareErrorDetails(stderrData) {
  if (/Sign in to confirm/i.test(stderrData)) {
    return COOKIES_PATH
      ? "YouTube rejected requests. Cookies file may be expired or invalid."
      : "YouTube blocked this cloud IP. Pass YTDLP_COOKIES_B64 or YTDLP_COOKIES_PATH.";
  }
  return stderrData;
}

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
  res.json({ playlists: PLAYLISTS.map(({ id, label }) => ({ id, label })) });
});

function fetchPlaylist(selected) {
  const cached = getCached(playlistCache, selected.id);
  if (cached) return Promise.resolve(cached);

  return new Promise((resolve, reject) => {
    const ytdlp = spawn(YTDLP_PATH, ["-J", "--flat-playlist", ...authArgs(), selected.url]);

    let stdoutData = "";
    let stderrData = "";

    ytdlp.stdout.on("data", (chunk) => { stdoutData += chunk; });
    ytdlp.stderr.on("data", (chunk) => { stderrData += chunk.toString(); });

    ytdlp.on("close", (code) => {
      if (code !== 0) {
        reject(Object.assign(new Error("Failed to fetch playlist"), {
          status: 500,
          details: cookieAwareErrorDetails(stderrData),
        }));
        return;
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
        resolve(payload);
      } catch (err) {
        reject(Object.assign(new Error("Failed to parse playlist response"), { status: 500 }));
      }
    });
  });
}

app.get("/api/playlist", (req, res) => {
  const { playlistId } = req.query;
  const selected = PLAYLISTS.find((p) => p.id === playlistId) || PLAYLISTS[0];

  fetchPlaylist(selected)
    .then((payload) => res.json(payload))
    .catch((err) => res.status(err.status || 500).json({ error: err.message, details: err.details }));
});

app.get("/api/search", (req, res) => {
  const { q } = req.query;
  if (!q || !q.trim()) return res.status(400).json({ error: "Query 'q' required" });

  const cacheKey = q.trim().toLowerCase();
  const cached = getCached(searchCache, cacheKey);
  if (cached) return res.json(cached);

  const ytdlp = spawn(YTDLP_PATH, [
    "-J",
    "--flat-playlist",
    "--no-warnings",
    ...authArgs(),
    `ytsearch12:${q}`,
  ]);

  let stdoutData = "";
  let stderrData = "";

  ytdlp.stdout.on("data", (chunk) => { stdoutData += chunk; });
  ytdlp.stderr.on("data", (chunk) => { stderrData += chunk.toString(); });

  ytdlp.on("close", (code) => {
    if (res.headersSent) return;
    if (code !== 0) {
      return res.status(500).json({
        error: "Failed to search YouTube",
        details: cookieAwareErrorDetails(stderrData),
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

      const payload = { query: q, results };
      setCached(searchCache, cacheKey, payload);
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: "Failed to parse search response" });
    }
  });
});

// -------------------------------------------------------------------------
// STREAMING ENDPOINT (FIXED)
// -------------------------------------------------------------------------
// Universal format list that will never crash with "Requested format is not available"
const STREAM_FORMATS = [
  { selector: "bestaudio/ba/best", contentType: "audio/webm" },
  { selector: "worstaudio/worst", contentType: "audio/webm" },
];

app.get("/api/stream", (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: "Track ID parameter required" });

  const videoUrl = `https://www.youtube.com/watch?v=${id}`;
  console.log(`Streaming audio for track ID: ${id}`);

  res.setHeader("Accept-Ranges", "none");
  res.setHeader("Cache-Control", "no-store");

  let currentChild = null;
  let clientClosed = false;
  let lastStderr = "";

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
      if (!res.headersSent) {
        res.status(500).json({
          error: "No playable audio stream found for this track",
          details: cookieAwareErrorDetails(lastStderr),
        });
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
      ...authArgs(),
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

    ytdlp.on("close", (code) => {
      if (clientClosed) return;

      if (!gotBytes) {
        lastStderr = stderrData;
        console.warn(`Format "${format.selector}" unavailable for ${id}, trying fallback.`);
        tryFormat(formatIndex + 1);
        return;
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
    console.log("Downloading yt-dlp binary...");
    YTDLP_PATH = await helpers.downloadYtDlp();
    ytdlpClient.binaryPath = YTDLP_PATH;
  }

  try {
    const result = await ytdlpClient.updateYtDlpAsync();
    console.log(`yt-dlp update status: OK, version: ${result.version || "latest"}`);
  } catch (err) {
    console.warn("yt-dlp self-update warning:", err.message);
  }

  app.listen(PORT, HOST, () => {
    console.log(`🎵 Audio server running on http://${HOST}:${PORT}`);
  });

  fetchPlaylist(PLAYLISTS[0]).catch(() => {});
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});