import { Readable } from "node:stream";
import { verifyProxyToken } from "./_shared/audioProxyToken.mjs";
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

const UPSTREAM_CHUNK = Number(process.env.AUDIO_PROXY_CHUNK_BYTES) || 10 * 1024 * 1024;
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
  try {
    ({ url: target, userAgent } = verifyProxyToken(new URL(req.url).searchParams.get("t")));
  } catch (err) {
    return fail(err.statusCode || 400, err.message);
  }
  if (!isGooglevideo(target)) return fail(400, "Target host not allowed");

  const reqRange = req.headers.get("range");
  const parsed = parseRange(reqRange);
  const total = contentLengthOf(target);
  const chunked = total > 0;

  const ctrl = new AbortController();
  req.signal?.addEventListener?.("abort", () => ctrl.abort(), { once: true });

  // Byte window to serve (inclusive).
  let start = 0;
  let end = total ? total - 1 : null;
  if (chunked && parsed) {
    start = parsed.start;
    end = parsed.end == null ? total - 1 : Math.min(parsed.end, total - 1);
    if (start >= total || end < start) {
      return new Response(null, { status: 416, headers: { ...CORS, "Content-Range": `bytes */${total}` } });
    }
  }
  const cpn = newCpn();
  const chunkParam = (from) => `${from}-${Math.min(from + UPSTREAM_CHUNK - 1, end)}`;

  let upstream;
  try {
    upstream = chunked
      ? await requestUpstream({ url: target, userAgent, rangeParam: chunkParam(start), cpn, signal: ctrl.signal })
      : await requestUpstream({ url: target, userAgent, range: reqRange || null, signal: ctrl.signal });
  } catch (err) {
    log(`upstream request failed in ${Date.now() - t0}ms (ip family ${ipFamilyOf(target) || "?"}): ${err.message}`);
    return fail(504, "Upstream audio request failed");
  }

  const code = upstream.statusCode;
  if (code !== 200 && code !== 206) {
    const body = await snippet(upstream);
    log(`upstream HTTP ${code} range=${reqRange || "none"} mode=${chunked ? "range-param" : "range-header"} ua="${userAgent || ""}" ipFamily=${ipFamilyOf(target) || "?"} in ${Date.now() - t0}ms body="${body}"`);
    return fail(code, `Upstream responded with HTTP ${code}`);
  }

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

  // One continuous body: this chunk, then the next range= chunks, in order.
  async function* body() {
    let res = upstream;
    let pos = start;
    while (true) {
      for await (const buf of res) yield buf;
      pos = Math.min(pos + UPSTREAM_CHUNK, end + 1);
      if (pos > end) return;
      res = await requestUpstream({ url: target, userAgent, rangeParam: chunkParam(pos), cpn, signal: ctrl.signal });
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        log(`chunk at ${pos} failed: HTTP ${res.statusCode}`);
        res.destroy();
        throw new Error(`upstream chunk HTTP ${res.statusCode}`);
      }
    }
  }
  return new Response(Readable.toWeb(Readable.from(body())), { status, headers: out });
};
