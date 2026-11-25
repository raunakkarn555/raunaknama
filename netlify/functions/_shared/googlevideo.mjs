import https from "node:https";

// Shared googlevideo.com fetch used by BOTH the audio proxy and the resolver's
// URL verification, so "verified playable" means exactly "the proxy can play it".
//
// Why node:https with an explicit IP family: googlevideo URLs carry `ip=<the
// address that asked YouTube for them>` and are rejected (403) when fetched
// from a different address. On a dual-stack network (your localhost resolves
// via IPv6, e.g. ip=2409:4090:…) a default fetch may connect over the other
// family and get 403. We connect over the family named in `ip=`.

export function ipFamilyOf(url) {
  try {
    const ip = new URL(url).searchParams.get("ip");
    if (!ip) return 0;
    return ip.includes(":") ? 6 : 4;
  } catch {
    return 0;
  }
}

export function isGooglevideo(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && (u.hostname === "googlevideo.com" || u.hostname.endsWith(".googlevideo.com"));
  } catch {
    return false;
  }
}

/** Total byte length of the stream (the `clen=` query param), or 0 if unknown. */
export function contentLengthOf(url) {
  try {
    const n = Number(new URL(url).searchParams.get("clen"));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export const newCpn = () => {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < 16; i++) out += abc[Math.floor(Math.random() * 64)];
  return out;
};

function buildHeaders(userAgent, range) {
  const h = { Accept: "*/*" };
  if (userAgent) h["User-Agent"] = userAgent;
  // Browser-class UAs (MWEB) come from a web player, which sends these.
  if (/^Mozilla\//.test(userAgent || "")) {
    h.Origin = "https://m.youtube.com";
    h.Referer = "https://m.youtube.com/";
  }
  if (range) h.Range = range;
  return h;
}

/**
 * GET `url` from googlevideo. Resolves the raw IncomingMessage (headers
 * received, body NOT consumed). Follows up to 3 redirects. Rejects on
 * network error/timeout. Pass `signal` to abort (also tears down the body).
 */
export function requestUpstream({ url, userAgent, range, rangeParam, cpn, signal, timeoutMs = 15000, redirects = 3 }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error("bad url")); }
    if (!isGooglevideo(url)) return reject(new Error("host not allowed"));
    // `rangeParam` ("start-end") asks for a byte range the way YouTube's own
    // clients (and youtubei.js's downloader) do: as a `range=` URL parameter
    // plus a `cpn`, NOT as an HTTP Range header. Open-ended `Range: bytes=0-`
    // headers on app-client (IOS/ANDROID) URLs are what googlevideo answered
    // with 403. (`range`/`cpn` are not part of the signed `sparams`.)
    if (rangeParam) {
      u.searchParams.set("range", rangeParam);
      u.searchParams.set("cpn", cpn || newCpn());
    }
    const family = ipFamilyOf(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: `${u.pathname}${u.search}`,
        method: "GET",
        timeout: timeoutMs,
        headers: buildHeaders(userAgent, range),
        ...(family ? { family } : {}),
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return requestUpstream({ url: next, userAgent, range, rangeParam, cpn, signal, timeoutMs, redirects: redirects - 1 }).then(resolve, reject);
        }
        resolve(res);
      }
    );
    req.on("timeout", () => req.destroy(new Error("upstream timeout")));
    req.on("error", reject);
    if (signal) {
      if (signal.aborted) req.destroy(new Error("aborted"));
      else signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
    }
    req.end();
  });
}

/** First ~200 bytes of an error body, for diagnostics. */
export async function snippet(res) {
  try {
    let out = "";
    for await (const chunk of res) {
      out += chunk.toString("utf8");
      if (out.length > 200) break;
    }
    res.destroy();
    return out.slice(0, 200).replace(/\s+/g, " ");
  } catch {
    return "";
  }
}

/**
 * One tiny range request. true = CDN served it, false = CDN refused it
 * (403 etc.), null = unknown (timeout / network hiccup).
 */
export async function probeRange({ url, userAgent, rangeParam, timeoutMs = 4000 }) {
  try {
    const res = await requestUpstream({ url, userAgent, rangeParam, timeoutMs });
    res.destroy();
    return res.statusCode === 200 || res.statusCode === 206;
  } catch {
    return null;
  }
}

/**
 * A range deep inside the file. Without a PO token googlevideo serves only the
 * first ~850 KB and 403s everything after it, so a shallow probe (first 64 KB)
 * passes for a url that dies after ~50 s of audio. Probing 1.5 MB in tells the
 * truth. null = file too short for the limit to matter / length unknown.
 */
export function deepRange(url) {
  const clen = contentLengthOf(url);
  if (!clen || clen < 1_200_000) return null;
  const off = Math.min(1_500_000, clen - 4096);
  return `${off}-${Math.min(off + 4095, clen - 1)}`;
}
