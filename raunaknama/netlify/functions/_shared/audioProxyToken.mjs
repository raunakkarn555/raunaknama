import crypto from "node:crypto";

// Signed, self-contained payload carried in the audio-proxy URL:
//
//   /.netlify/functions/audio-proxy?t=<base64url(JSON {u, ua, exp})>.<hmac>
//
// `u`  = the resolved googlevideo.com media URL
// `ua` = the exact User-Agent the extraction client used (googlevideo ties
//        IOS / MWEB URLs to it, so the proxy must replay it)
// `exp`= unix ms expiry
//
// It is stateless on purpose: stream.mjs and audio-proxy.mjs run as separate
// serverless functions (and instances), so there is no shared memory to look
// an id up in. The HMAC stops anyone from turning the proxy into an open relay
// (audio-proxy additionally only ever talks to *.googlevideo.com).
//
// Set AUDIO_PROXY_SECRET (or reuse SITE_AUTH_SECRET) in production.

const b64u = (buf) => Buffer.from(buf).toString("base64url");

function secret() {
  const s = process.env.AUDIO_PROXY_SECRET || process.env.SITE_AUTH_SECRET;
  if (s) return s;
  // Dev-only fallback so `netlify dev` works with zero config. The host
  // allow-list in audio-proxy.mjs still applies.
  return "raunaknama-dev-audio-proxy-secret";
}

const sign = (data) => crypto.createHmac("sha256", secret()).update(data).digest("base64url");

export function createProxyToken({ url, userAgent, ttlMs = 6 * 60 * 60 * 1000 }) {
  const body = b64u(JSON.stringify({ u: url, ua: userAgent || "", exp: Date.now() + ttlMs }));
  return `${body}.${sign(body)}`;
}

/** Returns { url, userAgent } or throws an Error with .statusCode. */
export function verifyProxyToken(token) {
  const fail = (code, msg) => Object.assign(new Error(msg), { statusCode: code });
  if (typeof token !== "string" || !token.includes(".")) throw fail(400, "Missing or malformed token");
  const [body, sig] = token.split(".");
  const expected = sign(body);
  const a = Buffer.from(sig || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw fail(403, "Bad token signature");
  let data;
  try {
    data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw fail(400, "Unreadable token");
  }
  if (!data?.u || !(data.exp > Date.now())) throw fail(410, "Token expired");
  return { url: data.u, userAgent: data.ua || "" };
}

// Which resolver clients get the audio proxy as their PRIMARY url. Default: none
// — the browser plays the direct googlevideo.com url, and the proxy url is
// attached as the first backup (`fallbacks[0]`, see stream.mjs) in case the
// direct url is refused (e.g. IP mismatch in production). Set
// AUDIO_PROXY_CLIENTS=* (or a comma list such as YTJS_IOS,YTJS_MWEB) to make the
// proxy primary again.
const RAW = process.env.AUDIO_PROXY_CLIENTS ?? "";
const PROXY_CLIENTS = new Set(RAW.split(",").map((s) => s.trim()).filter(Boolean));
export const needsProxy = (client) =>
  client !== "PIPED" && (PROXY_CLIENTS.has("*") || PROXY_CLIENTS.has(client));
