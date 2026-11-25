import { Readable } from "node:stream";
import { verifyProxyToken } from "./_shared/audioProxyToken.mjs";
import { buildMediaPlaylist } from "./_shared/hlsProxy.mjs";
import { requestUpstream, isGooglevideo, ipFamilyOf, snippet, contentLengthOf, newCpn } from "./_shared/googlevideo.mjs";

// GET /.netlify/functions/audio-proxy?t=<signed token>
//
// Streams a googlevideo.com audio URL to the browser's <audio> element.
// googlevideo URLs are bound to the IP *and* client User-Agent that resolved
// them, so a browser fetching them directly gets 403. Here the request is
// replayed with the resolver's User-Agent over the same IP family (see
// _shared/googlevideo.mjs), the browser's Range header is forwarded (seeking
// works), and the upstream body is streamed through without buffering.
//
// The browser gets ONE continuous response per request (bytes=0- streams the
// whole file, so <audio> never fires follow-up range requests). Upstream, the
// proxy fetches googlevideo the way YouTube's own clients do: sequential
// `range=start-end` URL-parameter chunks (+ a stable `cpn`) of UPSTREAM_CHUNK
// bytes, piped back-to-back into that single response. Open-ended
// `Range: bytes=0-` headers are what googlevideo 403'd for IOS/ANDROID URLs.
// If the URL has no `clen=`, it falls back to forwarding the Range header.
// AUDIO_PROXY_CHUNK_BYTES tunes the upstream chunk size (default 10 MB).

// Chunk ladder. Logs showed googlevideo answering the SMALL probe range
// (0-65535) with 200 but 403-ing the proxy's old single huge range (0-clen) for
// IOS urls (PO-token enforcement on big ranges), so no song ever started. The
// proxy now asks like a real player: a tiny first chunk (instant first byte),
// then 256 KB, then up to MAX_CHUNK, halving again if the CDN refuses a size.
const MIN_CHUNK = 64 * 1024;
const FIRST_CHUNK = 64 * 1024;
const MAX_CHUNK = Number(process.env.AUDIO_PROXY_CHUNK_BYTES) || 1024 * 1024;
const LOG = process.env.STREAM_LOG !== "0";
const log = (...a) => { if (LOG) console.log("[audio-proxy]", ...a); };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Content-Type",
  "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, Content-Type",
};

const fail = (status, message) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
  });

function parseRange(header) {
  const m = /^bytes=(\d+)-(\d*)$/.exec(String(header || "").trim());
  return m ? { start: Number(m[1]), end: m[2] === "" ? null : Number(m[2]) } : null;
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "Method not allowed");

  const t0 = Date.now();
  let target;
  let userAgent;
  let videoId = "";
  let client = "";
  let kind = "";
  try {
    ({ url: target, userAgent, videoId, client, kind } = verifyProxyToken(new URL(req.url).searchParams.get("t")));
  } catch (err) {
    return fail(err.statusCode || 400, err.message);
  }
  if (!isGooglevideo(target)) return fail(400, "Target host not allowed");

  const reqRange = req.headers.get("range");

  // HLS fallback (see _shared/hlsProxy.mjs): "hls" = manifest -> rewritten audio
  // playlist, "seg" = one media segment piped straight through.
  if (kind === "hls") {
    try {
      const text = await buildMediaPlaylist({ manifestUrl: target, userAgent, origin: new URL(req.url).origin });
      log(`hls playlist ready in ${Date.now() - t0}ms`);
      return new Response(text, {
        status: 200,
        headers: { ...CORS, "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store" },
      });
    } catch (err) {
      log(`hls playlist failed: ${err.message}`);
      return fail(502, `HLS playlist failed: ${err.message}`);
    }
  }
  if (kind === "seg") {
    const sctrl = new AbortController();
    req.signal?.addEventListener?.("abort", () => sctrl.abort(), { once: true });
    let up;
    try {
      up = await requestUpstream({ url: target, userAgent, range: reqRange || null, signal: sctrl.signal });
    } catch (err) {
      return fail(504, "Upstream segment request failed");
    }
    if (up.statusCode !== 200 && up.statusCode !== 206) {
      log(`hls segment HTTP ${up.statusCode}`);
      up.destroy();
      return fail(up.statusCode, `Upstream responded with HTTP ${up.statusCode}`);
    }
    const sh = new Headers(CORS);
    sh.set("Content-Type", up.headers["content-type"] || "audio/aac");
    for (const h of ["content-length", "content-range"]) if (up.headers[h]) sh.set(h, up.headers[h]);
    return new Response(Readable.toWeb(up), { status: up.statusCode, headers: sh });
  }

  const parsed = parseRange(reqRange);

  const ctrl = new AbortController();
  req.signal?.addEventListener?.("abort", () => ctrl.abort(), { once: true });

  let total, chunked, start, end, cpn, chunkParam, upstream;
  let healed = false;
  // Open the upstream. If the CDN refuses the url (403 = PO-token gated /
  // IP-bound), re-resolve ONCE with another client right here instead of
  // bouncing the failure to the browser (which then walked a slow retry chain).
  while (true) {
    total = contentLengthOf(target);
    chunked = total > 0;
    // Byte window to serve (inclusive).
    start = 0;
    end = total ? total - 1 : null;
    if (chunked && parsed) {
      start = parsed.start;
      end = parsed.end == null ? total - 1 : Math.min(parsed.end, total - 1);
      if (start >= total || end < start) {
        return new Response(null, { status: 416, headers: { ...CORS, "Content-Range": `bytes */${total}` } });
      }
    }
    cpn = newCpn();
    const lastEnd = end;
    chunkParam = (from, size) => `${from}-${Math.min(from + size - 1, lastEnd)}`;

    try {
      upstream = chunked
        ? await requestUpstream({ url: target, userAgent, rangeParam: chunkParam(start, FIRST_CHUNK), cpn, signal: ctrl.signal })
        : await requestUpstream({ url: target, userAgent, range: reqRange || null, signal: ctrl.signal });
    } catch (err) {
      log(`upstream request failed in ${Date.now() - t0}ms (ip family ${ipFamilyOf(target) || "?"}): ${err.message}`);
      return fail(504, "Upstream audio request failed");
    }

    const code = upstream.statusCode;
    if (code === 200 || code === 206) break;

    const body = await snippet(upstream);
    log(`upstream HTTP ${code} range=${reqRange || "none"} mode=${chunked ? "range-param" : "range-header"} ua="${userAgent || ""}" ipFamily=${ipFamilyOf(target) || "?"} in ${Date.now() - t0}ms body="${body}"`);

    const canHeal = !healed && videoId && [403, 404, 410].includes(code) && (!parsed || parsed.start === 0);
    if (!canHeal) return fail(code, `Upstream responded with HTTP ${code}`);
    healed = true;
    try {
      const { resolveWithYoutubei } = await import("./_shared/youtubeiResolver.mjs");
      const alt = await resolveWithYoutubei(videoId, { exclude: client ? [client] : [] });
      if (!alt?.url || !isGooglevideo(alt.url)) return fail(code, `Upstream responded with HTTP ${code}`);
      log(`re-resolved ${videoId} via ${alt.client} after ${client || "?"} got HTTP ${code}`);
      target = alt.url;
      userAgent = alt.userAgent;
      client = alt.client;
    } catch (err) {
      log(`re-resolve failed: ${err.message}`);
      return fail(code, `Upstream responded with HTTP ${code}`);
    }
  }

  const code = upstream.statusCode;
  const out = new Headers(CORS);
  out.set("Content-Type", upstream.headers["content-type"] || "audio/mp4");
  out.set("Accept-Ranges", "bytes");
  out.set("Cache-Control", "private, max-age=300");
  let status = code;
  if (chunked) {
    status = parsed ? 206 : 200;
    out.set("Content-Length", String(end - start + 1));
    if (parsed) out.set("Content-Range", `bytes ${start}-${end}/${total}`);
  } else {
    if (code === 206 && upstream.headers["content-range"]) out.set("Content-Range", upstream.headers["content-range"]);
    if (upstream.headers["content-length"]) out.set("Content-Length", upstream.headers["content-length"]);
  }

  log(`${status} ${out.get("Content-Range") || `len=${out.get("Content-Length") || "?"}`} range=${reqRange || "none"} mode=${chunked ? "range-param" : "range-header"} first-byte in ${Date.now() - t0}ms`);

  if (req.method === "HEAD") {
    upstream.destroy();
    return new Response(null, { status, headers: out });
  }
  if (!chunked) return new Response(Readable.toWeb(upstream), { status, headers: out });

  // One continuous body: the first chunk, then the next range= chunks, in order.
  async function* body() {
    let res = upstream;
    let pos = start;
    let size = 256 * 1024;
    let cap = MAX_CHUNK;
    let fails = 0;
    while (true) {
      let got = 0;
      for await (const buf of res) { got += buf.length; yield buf; }
      pos += got;
      if (pos > end) return;
      while (true) {
        res = await requestUpstream({ url: target, userAgent, rangeParam: chunkParam(pos, Math.min(size, cap)), cpn, signal: ctrl.signal });
        if (res.statusCode === 200 || res.statusCode === 206) break;
        log(`chunk at ${pos} (${Math.min(size, cap)}B) failed: HTTP ${res.statusCode}`);
        res.destroy();
        if (cap > MIN_CHUNK && fails < 4) { fails++; cap = Math.max(MIN_CHUNK, Math.min(size, cap) >> 1); size = cap; continue; }
        throw new Error(`upstream chunk HTTP ${res.statusCode}`);
      }
      size = Math.min(cap, size * 2);
    }
  }
  return new Response(Readable.toWeb(Readable.from(body())), { status, headers: out });
};
