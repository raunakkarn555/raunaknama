#!/usr/bin/env node
// Downloads the yt-dlp binary at `npm install` time.
//
// Why this exists instead of relying on the `ytdlp-nodejs` package's own
// installer: that package's runtime API (`YtDlp`, `helpers.downloadYtDlp`)
// resolves its own binary path using `import.meta.url` *inside the module
// you import* — which works fine under plain Node, but breaks the moment
// Netlify's function bundler (esbuild, bundling to a single CJS-ish output)
// touches it: `import.meta.url` becomes `undefined` in that context, so
// `fileURLToPath(undefined)` throws immediately on import, before any of
// our own code even runs. That crash is what was causing every /api/*
// call to fail. Managing the binary ourselves, with a plain `process.cwd()`
// relative path (no import.meta anywhere in code that gets bundled),
// sidesteps the whole problem.
//
// This script itself is NOT bundled by Netlify (it only runs locally /
// during the build's `npm install` step), so import.meta.url is 100% safe
// to use right here.

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BIN_DIR = path.join(__dirname, "..", "netlify", "functions", "_shared", "bin");

// Netlify Functions always run on Linux x64, regardless of what OS you
// develop on — so the Linux binary always needs to be present for
// deployment. If you're developing locally on macOS/Windows, this also
// grabs the matching binary for your machine so `netlify dev` works there.
export const PLATFORM_MAP = {
  win32: { x64: "yt-dlp.exe", ia32: "yt-dlp_x86.exe", arm64: "yt-dlp_arm64.exe" },
  linux: { x64: "yt-dlp_linux", arm64: "yt-dlp_linux_aarch64", aarch64: "yt-dlp_linux_aarch64" },
  darwin: { x64: "yt-dlp_macos", arm64: "yt-dlp_macos" },
};

export function filenameFor(platform, arch) {
  const byPlatform = PLATFORM_MAP[platform];
  if (!byPlatform) return null;
  return byPlatform[arch] || null;
}

function download(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { headers: { "User-Agent": "raunaknama-setup-script" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        if (redirectsLeft <= 0) {
          reject(new Error("Too many redirects"));
          return;
        }
        download(res.headers.location, dest, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`Download failed: ${res.statusCode} ${res.statusMessage}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
    });
    req.on("error", (err) => {
      file.close();
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      reject(err);
    });
  });
}

async function main() {
  const targets = new Set([PLATFORM_MAP.linux.x64]); // always need this for deployment
  const localFilename = filenameFor(process.platform, process.arch);
  if (localFilename) targets.add(localFilename);

  fs.mkdirSync(BIN_DIR, { recursive: true });

  for (const filename of targets) {
    const dest = path.join(BIN_DIR, filename);
    if (fs.existsSync(dest)) {
      console.log(`[yt-dlp setup] already present: ${filename}`);
      continue;
    }
    const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${filename}`;
    console.log(`[yt-dlp setup] downloading ${filename}...`);
    try {
      await download(url, dest);
      if (!filename.endsWith(".exe")) fs.chmodSync(dest, 0o755);
      console.log(`[yt-dlp setup] saved ${dest}`);
    } catch (err) {
      console.warn(`[yt-dlp setup] could not download ${filename}: ${err.message}`);
      console.warn(
        "[yt-dlp setup] the app will try to download it again at runtime " +
          "(slower first request), or you can re-run: npm run setup:ytdlp"
      );
    }
  }
}

main();
