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

import { getYouTubeCookieHeader } from "./youtubeCookies.mjs";

let sessionsPromise = null;

// Fixed (not random) session User-Agent. youtubei.js sends this header for
// clients it has no dedicated UA for (MWEB, TV, WEB_EMBEDDED…), and the audio
// proxy must replay the *same* UA when it fetches the googlevideo URL, so it
// has to be deterministic. A mobile Safari UA matches the MWEB client.
const SESSION_USER_AGENT =
  process.env.YT_SESSION_USER_AGENT ||
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

// Documented custom evaluator YouTube.js needs to decipher signature/n params.
async function evalShim(data, env) {
  const props = [];
  if (env?.n) props.push(`n: exportedVars.nFunction(${JSON.stringify(env.n)})`);
  if (env?.sig) props.push(`sig: exportedVars.sigFunction(${JSON.stringify(env.sig)})`);
  const code = `${data.output}\nreturn { ${props.join(", ")} }`;
  // eslint-disable-next-line no-new-func
  return new Function(code)();
}

// Two SEPARATE long-lived Innertube sessions per warm function instance.
// Web cookies are never mixed into the app clients:
//
//   anon : NO cookies. Used for IOS / ANDROID_VR / TV / MWEB / WEB_EMBEDDED.
//          Unauthenticated YTJS_IOS resolves itag=140 in ~200ms; attaching
//          browser cookies to an IOS/TV request breaks it (youtubei.js would
//          add the cookie + SAPISIDHASH to every request of a logged-in
//          session, and the app clients do not accept web cookies).
//   auth : carries your YouTube cookies (YTDLP_COOKIES_B64). Used EXCLUSIVELY
//          by the WEB client, the only one where browser cookies are valid.
//
// No BotGuard / jsdom PO-token minting anywhere (it blocked the event loop for
// seconds on a cold start and always failed). `anon` is created first and is
// all the fast IOS path ever waits for; `auth` is built in the background.
// Both share one downloaded player (signature / "n" deciphering is
// client-independent).
const AUTH_CLIENTS = new Set(["WEB"]);

let anonPromise = null;
let authPromise = null;

function getAnon() {
  if (!anonPromise) {
    anonPromise = (async () => {
      const mod = await import("youtubei.js");
      const { Innertube, Platform, Log } = mod;
      try { Log.setLevel(Log.Level.NONE); } catch { /* older/newer API */ }
      try { Platform.shim.eval = evalShim; } catch { /* ignore */ }
      return Innertube.create({
        enable_session_cache: false,
        user_agent: SESSION_USER_AGENT,
        retrieve_player: true,
        generate_session_locally: true,
      });
    })().catch((err) => {
      anonPromise = null; // allow a later retry
      throw err;
    });
  }
  return anonPromise;
}

// Resolves to the cookie-authenticated session, or null when no cookies are
// configured / the session could not be built (WEB then simply sits out).
function getAuth() {
  if (!authPromise) {
    authPromise = (async () => {
      const cookie = getYouTubeCookieHeader();
      if (!cookie) return null;
      try {
        const anon = await getAnon();
        const { Innertube } = await import("youtubei.js");
        const base = { enable_session_cache: false, user_agent: SESSION_USER_AGENT, cookie, retrieve_player: false };
        // Let YouTube issue visitor data for the logged-in session (more
        // natural than a locally generated one); fall back to local on error.
        const auth = await Innertube.create({ ...base, generate_session_locally: false })
          .catch(() => Innertube.create({ ...base, generate_session_locally: true }));
        auth.session.player = anon.session.player; // share the player
        log(`authenticated WEB session ready (logged_in=${auth.session.logged_in})`);
        return auth;
      } catch (err) {
        log(`authenticated session unavailable: ${String(err?.message || err).slice(0, 120)}`);
        return null;
      }
    })();
  }
  return authPromise;
}

const sessionFor = async (clientName) => {
  if (AUTH_CLIENTS.has(clientName)) {
    const auth = await getAuth();
    if (!auth) throw new Error("no cookie-authenticated session (set YTDLP_COOKIES_B64)");
    return auth;
  }
  return getAnon();
};

// Warm up the anonymous session at module load (cold start).
getAnon().catch(() => {}); // the cookie session is only built if a WEB client is ever requested

// The exact User-Agent youtubei.js sent when it asked YouTube for this
// client's streaming data. googlevideo ties some clients' URLs to it, so the
// audio proxy replays it.
function userAgentFor(Constants, yt, clientName) {
  switch (clientName) {
    case "IOS": return Constants.CLIENTS.IOS.USER_AGENT;
    case "ANDROID": return Constants.CLIENTS.ANDROID.USER_AGENT;
    case "ANDROID_VR": return Constants.CLIENTS.ANDROID_VR.USER_AGENT;
    case "VISIONOS": return Constants.CLIENTS.VISIONOS.USER_AGENT;
    default: return yt.session.user_agent || SESSION_USER_AGENT;
  }
}

// TV URLs can be bound to either the TV player UA or the header UA youtubei.js
// sent; the verification below tries each candidate and keeps the one the CDN
// accepts (the proxy then replays exactly that one).
function userAgentCandidates(Constants, yt, clientName) {
  const primary = userAgentFor(Constants, yt, clientName);
  if (clientName === "TV" && Constants.CLIENTS.TV?.USER_AGENT && Constants.CLIENTS.TV.USER_AGENT !== primary) {
    return [Constants.CLIENTS.TV.USER_AGENT, primary];
  }
  return [primary];
}

// ---------------------------------------------------------------------------
// Tiered resolve (a flood of parallel clients looks like bot traffic):
//   Tier 1: MWEB + IOS + ANDROID (anonymous session), raced — first url wins.
//   Tier 2: TV + ANDROID_VR — only if tier 1 gave nothing.
// WEB is not used: with cookies it still answers "SABR-only" (formats without
// direct urls), so it only wasted ~250-650ms per track. URLs are NOT probed
// server-side any more; the browser (or the audio proxy backup) fetches them.
// ---------------------------------------------------------------------------
export const TIERS = [
  ["MWEB", "IOS", "ANDROID"],           // anonymous, raced; first url wins (~250-700ms)
  ["TV", "ANDROID_VR"],                 // anonymous last resorts
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

// Picks + deciphers the best audio-only URL. Never fails silently: when no
// URL can be produced it throws an Error that says WHY (no streaming_data,
// formats present but without URLs / ciphers — i.e. SABR-only responses —, or
// the exact decipher error), so the log shows the real cause per client.
async function pickUrl(yt, info) {
  const sd = info?.streaming_data;
  const formats = sd?.adaptive_formats;
  if (!Array.isArray(formats) || !formats.length) {
    throw new Error(`no adaptive formats (streaming_data=${sd ? "present" : "missing"})`);
  }
  const audio = rankAudio(formats);
  if (!audio.length) {
    throw new Error(`no audio-only formats among ${formats.length} adaptive formats`);
  }
  const withSource = audio.filter((f) => f.url || f.signature_cipher || f.cipher);
  if (!withSource.length) {
    // The response carries formats but no direct URL for any of them — the
    // client only offers SABR / server-ABR streaming (needs a PO token).
    throw new Error(`${audio.length} audio formats but none has a direct url/cipher (SABR-only response)`);
  }
  let lastErr = null;
  for (const f of withSource) {
    try {
      const url = await f.decipher(yt.session.player);
      if (typeof url === "string" && url.startsWith("http")) return { url, itag: f.itag };
      lastErr = new Error(`decipher gave a non-url for itag ${f.itag}`);
    } catch (err) {
      lastErr = err; // try the next format
    }
  }
  throw new Error(`decipher failed: ${String(lastErr?.message || lastErr).slice(0, 100)}`);
}

/** One youtubei.js client -> { url, client, itag, userAgent, ms }. Throws a clean Error on failure. */
async function runClient(videoId, clientName) {
  const t0 = Date.now();
  const yt = await sessionFor(clientName);
  const { Constants } = await import("youtubei.js");
  const info = await yt.getBasicInfo(videoId, { client: clientName });
  const status = info?.playability_status?.status;
  if (status && status !== "OK") {
    throw new Error(`${status}${info.playability_status.reason ? ` (${info.playability_status.reason})` : ""}`);
  }
  const hit = await pickUrl(yt, info);
  // No server-side probe: Node's https client is not the browser that will
  // play this url, and every extra request spends the url's first-use budget.
  const userAgent = userAgentCandidates(Constants, yt, clientName)[0];
  return {
    url: hit.url,
    itag: hit.itag,
    client: `YTJS_${clientName}`,
    userAgent,
    authed: Boolean(yt.session.logged_in),
    ms: Date.now() - t0,
  };
}

const INIT_TIMEOUT_MS = 20000;

async function raceTier(videoId, names) {
  // Session setup (player JS download, etc.) only happens once per warm
  // instance. It used to count against each client's 3.5s timeout, so the first
  // requests after a cold start all "timed out" and fell through to the slow
  // yt-dlp path. Wait for it here, THEN start the per-client timers.
  // Only the anonymous session gates the fast path; the cookie session is
  // awaited lazily by the WEB client alone.
  await withTimeout(getAnon(), INIT_TIMEOUT_MS, "session init");
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
      log(`${videoId} OK tier${t + 1} ${hit.client} itag=${hit.itag}${hit.authed ? " (cookies)" : ""} in ${hit.ms}ms`);
      return hit;
    } catch (err) {
      log(`${videoId} tier${t + 1} (${names.join("+")}) gave nothing`);
    }
  }
  return null;
}
