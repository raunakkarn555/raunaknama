// Extra stream resolver built on `youtubei.js` (YouTube.js) — the Node/JS
// counterpart of the Dart `youtube_explode_dart` package: same technique
// (InnerTube player API through several client identities + signature /
// "n" parameter deciphering), same goal (a direct, playable audio-only URL).
//
// `youtube_explode_dart` itself is a Dart library and cannot run inside
// Netlify's Node functions, so this is the equivalent that can. It is used
// as additional clients in the existing fast-resolver ladder
// (see innertubeAudio.mjs), so tracks that the hand-rolled clients get
// "LOGIN_REQUIRED"/format-less answers for are still resolved here instead
// of ending in "Couldn't play this track — skipping…".

let ytPromise = null;

// Documented custom evaluator YouTube.js needs to decipher signature/n params.
async function evalShim(data, env) {
  const props = [];
  if (env?.n) props.push(`n: exportedVars.nFunction(${JSON.stringify(env.n)})`);
  if (env?.sig) props.push(`sig: exportedVars.sigFunction(${JSON.stringify(env.sig)})`);
  const code = `${data.output}\nreturn { ${props.join(", ")} }`;
  // eslint-disable-next-line no-new-func
  return new Function(code)();
}

// One shared Innertube session per warm function instance (the player JS is
// downloaded once and reused), so only the first cold call pays the setup.
function getInnertube() {
  if (!ytPromise) {
    ytPromise = (async () => {
      const mod = await import("youtubei.js");
      const { Innertube, Platform, Log } = mod;
      try { Log.setLevel(Log.Level.NONE); } catch { /* older/newer API */ }
      try { Platform.shim.eval = evalShim; } catch { /* ignore */ }
      return Innertube.create({
        retrieve_player: true,
        generate_session_locally: true,
        enable_session_cache: false,
      });
    })().catch((err) => {
      ytPromise = null; // allow a later retry
      throw err;
    });
  }
  return ytPromise;
}

// Kick off session creation at cold start so the first click is not slowed.
getInnertube().catch(() => {});

// ---------------------------------------------------------------------------
// Smart tiered race (instead of firing every client at once, which looks like
// bot traffic to YouTube when it comes from a datacenter IP):
//   Tier 1: ANDROID_VR + TV           (rarely IP-bound / PO-token gated)
//   Tier 2: IOS + MWEB + WEB_EMBEDDED (only if tier 1 produced nothing)
// Each tier is a Promise.any race with a strict timeout.
// ---------------------------------------------------------------------------
export const TIERS = [
  ["ANDROID_VR", "TV"],
  ["IOS", "MWEB", "WEB_EMBEDDED"],
];
export const YTJS_CLIENTS = TIERS.flat();
const TIER_TIMEOUT_MS = 3500;

const LOG = process.env.STREAM_LOG !== "0";
const log = (...a) => { if (LOG) console.log("[youtubei]", ...a); };

const withTimeout = (p, ms, label) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);

// Audio-only formats, best first: itag 140 (AAC/M4A — plays everywhere,
// incl. iOS Safari), other audio/mp4, then itag 251 (Opus/WebM), other webm.
function rankAudio(formats) {
  const audio = formats.filter((f) => {
    const mime = String(f?.mime_type || "");
    return f?.has_audio && !f?.has_video && (mime.startsWith("audio/mp4") || mime.startsWith("audio/webm"));
  });
  const byBitrate = (a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0);
  const mp4 = audio.filter((f) => String(f.mime_type).startsWith("audio/mp4")).sort(byBitrate);
  const webm = audio.filter((f) => String(f.mime_type).startsWith("audio/webm")).sort(byBitrate);
  return [
    ...mp4.filter((f) => f.itag === 140),
    ...mp4.filter((f) => f.itag !== 140),
    ...webm.filter((f) => f.itag === 251),
    ...webm.filter((f) => f.itag !== 251),
  ];
}

async function pickUrl(yt, info) {
  const formats = info?.streaming_data?.adaptive_formats;
  if (!Array.isArray(formats) || !formats.length) return null;
  for (const f of rankAudio(formats)) {
    try {
      const url = await f.decipher(yt.session.player);
      if (typeof url === "string" && url.startsWith("http")) return { url, itag: f.itag };
    } catch {
      // try the next format
    }
  }
  return null;
}

/** One youtubei.js client -> { url, client, itag, ms }. Throws a clean Error on failure. */
async function runClient(videoId, clientName) {
  const t0 = Date.now();
  const yt = await getInnertube();
  const info = await yt.getBasicInfo(videoId, { client: clientName });
  const status = info?.playability_status?.status;
  if (status && status !== "OK") {
    throw new Error(`${status}${info.playability_status.reason ? ` (${info.playability_status.reason})` : ""}`);
  }
  const hit = await pickUrl(yt, info);
  if (!hit) throw new Error("no playable audio-only format");
  return { url: hit.url, itag: hit.itag, client: `YTJS_${clientName}`, ms: Date.now() - t0 };
}

async function raceTier(videoId, names) {
  const tierStart = Date.now();
  const attempts = names.map((name) =>
    withTimeout(runClient(videoId, name), TIER_TIMEOUT_MS, name).catch((err) => {
      const reason = String(err?.message || err).slice(0, 140);
      log(`${videoId} ${name} failed in ${Date.now() - tierStart}ms: ${reason}`);
      throw err;
    })
  );
  return Promise.any(attempts);
}

/**
 * Tiered resolve. `exclude` = client names (e.g. "YTJS_TV") whose URL just
 * failed in the browser. Resolves { url, client, itag, ms } or null.
 */
export async function resolveWithYoutubei(videoId, { exclude = [] } = {}) {
  const skip = new Set(exclude);
  for (let t = 0; t < TIERS.length; t++) {
    const names = TIERS[t].filter((n) => !skip.has(`YTJS_${n}`));
    if (!names.length) continue;
    try {
      const hit = await raceTier(videoId, names);
      log(`${videoId} OK tier${t + 1} ${hit.client} itag=${hit.itag} in ${hit.ms}ms`);
      return hit;
    } catch (err) {
      log(`${videoId} tier${t + 1} (${names.join("+")}) gave nothing`);
    }
  }
  return null;
}
