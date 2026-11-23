#!/usr/bin/env node
// Usage: node scripts/encode-cookies.mjs path/to/cookies.txt
//
// Gzip-compresses the given Netscape-format cookies.txt and base64-encodes
// the result, printing it to stdout. Paste that value into the
// YTDLP_COOKIES_B64 environment variable. Plain base64 of a cookies.txt is
// usually too long for hosting-provider env var limits (e.g. Netlify's
// ~5000 char cap) — gzip first gets a typical cookies.txt under that.

import fs from "fs";
import zlib from "zlib";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/encode-cookies.mjs path/to/cookies.txt");
  process.exit(1);
}

const raw = fs.readFileSync(file);
if (!raw.toString("utf8", 0, 20).includes("Netscape")) {
  console.error(
    "Warning: file doesn't look like a Netscape-format cookies.txt " +
      "(no '# Netscape HTTP Cookie File' header). Continuing anyway."
  );
}

const compressed = zlib.gzipSync(raw, { level: 9 });
const encoded = compressed.toString("base64");

console.error(`Input:      ${raw.length} bytes`);
console.error(`Compressed: ${compressed.length} bytes`);
console.error(`Base64:     ${encoded.length} chars`);
if (encoded.length > 5000) {
  console.error(
    "⚠️  Still over 5000 chars — your hosting provider's env var UI may reject this."
  );
}

console.log(encoded);
