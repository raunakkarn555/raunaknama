// Mints a YouTube "PO token" (BotGuard attestation) with bgutils-js + jsdom.
//
// WHY: the logs show googlevideo serves only the first ~850 KB (~50 s) of an
// IOS audio url and then answers HTTP 403 to every later range, whatever the
// chunk size. That is YouTube's PO-token enforcement: without `&pot=<token>`
// on the media url the stream is cut after the first chunk.
//
// The token is bound to an identifier (the session's visitorData, or a video
// id). Minting needs BotGuard to run inside jsdom, so it is done lazily, one
// mint at a time (it briefly sets window/document globals), cached for hours,
// and every failure resolves to null — callers then simply go without a token.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";
const TTL_MS = 4 * 60 * 60 * 1000;
const MINT_TIMEOUT_MS = 15000;

const LOG = process.env.STREAM_LOG !== "0";
const log = (...a) => { if (LOG) console.log("[potoken]", ...a); };

const cache = new Map();    // identifier -> { token, expires }
const inflight = new Map(); // identifier -> Promise<string|null>
let chain = Promise.resolve(); // serialises mints (they touch globalThis)

async function mintOnce(identifier) {
  const { BG } = await import("bgutils-js");
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>', {
    url: "https://www.youtube.com/",
    referrer: "https://www.youtube.com/",
    userAgent: UA,
  });
  const prev = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  try {
    const bgConfig = {
      fetch: (input, init) => fetch(input, init),
      globalObj: globalThis,
      identifier,
      requestKey: REQUEST_KEY,
    };
    const challenge = await BG.Challenge.create(bgConfig);
    if (!challenge) throw new Error("no BotGuard challenge");
    const js = challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
    if (!js) throw new Error("no BotGuard interpreter");
    // eslint-disable-next-line no-new-func
    new Function(js)();
    const r = await BG.PoToken.generate({ program: challenge.program, globalName: challenge.globalName, bgConfig });
    const token = typeof r === "string" ? r : r?.poToken;
    if (!token) throw new Error("empty po token");
    return token;
  } finally {
    if (prev.window === undefined) delete globalThis.window; else globalThis.window = prev.window;
    if (prev.document === undefined) delete globalThis.document; else globalThis.document = prev.document;
    try { dom.window.close(); } catch { /* ignore */ }
  }
}

/** Resolves a PO token bound to `identifier`, or null (never rejects). */
export function getPoToken(identifier) {
  if (!identifier) return Promise.resolve(null);
  const hit = cache.get(identifier);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.token);
  if (inflight.has(identifier)) return inflight.get(identifier);

  const t0 = Date.now();
  const run = chain.then(() =>
    Promise.race([
      mintOnce(identifier),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${MINT_TIMEOUT_MS}ms`)), MINT_TIMEOUT_MS)),
    ])
  );
  const p = run
    .then((token) => {
      log(`minted for ${identifier.slice(0, 11)}… in ${Date.now() - t0}ms`);
      if (cache.size > 200) cache.delete(cache.keys().next().value);
      cache.set(identifier, { token, expires: Date.now() + TTL_MS });
      return token;
    })
    .catch((err) => {
      log(`mint failed for ${identifier.slice(0, 11)}…: ${String(err?.message || err).slice(0, 140)}`);
      return null;
    })
    .finally(() => inflight.delete(identifier));
  chain = p.then(() => {}, () => {});
  inflight.set(identifier, p);
  return p;
}

export const withPot = (url, token) => {
  try {
    const u = new URL(url);
    u.searchParams.set("pot", token);
    return u.toString();
  } catch {
    return url;
  }
};
