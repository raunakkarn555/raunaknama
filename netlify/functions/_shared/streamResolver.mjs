import { resolveWithYoutubei } from "./youtubeiResolver.mjs";
import { resolveWithPiped } from "./pipedResolver.mjs";
import { resolveAudio } from "./innertubeAudio.mjs";
import { buildMediaPlaylist } from "./hlsProxy.mjs";

// Full fast-path pipeline, shared by netlify/functions/stream.mjs and
// test-resolver.mjs:
//
//   normal   : youtubei.js tier 1 -> tier 2 -> legacy raw clients,
//              with Piped started in parallel (different upstream, so it adds
//              no bot-traffic to YouTube) and returned as `fallbacks[]`.
//   fallback : (?fallback=true) Piped first, then the normal chain.
//
// Resolves { url, client, itag?, ms, fallbacks: [{url, client}] } or null.
// `onLateFallback(list)` is called if Piped finishes after we already answered,
// so the server cache can still gain a backup URL.

const PIPED_GRACE_MS = 700;
const LEGACY_DEADLINE_MS = 7000; // don't start the legacy ladder this late (Netlify 10s limit)
const LOG = process.env.STREAM_LOG !== "0";
const log = (...a) => { if (LOG) console.log("[stream]", ...a); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slim = (h) => (h ? { url: h.url, client: h.client } : null);

// Last resort, server side: yt-dlp (slow, ~10s, but the most tolerant). It used
// to be started by the BROWSER only after the direct url, the proxy url AND the
// retry had all failed in turn; running it here means one request does it all.
async function viaYtdlp(videoId) {
  try {
    const legacy = await import("./legacyStream.mjs");
    const res = await legacy.handler({ httpMethod: "GET", queryStringParameters: { id: videoId } });
    if (res.statusCode !== 200) return null;
    const d = JSON.parse(res.body);
    if (!d?.url) return null;
    return {
      url: d.url,
      type: d.type === "hls" ? "hls" : "direct",
      client: d.type === "hls" ? "YTDLP_HLS" : "YTDLP",
      userAgent: d.userAgent || undefined,
    };
  } catch (err) {
    log(`${videoId} yt-dlp last resort failed: ${String(err?.message || err).slice(0, 120)}`);
    return null;
  }
}

// The plain audio url is cut after ~850 KB without a PO token. The same response
// carries an HLS manifest that is not gated: serve that through audio-proxy
// (see hlsProxy.mjs) and keep the plain url as the backup.
async function viaHls(yt) {
  if (!yt?.hlsUrl) return null;
  try {
    await buildMediaPlaylist({ manifestUrl: yt.hlsUrl, userAgent: yt.userAgent, origin: "http://probe.invalid" });
    log(`${yt.hlsUrl.slice(0, 60)}… HLS audio playlist OK`);
    return { url: yt.hlsUrl, type: "hls", hlsProxy: true, client: `${yt.client}_HLS`, userAgent: yt.userAgent, alt: yt, ms: yt.ms };
  } catch (err) {
    log(`HLS fallback failed: ${String(err?.message || err).slice(0, 120)}`);
    return null;
  }
}

async function primary(videoId, exclude, t0) {
  const yt = await resolveWithYoutubei(videoId, { exclude });
  if (yt && !yt.limited) return yt;
  if (yt) return (await viaHls(yt)) || yt; // limited: HLS if possible, else the cut-off url
  if (Date.now() - t0 > LEGACY_DEADLINE_MS) return viaYtdlp(videoId).then((h) => (h ? { ...h, ms: Date.now() - t0 } : null));
  const legacy = await resolveAudio(videoId, { exclude }).catch(() => null);
  if (legacy) return { ...legacy, ms: Date.now() - t0 };
  const dl = await viaYtdlp(videoId);
  return dl ? { ...dl, ms: Date.now() - t0 } : null;
}

export async function resolveStreamFast(videoId, { exclude = [], fallback = false, onLateFallback } = {}) {
  const t0 = Date.now();
  const pipedP = resolveWithPiped(videoId);

  const finish = (hit, extra) => {
    log(`${videoId} -> ${hit.client} in ${Date.now() - t0}ms (backups: ${extra.length})`);
    return { ...hit, fallbacks: extra };
  };

  if (fallback) {
    const piped = await pipedP;
    if (piped) return finish(piped, []);
    const hit = await primary(videoId, exclude, t0);
    return hit ? finish(hit, []) : null;
  }

  const hit = await primary(videoId, exclude, t0);
  if (hit) {
    const piped = await Promise.race([pipedP, sleep(PIPED_GRACE_MS).then(() => null)]);
    if (!piped && onLateFallback) pipedP.then((p) => p && onLateFallback([slim(p)]));
    return finish(hit, piped ? [slim(piped)] : []);
  }
  const piped = await pipedP;
  if (piped) return finish(piped, []);
  log(`${videoId} -> nothing resolved in ${Date.now() - t0}ms`);
  return null;
}
