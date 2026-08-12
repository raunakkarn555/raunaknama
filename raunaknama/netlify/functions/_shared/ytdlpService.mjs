import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import https from "https";

// NOTE: this file deliberately does NOT import anything from the
// `ytdlp-nodejs` package. That package resolves its own binary path using
// `import.meta.url` at module-load time, which breaks the instant Netlify's
// function bundler processes it (import.meta.url becomes undefined once
// bundled, so the package throws on import, before any of our code runs).
// See scripts/download-ytdlp.mjs for the full explanation and how the
// binary actually gets onto disk. We just spawn it directly here.

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

// Extra args appended to every yt-dlp call.
//
// NOTE: this used to force `--extractor-args youtube:player_client=ios,android,web`.
// That's a mistake to hardcode — yt-dlp's own maintainers actively add/remove
// player clients as YouTube breaks them (e.g. ios_downgraded and tv_embedded
// were both pulled as broken in early 2026 releases), and scripts/download-ytdlp.mjs
// always fetches the *latest* yt-dlp release on install. Pinning our own client
// list here means we silently fight yt-dlp's own up-to-date defaults instead of
// benefiting from them. So: let yt-dlp choose.
export function authArgs() {
  const args = ["--js-runtimes", "node"];
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
// Same platform -> filename map as scripts/download-ytdlp.mjs (kept in sync
// manually since this file must avoid any extra local imports that could
// themselves rely on import.meta — see the note at the top of this file).
const PLATFORM_MAP = {
  win32: { x64: "yt-dlp.exe", ia32: "yt-dlp_x86.exe", arm64: "yt-dlp_arm64.exe" },
  linux: { x64: "yt-dlp_linux", arm64: "yt-dlp_linux_aarch64", aarch64: "yt-dlp_linux_aarch64" },
  darwin: { x64: "yt-dlp_macos", arm64: "yt-dlp_macos" },
};

function binaryFilename() {
  const byPlatform = PLATFORM_MAP[process.platform];
  const filename = byPlatform?.[process.arch];
  if (!filename) {
    throw new Error(`No yt-dlp build available for ${process.platform}/${process.arch}`);
  }
  return filename;
}

// scripts/download-ytdlp.mjs (npm postinstall) downloads the binary into
// <repo>/netlify/functions/_shared/bin/. netlify.toml's `included_files`
// ships that whole folder with the deployed function. At runtime,
// process.cwd() for a Netlify Function resolves to the deployed bundle's
// base directory, which mirrors the repo layout for included files — so a
// process.cwd()-relative path (never import.meta) is what we use to find it.
function candidatePaths(filename) {
  return [
    path.join(process.cwd(), "netlify", "functions", "_shared", "bin", filename),
    path.join(process.cwd(), "_shared", "bin", filename), // some bundler layouts flatten this
    path.join(process.cwd(), "bin", filename),
  ];
}

const TMP_YTDLP_PATH = path.join(os.tmpdir(), "yt-dlp_bin");

function findBundledBinary() {
  let filename;
  try {
    filename = binaryFilename();
  } catch {
    return null;
  }
  for (const candidate of candidatePaths(filename)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function downloadToTmp() {
  return new Promise((resolve, reject) => {
    let filename;
    try {
      filename = binaryFilename();
    } catch (err) {
      reject(err);
      return;
    }
    const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${filename}`;
    const file = fs.createWriteStream(TMP_YTDLP_PATH);
    const req = https.get(url, { headers: { "User-Agent": "raunaknama-fn" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        https
          .get(res.headers.location, { headers: { "User-Agent": "raunaknama-fn" } }, (res2) => {
            res2.pipe(fs.createWriteStream(TMP_YTDLP_PATH));
            res2.on("end", () => {
              fs.chmodSync(TMP_YTDLP_PATH, 0o755);
              resolve(TMP_YTDLP_PATH);
            });
            res2.on("error", reject);
          })
          .on("error", reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        reject(new Error(`Download failed: ${res.statusCode} ${res.statusMessage}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => {
        file.close(() => {
          fs.chmodSync(TMP_YTDLP_PATH, 0o755);
          resolve(TMP_YTDLP_PATH);
        });
      });
    });
    req.on("error", reject);
  });
}

let ytdlpReadyPromise = null;

async function ensureYtDlp() {
  if (!ytdlpReadyPromise) {
    ytdlpReadyPromise = (async () => {
      // 1. Bundled binary (shipped via netlify.toml's included_files) —
      //    fastest path, no network I/O at all.
      const bundled = findBundledBinary();
      if (bundled) return bundled;

      // 2. Already downloaded to /tmp by a previous invocation on this warm
      //    container.
      if (fs.existsSync(TMP_YTDLP_PATH)) return TMP_YTDLP_PATH;

      console.warn(
        "yt-dlp binary not found at expected path — this usually means " +
          "`npm install` hasn't finished running scripts/download-ytdlp.mjs, " +
          "or netlify.toml's `included_files` didn't ship it. Attempting a " +
          "runtime download to " + os.tmpdir() + " as a fallback (slower " +
          "first request)."
      );

      try {
        return await downloadToTmp();
      } catch (err) {
        const bootErr = new Error(
          "Could not locate or download the yt-dlp binary: " + err.message
        );
        bootErr.status = 500;
        throw bootErr;
      }
    })();
    // Don't cache a rejected promise — let the next request retry.
    ytdlpReadyPromise.catch(() => { ytdlpReadyPromise = null; });
  }
  return ytdlpReadyPromise;
}

// Hard ceiling on any single yt-dlp invocation. Netlify's default function
// timeout is short; if yt-dlp hangs (blocked network, bad cookies, etc.) we
// want to kill it and return a real JSON error well before that, rather
// than letting Netlify itself kill the function and return an HTML error
// page.
const YTDLP_TIMEOUT_MS = 9000;

export function spawnYtDlp(args) {
  return ensureYtDlp().then(
    (ytdlpPath) =>
      new Promise((resolve, reject) => {
        const ytdlp = spawn(ytdlpPath, args);

        let stdoutData = "";
        let stderrData = "";
        let settled = false;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          ytdlp.kill("SIGKILL");
          resolve({
            code: 124,
            stdoutData,
            stderrData: stderrData + "\n[timed out after " + YTDLP_TIMEOUT_MS + "ms]",
          });
        }, YTDLP_TIMEOUT_MS);

        ytdlp.stdout.on("data", (chunk) => { stdoutData += chunk; });
        ytdlp.stderr.on("data", (chunk) => { stderrData += chunk.toString(); });

        ytdlp.on("error", (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });

        ytdlp.on("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ code, stdoutData, stderrData });
        });
      })
  );
}

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
