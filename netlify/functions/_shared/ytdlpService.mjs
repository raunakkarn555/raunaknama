import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import https from "https";
import zlib from "zlib";

// AWS Lambda (Netlify Functions) is read-only except /tmp, so everything
// yt-dlp needs to WRITE — the cookie jar copy and its cache — lives there.
const TMP_DIR = fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();

// NOTE: this file deliberately does NOT import anything from the
// `ytdlp-nodejs` package. That package resolves its own binary path using
// `import.meta.url` at module-load time, which breaks the instant Netlify's
// function bundler processes it (import.meta.url becomes undefined once
// bundled, so the package throws on import, before any of our code runs).
// See scripts/download-ytdlp.mjs for the full explanation and how the
// binary actually gets onto disk. We just spawn it directly here.

export const PLAYLIST_URL = "https://youtube.com/playlist?list=PLP1mkQtMYc3s";

export const PLAYLISTS = [
  { id: "default", label: "Mohabbatnama", url: "https://youtube.com/playlist?list=PLP1mkQtMYc3s" },
  {
    id: "playlist-2",
    label: "Udasinama",
    url: "https://youtube.com/playlist?list=PLTBhTUi0uF84",
  },
  {
    id: "playlist-3",
    label: "Mastinama",
    url: "https://youtube.com/playlist?list=PLXonhj4a9frU",
  },
  {
    id: "playlist-4",
    label: "Oldnama",
    url: "https://youtube.com/playlist?list=PLUaT2mpNqhF8",
  },
  {
    id: "playlist-5",
    label: "GhazalNama",
    url: "https://youtube.com/playlist?list=PLH-kuQcGqUkw",
  },
  {
    id: "playlist-6",
    label: "RafiNama",
    url: "https://youtube.com/playlist?list=PLDIP2VvLNbz0",
  },
  {
    id: "playlist-7",
    label: "KishoreNama",
    url: "https://youtube.com/playlist?list=PLfPVo2iio_44",
  },
];

// ---------------------------------------------------------------------------
// YouTube Cookies Resolution (Required on Cloud/VPS Hosts like Netlify)
// ---------------------------------------------------------------------------
function resolveCookiesPath() {
  if (process.env.YTDLP_COOKIES_PATH && fs.existsSync(process.env.YTDLP_COOKIES_PATH)) {
    try {
      const tmpPath = path.join(TMP_DIR, "yt-cookies.txt");
      fs.copyFileSync(process.env.YTDLP_COOKIES_PATH, tmpPath);
      console.log(`Using cookies from YTDLP_COOKIES_PATH -> ${tmpPath}`);
      return tmpPath;
    } catch (err) {
      console.error("Failed to copy YTDLP_COOKIES_PATH:", err.message);
    }
  }

  if (process.env.YTDLP_COOKIES_B64) {
    // .trim() matters here: it's very easy for a stray leading/trailing
    // newline or space to sneak into the value — e.g. Netlify's env var UI
    // sometimes appends a trailing newline on paste, and terminals that
    // wrap long lines can make it look like there's extra whitespace even
    // when there isn't. Whitespace among the base64 alphabet is otherwise
    // harmless (Buffer.from skips it), but leading/trailing whitespace can
    // still shift what gets treated as padding, so strip it defensively.
    const b64 = process.env.YTDLP_COOKIES_B64.trim();
    console.log(`YTDLP_COOKIES_B64 present: ${b64.length} chars`);
    try {
      const raw = Buffer.from(b64, "base64");
      // Netlify env vars are capped at ~5000 chars, and a plain base64'd
      // cookies.txt blows past that. So we gzip-compress before base64'ing
      // (see scripts/encode-cookies.mjs) and gunzip here on read. Detect the
      // gzip magic bytes (1f 8b) so a plain, uncompressed base64 value still
      // works too — no silent breakage for anyone who sets it the old way.
      const isGzip = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b;
      const decoded = (isGzip ? zlib.gunzipSync(raw) : raw).toString("utf8");
      const tmpPath = path.join(TMP_DIR, "yt-cookies.txt");
      fs.writeFileSync(tmpPath, decoded, { encoding: "utf8", mode: 0o600 });
      console.log(`Loaded YouTube cookies from YTDLP_COOKIES_B64 (${isGzip ? "gzip" : "plain"})`);
      return tmpPath;
    } catch (err) {
      // "incorrect data check" specifically means the bytes we base64-
      // decoded don't gunzip cleanly — i.e. the *value itself* is corrupt or
      // incomplete, not a code bug. In practice this almost always means the
      // string that ended up in the env var isn't byte-for-byte what
      // scripts/encode-cookies.mjs printed. Common causes, in order of
      // likelihood:
      //   1. Copying encode-cookies.mjs's terminal output by hand and
      //      accidentally including its "Input:/Compressed:/Base64:" info
      //      lines (printed to stderr, so they interleave with the actual
      //      value in a terminal) — those lines contain base64-alphabet
      //      characters too, so the corruption is silent until gunzip runs.
      //      Fix: redirect stdout only — `node scripts/encode-cookies.mjs
      //      cookies.txt > cookies.b64` — then copy from that file, not the
      //      terminal.
      //   2. Pasting into Netlify's dashboard env var field and it silently
      //      truncating (there's a soft ~5000 char cap; encode-cookies.mjs
      //      warns if its output is already over that). Prefer
      //      `netlify env:set YTDLP_COOKIES_B64 "$(cat cookies.b64)"`
      //      over the web UI for long values.
      //   3. Setting it per a single deploy context that doesn't cover the
      //      one actually serving requests (Production vs. branch deploys).
      console.error(`Failed to decode YTDLP_COOKIES_B64 (${b64.length} chars): ${err.message}`);
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
  const args = [
    "--js-runtimes",
    "node",
    // Bug fix: without an explicit socket timeout, a stalled/slow TCP
    // connection to YouTube just sits there until our own JS watchdog
    // (YTDLP_TIMEOUT_MS, below) SIGKILLs the whole process — which throws
    // away any partial progress and always reports the same generic
    // "Failed to extract playable audio stream" error, with no real
    // reason. Capping yt-dlp's own per-request socket timeout well under
    // that watchdog means a slow connection fails *inside* yt-dlp first,
    // with a real, specific stderr reason (timeout/connection error) that
    // now actually reaches the frontend via `details` — and a couple of
    // automatic retries often recover it without ever hitting the
    // watchdog at all.
    //
    // Values raised from the original 6s/1/1 now that YTDLP_TIMEOUT_MS
    // has real room (45s, not the old 9s) — a slow-but-working connection
    // now gets multiple real attempts instead of failing after one.
    "--socket-timeout", "10",
    // yt-dlp's default cache dir is under $HOME, which is read-only on Lambda.
    "--cache-dir", path.join(TMP_DIR, "yt-dlp-cache"),
    "--extractor-retries", "2",
    "--retries", "3",
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

// BUG FIX (Windows "spawn ... yt-dlp_bin ENOENT"): this path used to be a
// bare `yt-dlp_bin` with no extension, on every platform. Two problems:
//   1. On Windows, an extension-less unsigned binary sitting in %TEMP% is
//      exactly the profile Windows Defender / most AV products flag and
//      silently quarantine-delete — often *after* ensureYtDlp() already
//      resolved and cached this path, so the next spawn() hits a file that
//      vanished out from under it and throws a raw, unhandled
//      `spawn ...\yt-dlp_bin ENOENT` straight up to the frontend (that's
//      the exact error being reported).
//   2. It also didn't match the platform's expected executable naming
//      (.exe), which some Windows security tooling additionally treats as
//      a reason for suspicion on its own.
// Giving it the real platform-appropriate filename (yt-dlp.exe on Windows)
// fixes #2 outright and makes #1 less likely. #1 is fully closed below by
// re-verifying the file still exists on every call, not just once at
// download time — see ensureYtDlp()/spawnYtDlp().
function tmpBinaryPath() {
  let filename;
  try {
    filename = binaryFilename();
  } catch {
    filename = "yt-dlp_bin";
  }
  return path.join(os.tmpdir(), `yt-dlp_bin${path.extname(filename)}`);
}

const TMP_YTDLP_PATH = tmpBinaryPath();

// A real yt-dlp build is tens of MB. Anything drastically smaller means a
// previous download got cut short / quarantined mid-write — treat it as
// absent rather than trusting a corrupt file into spawn().
const MIN_VALID_BINARY_BYTES = 1_000_000;

function isUsableBinary(candidatePath) {
  try {
    const stat = fs.statSync(candidatePath);
    return stat.isFile() && stat.size >= MIN_VALID_BINARY_BYTES;
  } catch {
    return false;
  }
}

function findBundledBinary() {
  let filename;
  try {
    filename = binaryFilename();
  } catch {
    return null;
  }
  for (const candidate of candidatePaths(filename)) {
    if (isUsableBinary(candidate)) return candidate;
  }
  return null;
}

// Downloads `url` (following redirects) to `destPath`, following redirects.
function downloadFile(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const req = https.get(url, { headers: { "User-Agent": "raunaknama-fn" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        if (redirectsLeft <= 0) {
          reject(new Error("Too many redirects"));
          return;
        }
        downloadFile(res.headers.location, destPath, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        reject(new Error(`Download failed: ${res.statusCode} ${res.statusMessage}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

// BUG FIX (spawn ETXTBSY): this used to download straight into
// TMP_YTDLP_PATH — the exact path spawnYtDlp() later exec's. Linux refuses
// to open a file for writing while it's mapped/running as an executable
// ("text file busy"). Two requests landing on the same warm container
// close together — one still mid-download-write, the other already
// spawning the binary from an earlier completed download — could race on
// that same path and throw `spawn ETXTBSY`. Downloading to a private,
// per-attempt staging path and then atomically fs.renameSync'ing it onto
// TMP_YTDLP_PATH only once fully written means we never open the live,
// executable path for writing at all, so nothing can collide with a
// concurrent spawn of it. rename(2) on the same filesystem (both under
// os.tmpdir()) is atomic, so a concurrent reader either sees the old file
// or the fully-written new one — never a partial write.
// Nightly channel, not the monthly-ish stable channel — see the matching
// note in scripts/download-ytdlp.mjs for why: YouTube breaks extraction
// often enough that stable lags behind, and yt-dlp's maintainers' own fix
// for errors like "The page needs to be reloaded" is "update to nightly".
const YTDLP_RELEASES_BASE = "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download";

async function downloadToTmp() {
  const filename = binaryFilename();
  const url = `${YTDLP_RELEASES_BASE}/${filename}`;
  const stagingPath = `${TMP_YTDLP_PATH}.download-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await downloadFile(url, stagingPath);
    fs.chmodSync(stagingPath, 0o755);
    fs.renameSync(stagingPath, TMP_YTDLP_PATH);
    return TMP_YTDLP_PATH;
  } finally {
    // Clean up the staging file if something went wrong before the rename
    // (rename having succeeded means this path no longer exists, so this
    // is a silent no-op in the success case).
    fs.promises.unlink(stagingPath).catch(() => {});
  }
}

let ytdlpReadyPromise = null;
// The path ytdlpReadyPromise last resolved to. Kept separately so we can
// cheaply re-stat it on every call instead of re-running the whole
// bundled-binary-search + possible-download flow each time.
let resolvedYtdlpPath = null;

// BUG FIX (Windows "spawn ... yt-dlp_bin ENOENT"): previously, once
// ytdlpReadyPromise resolved successfully it was cached *forever* for the
// life of the process, and nothing ever re-checked that the file it
// pointed to was still there. On a long-lived local `netlify dev` process
// (or a warm cloud container), if something outside our control removes
// that file after the fact — most commonly Windows Defender / other AV
// quietly quarantining an unsigned binary sitting in %TEMP% — every
// subsequent request would keep trusting the stale cached path, spawn()
// would fail to find it, and Node's raw `spawn <path> ENOENT` error would
// go straight to the frontend uncaught. Re-verifying with a cheap stat
// call on every invocation (not just the first) means a vanished binary
// gets transparently re-downloaded instead of surfacing that error.
async function ensureYtDlp({ forceRedownload = false } = {}) {
  if (!forceRedownload && resolvedYtdlpPath && isUsableBinary(resolvedYtdlpPath)) {
    return resolvedYtdlpPath;
  }
  if (forceRedownload) {
    ytdlpReadyPromise = null;
    resolvedYtdlpPath = null;
  }

  if (!ytdlpReadyPromise) {
    ytdlpReadyPromise = (async () => {
      // 1. Bundled binary (shipped via netlify.toml's included_files) —
      //    fastest path, no network I/O at all.
      const bundled = findBundledBinary();
      if (bundled) return bundled;

      // 2. Already downloaded to /tmp by a previous invocation on this warm
      //    container.
      if (isUsableBinary(TMP_YTDLP_PATH)) return TMP_YTDLP_PATH;

      console.warn(
        "yt-dlp binary not found (or vanished) at the expected path — this " +
          "usually means `npm install` hasn't finished running " +
          "scripts/download-ytdlp.mjs, netlify.toml's `included_files` " +
          "didn't ship it, or (on Windows) antivirus removed a previously " +
          "downloaded copy from %TEMP%. Attempting a runtime download to " +
          os.tmpdir() + " as a fallback (slower first request)."
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
  resolvedYtdlpPath = await ytdlpReadyPromise;
  return resolvedYtdlpPath;
}

// Hard ceiling on any single yt-dlp invocation.
//
// CORRECTED (previous comment here was wrong): Netlify's synchronous
// function execution limit is NOT a fixed 60s. It's 10s by default, and the
// max reachable at all — even on a paid Pro plan, via the `timeout` field
// in netlify.toml's [functions."name"] block — is 26s. On the free/Starter
// plan the limit stays 10s no matter what netlify.toml says. A 45s watchdog
// here can never fire in production: Netlify kills the whole function
// first, which returns an HTML/opaque error the frontend can't parse as
// JSON — exactly the vague "backend down" symptom being reported, and it
// hits hardest on videos that need more extraction work server-side (e.g.
// "Topic" channel / auto-generated official-audio uploads), since those are
// the ones most likely to run long enough to cross Netlify's real cutoff.
//
// 22000ms leaves a margin under the 26s cap configured for the stream/
// search/playlist functions in netlify.toml (see that file's comment). If
// you're on Netlify's free/Starter plan, that 26s config has no effect and
// the platform still kills at 10s — set YTDLP_TIMEOUT_MS=8000 via an env
// var in that case so this watchdog fires first with a clean JSON error
// instead of letting Netlify hard-kill mid-request.
const YTDLP_TIMEOUT_MS = Number(process.env.YTDLP_TIMEOUT_MS) || 22000;

function spawnYtDlpOnce(ytdlpPath, args) {
  return new Promise((resolve, reject) => {
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
  });
}

export async function spawnYtDlp(args) {
  let ytdlpPath = await ensureYtDlp();
  try {
    return await spawnYtDlpOnce(ytdlpPath, args);
  } catch (err) {
    // Defensive second line of defense on top of the atomic-rename fix in
    // downloadToTmp(): if the OS still refuses to exec the binary because
    // it's momentarily open for writing elsewhere (ETXTBSY) — e.g. a
    // concurrent request on the same warm container mid-(re)download — a
    // short wait almost always resolves it, since writes to the file are
    // fast and exclusive. One retry avoids surfacing a raw, unhelpful
    // "spawn ETXTBSY" to the frontend for what's just a brief race.
    if (err && err.code === "ETXTBSY") {
      console.warn("[ytdlp] spawn ETXTBSY, retrying once after a short delay...");
      await new Promise((r) => setTimeout(r, 300));
      return await spawnYtDlpOnce(ytdlpPath, args);
    }
    // BUG FIX (Windows "spawn ... yt-dlp_bin ENOENT"): the path we resolved
    // via ensureYtDlp() existed at that moment but is gone by the time we
    // actually spawn it — almost always antivirus (Windows Defender is the
    // usual culprit) quarantining/deleting an unsigned binary out of
    // %TEMP% behind our back. Instead of letting this raw, unhelpful
    // `spawn <path> ENOENT` reach the frontend (which is exactly the
    // symptom being reported), force a fresh re-download and retry once.
    if (err && err.code === "ENOENT") {
      console.warn(
        "[ytdlp] spawn ENOENT for " + ytdlpPath + " — binary vanished after " +
          "resolution (commonly antivirus removing it from the temp folder " +
          "on Windows). Forcing a fresh download and retrying once..."
      );
      ytdlpPath = await ensureYtDlp({ forceRedownload: true });
      return await spawnYtDlpOnce(ytdlpPath, args);
    }
    throw err;
  }
}


// Shared by every function (search, lyrics, stream, playlists, ...). HEAD and
// Range are included so <audio> preflights/seeks and the new Recommended-mode
// frontend work cross-origin; Expose-Headers lets the player read Content-Range.
// Edge-cache policy for read-only, non-personalised JSON (playlists, search):
// browsers 5 min, Netlify's CDN 30 min (+ stale-while-revalidate). Never use
// this on /stream or /audio-proxy: those urls are IP-bound and expire.
export const CDN_CACHE = "public, max-age=300, s-maxage=1800, stale-while-revalidate=3600";

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
  "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length",
  "Access-Control-Max-Age": "86400",
};

// ---------------------------------------------------------------------------
// Recommended-mode data (mirrors the constants in src/components/Dashboard.jsx,
// which cannot import this file because it pulls in Node-only modules).
// "kavin.rocks" is the Piped web UI; the API host is pipedapi.kavin.rocks.
// ---------------------------------------------------------------------------
export const PIPED_API_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://api.piped.private.coffee",
  "https://pipedapi.leptons.xyz",
  "https://piped-api.garudalinux.org",
];

export const RECOMMENDED_SEED_QUERIES = [
  "bollywood hits", "arijit singh", "kishore kumar", "mohammed rafi", "lata mangeshkar",
  "ghazal jagjit singh", "sufi songs", "90s bollywood romantic", "old hindi classics", "hindi lofi",
];

/** Piped search/trending item -> the flat card shape the dashboard renders. */
export function normalizePipedItem(it) {
  const id = /[?&]v=([\w-]{11})/.exec(it?.url || "")?.[1];
  if (!id) return null;
  return {
    id,
    title: it.title || "Untitled",
    subtitle: (it.uploaderName || "Unknown artist").replace(/\s*-\s*Topic$/i, ""),
    durationSeconds: it.duration > 0 ? it.duration : null,
    thumbnailUrl: it.thumbnail || null,
  };
}

// Offline fixture in Piped's real response shape, for tests / local UI work.
export const SIMULATED_PIPED_RESPONSE = {
  items: [
    { type: "stream", url: "/watch?v=dQw4w9WgXcQ", title: "Sample Track", uploaderName: "Sample Artist - Topic", duration: 213, thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" },
  ],
  nextpage: null,
};
