import { spawn } from "child_process";
import { YtDlp, helpers } from "ytdlp-nodejs";
import fs from "fs";
import os from "os";
import path from "path";

const ytdlpClient = new YtDlp();
let YTDLP_PATH = ytdlpClient.binaryPath;

export const PLAYLIST_URL = "https://youtube.com/playlist?list=PLP1mkQtMYc3s";

export const PLAYLISTS = [
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

// ---------------------------------------------------------------------------
// YouTube Cookies Resolution (Required on Cloud/VPS Hosts like Netlify)
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

  console.warn("⚠️ No YouTube cookies configured (YTDLP_COOKIES_PATH / YTDLP_COOKIES_B64). Cloud IPs may get rate-limited.");
  return null;
}

const COOKIES_PATH = resolveCookiesPath();

// Extra args appended to every yt-dlp call
export function authArgs() {
  const args = [
    "--js-runtimes", "node",
    "--extractor-args", "youtube:player_client=ios,android,web",
  ];
  if (COOKIES_PATH) {
    args.push("--cookies", COOKIES_PATH);
  }
  return args;
}

// ---------------------------------------------------------------------------
// In-Memory Caches (persist only for the lifetime of a warm function instance)
// ---------------------------------------------------------------------------
export const CACHE_TTL_MS = 20 * 60 * 1000;
export const STREAM_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // Direct audio URLs last ~6 hours on YouTube CDN

export const playlistCache = new Map();
export const searchCache = new Map();
export const streamUrlCache = new Map();

export function getCached(cache, key) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.data;
  if (hit) cache.delete(key);
  return null;
}

export function setCached(cache, key, data, ttl = CACHE_TTL_MS) {
  cache.set(key, { data, expires: Date.now() + ttl });
}

export function cookieAwareErrorDetails(stderrData) {
  if (/Sign in to confirm/i.test(stderrData)) {
    return COOKIES_PATH
      ? "YouTube rejected requests with current cookies — re-export your cookies.txt file."
      : "YouTube blocked server IP. Please set YTDLP_COOKIES_B64 or YTDLP_COOKIES_PATH.";
  }
  return stderrData;
}

// ---------------------------------------------------------------------------
// yt-dlp binary bootstrap + spawn helper
// ---------------------------------------------------------------------------
let ytdlpReadyPromise = null;

async function ensureYtDlp() {
  if (!ytdlpReadyPromise) {
    ytdlpReadyPromise = (async () => {
      if (!YTDLP_PATH || !fs.existsSync(YTDLP_PATH)) {
        console.log("yt-dlp binary not found — downloading standard binary...");
        YTDLP_PATH = await helpers.downloadYtDlp();
        ytdlpClient.binaryPath = YTDLP_PATH;
      }

      try {
        const result = await ytdlpClient.updateYtDlpAsync();
        console.log(`yt-dlp self-update status: ${result.version || "ok"}`);
      } catch (err) {
        console.warn("yt-dlp self-update failed, using existing binary:", err.message);
      }

      return YTDLP_PATH;
    })();
  }
  return ytdlpReadyPromise;
}

export function spawnYtDlp(args) {
  return ensureYtDlp().then(
    (ytdlpPath) =>
      new Promise((resolve, reject) => {
        const ytdlp = spawn(ytdlpPath, args);

        let stdoutData = "";
        let stderrData = "";

        ytdlp.stdout.on("data", (chunk) => { stdoutData += chunk; });
        ytdlp.stderr.on("data", (chunk) => { stderrData += chunk.toString(); });

        ytdlp.on("error", reject);
        ytdlp.on("close", (code) => resolve({ code, stdoutData, stderrData }));
      })
  );
}

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
