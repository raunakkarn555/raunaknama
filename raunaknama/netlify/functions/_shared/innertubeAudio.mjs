import https from "node:https";
import http from "node:http";

// Native-https helper: POST a player request, pick the highest-bitrate audio
// format, return its URL. No third-party dependencies.
//
// NOTE: client name/version and host/path are configurable because these
// values change often on the provider side. If requests start returning
// empty `streamingData`, the client config is the first thing to update.

const DEFAULTS = {
  hostname: "www.youtube.com",
  path: "/youtubei/v1/player?prettyPrint=false",
  client: {
    clientName: "ANDROID_VR",
    clientVersion: "1.60.19",
    hl: "en",
    gl: "US",
  },
  userAgent: "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
  timeoutMs: 10_000,
  maxBytes: 5 * 1024 * 1024,
};

// Fallback ladder. A single client config silently stops working for a share
// of videos (login-required / PO-token / region gated) — each client below is
// gated differently, so asking several in parallel recovers most of them.
// Order = preference: first one that yields a usable audio URL wins.
export const CLIENTS = [
  {
    name: "ANDROID_VR",
    client: DEFAULTS.client,
    userAgent: DEFAULTS.userAgent,
  },
  {
    // Newer build of the same (PO-token-free) VR client — some videos that
    // are refused to the older build are served to this one.
    name: "ANDROID_VR2",
    client: {
      clientName: "ANDROID_VR",
      clientVersion: "1.65.10",
      deviceMake: "Oculus",
      deviceModel: "Quest 3",
      androidSdkVersion: 32,
      osName: "Android",
      osVersion: "12L",
      hl: "en",
      gl: "US",
    },
    userAgent: "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
  },
  {
    name: "IOS",
    client: {
      clientName: "IOS",
      clientVersion: "20.10.4",
      deviceMake: "Apple",
      deviceModel: "iPhone16,2",
      osName: "iPhone",
      osVersion: "18.3.2.22D82",
      hl: "en",
      gl: "US",
    },
    userAgent: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
  },
  {
    name: "ANDROID",
    client: {
      clientName: "ANDROID",
      clientVersion: "20.10.38",
      androidSdkVersion: 30,
      osName: "Android",
      osVersion: "11",
      hl: "en",
      gl: "US",
    },
    userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
  },
  {
    name: "TV_EMBEDDED",
    client: {
      clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER",
      clientVersion: "2.0",
      hl: "en",
      gl: "US",
    },
    thirdParty: true,
    userAgent: "Mozilla/5.0 (SMART-TV; Linux; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.5 TV Safari/537.36",
  },
];

const CLIENT_TIMEOUT_MS = 3500;
const VALIDATE_TIMEOUT_MS = 2500;
// After the first client succeeds, wait at most this long for a client that
// is higher in the preference order before settling for what we have.
const PREFERENCE_GRACE_MS = 350;

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Minimal JSON POST using only node:https. Resolves with the parsed body. */
export function postJson({ hostname, path, body, headers = {}, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);

    const req = https.request(
      {
        hostname,
        path,
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Accept: "application/json",
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;

        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new Error("Response too large"));
            return;
          }
          chunks.push(chunk);
        });

        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = new Error(`Upstream responded with HTTP ${res.statusCode}`);
            err.statusCode = res.statusCode;
            return reject(err);
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("Upstream returned invalid JSON"));
          }
        });

        res.on("error", reject);
      }
    );

    req.on("timeout", () => req.destroy(new Error("Upstream request timed out")));
    req.on("error", reject);
    req.end(payload);
  });
}

/**
 * Returns the URL of the highest-bitrate audio-only format, or null if the
 * response has no usable audio format.
 */
export function pickBestAudioUrl(data) {
  const formats = data?.streamingData?.adaptiveFormats;
  if (!Array.isArray(formats)) return null;

  const usable = formats.filter(
    (f) =>
      typeof f?.mimeType === "string" &&
      f.mimeType.startsWith("audio/") &&
      typeof f.url === "string" && // ciphered formats have no plain `url`
      f.url.length > 0
  );
  const byBitrate = (a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0);

  // AAC/m4a first: every browser (Chrome, Firefox, Safari/iOS) can play it.
  // webm/opus is only used when no m4a exists — iOS Safari rejects it with
  // a "format error", which showed up as "Couldn't play this track".
  const m4a = usable.filter((f) => f.mimeType.startsWith("audio/mp4")).sort(byBitrate)[0];
  const best = m4a || usable.sort(byBitrate)[0];

  return best?.url ?? null;
}

/**
 * Cheap server-side probe: asks the CDN for the first 2 bytes of the URL.
 * Throws-free; resolves false ONLY when the CDN explicitly refuses the URL
 * (403/404/410… — e.g. PO-token-gated URLs from the IOS/ANDROID clients,
 * which used to reach the browser and show up as "Couldn't play this track").
 * A timeout/network hiccup counts as "unknown" => treated as usable.
 */
export function probeAudioUrl(url, userAgent, timeoutMs = VALIDATE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return resolve(false);
    }
    const lib = u.protocol === "http:" ? http : https;
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        method: "GET",
        timeout: timeoutMs,
        headers: { Range: "bytes=0-1", "User-Agent": userAgent, Accept: "*/*" },
      },
      (res) => {
        const ok = res.statusCode >= 200 && res.statusCode < 400;
        res.destroy(); // never download the body
        finish(ok);
      }
    );
    req.on("timeout", () => {
      req.destroy();
      finish(true);
    });
    req.on("error", () => finish(true));
    req.end();
  });
}

async function askClient(videoId, c) {
  const context = { client: c.client };
  if (c.thirdParty) context.thirdParty = { embedUrl: "https://www.youtube.com/" };

  const data = await postJson({
    hostname: DEFAULTS.hostname,
    path: DEFAULTS.path,
    timeoutMs: CLIENT_TIMEOUT_MS,
    maxBytes: DEFAULTS.maxBytes,
    headers: { "User-Agent": c.userAgent },
    body: { videoId, contentCheckOk: true, racyCheckOk: true, context },
  });

  const status = data?.playabilityStatus?.status;
  if (status && status !== "OK") return null; // LOGIN_REQUIRED / UNPLAYABLE for this client
  const url = pickBestAudioUrl(data);
  if (!url) return null;
  // Drop URLs the CDN itself rejects, so the next client gets a chance
  // inside this same request instead of the browser failing later.
  return (await probeAudioUrl(url, c.userAgent)) ? url : null;
}

/**
 * Resolves { url, client } as fast as possible. All clients are asked in
 * parallel; the first one that yields a *verified* audio URL wins, with a
 * very short grace window for a more-preferred client that is about to
 * finish too. Worst case costs one timeout, not four in a row.
 * `exclude` lets a retry skip the client whose URL just failed in the browser.
 */
export async function resolveAudio(videoId, { exclude = [] } = {}) {
  if (typeof videoId !== "string" || !VIDEO_ID_RE.test(videoId)) {
    const err = new Error("Invalid videoId");
    err.statusCode = 400;
    throw err;
  }

  const skip = new Set(Array.isArray(exclude) ? exclude : [exclude]);
  let list = CLIENTS.filter((c) => !skip.has(c.name));
  if (!list.length) list = CLIENTS;

  return new Promise((resolve) => {
    const results = new Array(list.length).fill(undefined); // undefined = pending, null = failed
    let settled = false;
    let graceTimer = null;

    const finish = (hit) => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      resolve(hit);
    };

    // Best (most preferred) result available right now, but only if no
    // higher-preference client is still pending.
    const pickIfDecided = () => {
      for (let i = 0; i < results.length; i++) {
        if (results[i] === undefined) return null; // a better one may still arrive
        if (results[i]) return results[i];
      }
      return false; // everything failed
    };

    const onUpdate = () => {
      if (settled) return;
      const decided = pickIfDecided();
      if (decided) return finish(decided);
      if (decided === false) return finish(null);
      // Something succeeded but a preferred client is still pending: allow a
      // short grace window, then take the best available.
      if (results.some(Boolean) && !graceTimer) {
        graceTimer = setTimeout(() => {
          finish(results.find(Boolean) || null);
        }, PREFERENCE_GRACE_MS);
      }
    };

    list.forEach((c, i) => {
      askClient(videoId, c)
        .then((url) => {
          results[i] = url ? { url, client: c.name } : null;
        })
        .catch(() => {
          results[i] = null;
        })
        .finally(onUpdate);
    });
  });
}

export async function getBestAudioUrl(videoId, options = {}) {
  const hit = await resolveAudio(videoId, options);
  return hit?.url ?? null;
}
