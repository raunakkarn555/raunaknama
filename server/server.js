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
let FFMPEG_PATH = ytdlpClient.ffmpegPath || helpers.findFFmpegBinary();
const PLAYLIST_URL = "https://youtube.com/playlist?list=PLP1mkQtMYc3s";

// ---------------------------------------------------------------------------
// YouTube cookies (REQUIRED on hosts like Render)
// ---------------------------------------------------------------------------
// "Sign in to confirm you're not a bot" is YouTube itself refusing
// datacenter/cloud IPs (Render, AWS, GCP, most VPS hosts) without a signed-in
// session — it is not a bug in this server. The only reliable fix is to give
// yt-dlp a real cookies.txt from a logged-in YouTube session. Two ways to
// supply it (see README for the full walkthrough):
//
//   1. YTDLP_COOKIES_PATH  -> path to a mounted secret file (Render "Secret
//      Files" is ideal for this — it writes the file to disk for you).
//   2. YTDLP_COOKIES_B64   -> the entire cookies.txt content, base64-encoded,
//      as a plain env var (safe for env vars since it has no newlines).
//
// Without either, we still try YouTube's Android client below, which
// sometimes avoids the bot check for a while — but it is not guaranteed and
// YouTube tightens this periodically, so cookies are the "sure shot" fix.
// ---------------------------------------------------------------------------
function resolveCookiesPath() {
  if (process.env.YTDLP_COOKIES_PATH && fs.existsSync(process.env.YTDLP_COOKIES_PATH)) {
    try {
      // Render's Secret Files (e.g. /etc/secrets/cookies.txt) are mounted
      // read-only. yt-dlp opens --cookies as a jar it both reads AND writes
      // back to after each run, so pointing it at the secret file directly
      // crashes with "Read-only file system". Copy it to a writable tmp
      // path first (mirrors what we do for YTDLP_COOKIES_B64 below).
      const tmpPath = path.join(os.tmpdir(), "yt-cookies.txt");
      fs.copyFileSync(process.env.YTDLP_COOKIES_PATH, tmpPath);
      console.log(`Using YouTube cookies from YTDLP_COOKIES_PATH (copied to writable tmp: ${tmpPath})`);
      return tmpPath;
    } catch (err) {
      console.error("Failed to copy YTDLP_COOKIES_PATH to a writable location:", err.message);
    }
  }

  if (process.env.YTDLP_COOKIES_B64) {
    try {
      const decoded = Buffer.from(process.env.YTDLP_COOKIES_B64, "base64").toString("utf8");
      const tmpPath = path.join(os.tmpdir(), "yt-cookies.txt");
      fs.writeFileSync(tmpPath, decoded, "utf8");
      console.log("Loaded YouTube cookies from YTDLP_COOKIES_B64 env var");
      return tmpPath;
    } catch (err) {
      console.error("Failed to decode YTDLP_COOKIES_B64:", err.message);
    }
  }

  console.warn(
    "⚠️  No YouTube cookies configured (YTDLP_COOKIES_PATH / YTDLP_COOKIES_B64). " +
    "YouTube will likely block this server with 'Sign in to confirm you're not a bot'. " +
    "See README for a 5-minute fix."
  );
  return null;
}

const COOKIES_PATH = resolveCookiesPath();

// Extra args appended to every yt-dlp call: spoof a client YouTube trusts
// more by default, and attach cookies when we have them.
//
// player_client widened from "android,web" to also include "ios" and "tv" —
// YouTube blocks/throttles individual clients independently (and this
// changes over time), so trying several in one call gives yt-dlp more
// chances to find a working format before we give up on a track.
function authArgs() {
  const args = ["--extractor-args", "youtube:player_client=android,ios,tv,web"];
  if (COOKIES_PATH) {
    args.push("--cookies", COOKIES_PATH);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Tiny in-memory cache so repeat page loads/tab switches are instant instead
// of re-running yt-dlp (which is the slow part of every request).
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 20 * 60 * 1000; // 20 minutes
const playlistCache = new Map(); // playlistId -> { data, expires }
const searchCache = new Map(); // query -> { data, expires }

function getCached(cache, key) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.data;
  if (hit) cache.delete(key);
  return null;
}

function setCached(cache, key, data) {
  cache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

// Turns yt-dlp's raw stderr into a clearer message when the failure is
// specifically YouTube's bot check, so it's obvious what to fix.
function cookieAwareErrorDetails(stderrData) {
  if (/Sign in to confirm/i.test(stderrData)) {
    return COOKIES_PATH
      ? "YouTube rejected this server even with cookies configured — the cookies file may be expired/invalid. Re-export cookies.txt and update YTDLP_COOKIES_B64 / YTDLP_COOKIES_PATH."
      : "YouTube is blocking this server's IP and asking for a signed-in session. Set YTDLP_COOKIES_B64 or YTDLP_COOKIES_PATH (see README) — this is required on most cloud hosts.";
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
  res.json({
    playlists: PLAYLISTS.map(({ id, label }) => ({ id, label })),
  });
});

// Fetches + caches one playlist. Returns the cached copy immediately when
// available (used by both the route handler and the startup pre-warm below).
function fetchPlaylist(selected) {
  const cached = getCached(playlistCache, selected.id);
  if (cached) return Promise.resolve(cached);

  console.log(`Fetching playlist details from YouTube... (${selected.label})`);

  return new Promise((resolve, reject) => {
    const ytdlp = spawn(YTDLP_PATH, ["-J", "--flat-playlist", ...authArgs(), selected.url]);

    let stdoutData = "";
    let stderrData = "";

    ytdlp.stdout.on("data", (chunk) => { stdoutData += chunk; });
    ytdlp.stderr.on("data", (chunk) => { stderrData += chunk.toString(); });

    ytdlp.on("error", (err) => {
      console.error("yt-dlp spawn error:", err);
      reject(Object.assign(new Error(err.message), { status: 500 }));
    });

    ytdlp.on("close", (code) => {
      if (code !== 0) {
        console.error("yt-dlp process error:", stderrData);
        reject(
          Object.assign(new Error("Failed to fetch playlist metadata"), {
            status: 500,
            details: cookieAwareErrorDetails(stderrData),
          })
        );
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
        console.error("JSON parse error:", err);
        reject(Object.assign(new Error("Failed to parse playlist response"), { status: 500 }));
      }
    });
  });
}

app.get("/api/playlist", (req, res) => {
  const { playlistId } = req.query;
  const selected =
    PLAYLISTS.find((p) => p.id === playlistId) || PLAYLISTS[0];

  fetchPlaylist(selected)
    .then((payload) => res.json(payload))
    .catch((err) => {
      res.status(err.status || 500).json({ error: err.message, details: err.details });
    });
});

app.get("/api/search", (req, res) => {
  const { q } = req.query;

  if (!q || !q.trim()) {
    return res.status(400).json({ error: "Query parameter 'q' is required" });
  }

  const cacheKey = q.trim().toLowerCase();
  const cached = getCached(searchCache, cacheKey);
  if (cached) {
    return res.json(cached);
  }

  console.log(`Searching YouTube for: ${q}`);

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
      // Exhausted every option — nothing we can do for this video.
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
        lastStderr = stderrData;
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

  // Self-update yt-dlp on every boot. This matters a lot more than it
  // looks: YouTube changes its internal player/extraction logic often
  // (roughly monthly), and a stale yt-dlp binary is the #1 real-world cause
  // of "no supported source found" / silent empty-format failures — it
  // fails quietly instead of with a clear "outdated" error. Since Render
  // free-tier instances spin up fresh, this keeps the binary current
  // without any manual redeploy step. Best-effort: never blocks startup.
  try {
    const result = await ytdlpClient.updateYtDlpAsync();
    console.log(`yt-dlp self-update OK (${result.method}), version: ${result.version || "unknown"}`);
  } catch (err) {
    console.warn("yt-dlp self-update failed (continuing with existing binary):", err.message);
  }

  // ffmpeg is no longer required: /api/stream now pipes YouTube's native
  // m4a/webm audio straight through with no transcoding step, so we don't
  // spend startup time downloading/verifying an ffmpeg binary anymore.

  app.listen(PORT, HOST, () => {
    console.log(`🎵 Audio streaming server running on http://${HOST}:${PORT}`);
  });

  // Fire-and-forget: warm the cache for the default playlist so the first
  // real visitor after a cold start doesn't wait on a fresh yt-dlp call.
  fetchPlaylist(PLAYLISTS[0]).catch((err) => {
    console.warn("Startup pre-warm of default playlist failed (will retry on first request):", err.message);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});