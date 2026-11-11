import { resolveWithYoutubei } from "./youtubeiResolver.mjs";
import { resolveWithPiped } from "./pipedResolver.mjs";
import { resolveAudio } from "./innertubeAudio.mjs";

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

async function primary(videoId, exclude, t0) {
  const yt = await resolveWithYoutubei(videoId, { exclude });
  if (yt) return yt;
  if (Date.now() - t0 > LEGACY_DEADLINE_MS) return null;
  const legacy = await resolveAudio(videoId, { exclude }).catch(() => null);
  return legacy ? { ...legacy, ms: Date.now() - t0 } : null;
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
