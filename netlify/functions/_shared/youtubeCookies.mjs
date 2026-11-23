import fs from "node:fs";
import zlib from "node:zlib";

// Reads the same YouTube cookies yt-dlp uses (YTDLP_COOKIES_B64 = base64 of
// gzip'd Netscape cookies.txt, or plain base64; or YTDLP_COOKIES_PATH) and
// turns them into an HTTP `Cookie:` header string for youtubei.js.
//
// Same decoding rules as ytdlpService.mjs (trim, base64, gunzip when the gzip
// magic bytes 1f 8b are present). It is a separate tiny module on purpose:
// importing ytdlpService here would pull in the yt-dlp binary plumbing.
//
// The header is only ever sent by youtubei.js to youtube.com API endpoints.
// It is never put in proxy tokens, never sent to googlevideo.com, never logged.

function readNetscapeText() {
  const p = process.env.YTDLP_COOKIES_PATH;
  if (p && fs.existsSync(p)) {
    try { return fs.readFileSync(p, "utf8"); } catch { /* fall through */ }
  }
  const b64 = (process.env.YTDLP_COOKIES_B64 || "").trim();
  if (!b64) return null;
  try {
    const raw = Buffer.from(b64, "base64");
    const isGzip = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b;
    return (isGzip ? zlib.gunzipSync(raw) : raw).toString("utf8");
  } catch (err) {
    console.error(`[cookies] could not decode YTDLP_COOKIES_B64: ${err.message}`);
    return null;
  }
}

/** Netscape cookies.txt text -> "A=1; B=2" for youtube.com / google.com cookies. */
export function netscapeToCookieHeader(text, now = Date.now() / 1000) {
  const jar = new Map(); // name -> value (later lines win, like a browser jar)
  for (const rawLine of String(text).split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#HttpOnly_")) line = line.slice("#HttpOnly_".length);
    else if (line.startsWith("#")) continue;
    const f = line.split("\t");
    if (f.length < 7) continue;
    const [domain, , , , expiry, name, ...rest] = f;
    if (!/(^|\.)(youtube|google)\.com$/i.test(domain.replace(/^\./, ""))) continue;
    const exp = Number(expiry);
    if (exp > 0 && exp < now) continue; // expired (0 = session cookie)
    jar.set(name, rest.join("\t"));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

let cached; // undefined = not read yet, "" = none/unusable
export function getYouTubeCookieHeader() {
  if (cached !== undefined) return cached || null;
  const text = readNetscapeText();
  cached = text ? netscapeToCookieHeader(text) : "";
  // Cookies are only useful if they carry a logged-in session.
  if (cached && !/(^|; )(SAPISID|__Secure-3PAPISID|SID)=/.test(cached)) cached = "";
  console.log(cached ? `[cookies] youtubei.js will use ${cached.split("; ").length} YouTube cookies` : "[cookies] no usable YouTube cookies for youtubei.js");
  return cached || null;
}
