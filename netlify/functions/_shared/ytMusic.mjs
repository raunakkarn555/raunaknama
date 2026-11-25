// YouTube Music "Songs" search (audio tracks with real artist / album data and
// square cover art) built on youtubei.js — the same library the stream resolver
// uses. This is what powers the "Songs" results on the search page and the
// "Songs" tab of the artist page, instead of plain YouTube *videos*.
//
// A separate, light Innertube session is used on purpose: no player download,
// no cookies, created locally (no network round trip) so a cold start is cheap.
// If YouTube rejects the locally generated session it is rebuilt once with a
// real (network) session before giving up.

const LOG = process.env.STREAM_LOG !== "0";
const log = (...a) => { if (LOG) console.log("[ytmusic]", ...a); };

let clientPromise = null;
let networkClientPromise = null;

async function createClient({ local }) {
  const { Innertube, Log } = await import("youtubei.js");
  try { Log.setLevel(Log.Level.NONE); } catch { /* older/newer API */ }
  return Innertube.create({
    enable_session_cache: false,
    retrieve_player: false,
    generate_session_locally: local,
  });
}

function getClient({ network = false } = {}) {
  if (network) {
    if (!networkClientPromise) {
      networkClientPromise = createClient({ local: false }).catch((err) => { networkClientPromise = null; throw err; });
    }
    return networkClientPromise;
  }
  if (!clientPromise) {
    clientPromise = createClient({ local: true }).catch((err) => { clientPromise = null; throw err; });
  }
  return clientPromise;
}

// Start building the session as soon as the function instance boots.
getClient().catch(() => {});

const withTimeout = (p, ms, label) => {
  let t;
  return Promise.race([
    p,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(t));
};

// Google-hosted covers end in "=w60-h60-…" / "=s120": ask for a sharper one.
const hiRes = (url) =>
  typeof url === "string"
    ? url.replace(/=w\d+-h\d+[^/?]*$/, "=w544-h544-l90-rj").replace(/=s\d+[^/?]*$/, "=s544")
    : null;

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function toSong(item) {
  const id = item?.id;
  if (!id || !/^[\w-]{11}$/.test(id) || item.item_type !== "song") return null;
  const artists = (item.artists || []).map((a) => String(a?.name || "").trim()).filter(Boolean);
  const secs = Number(item.duration?.seconds) || 0;
  const thumbs = item.thumbnails || [];
  return {
    id,
    title: String(item.title || "").trim() || "Untitled",
    channel: artists.join(", "), // same field name the YouTube results / Player use
    artists,
    album: item.album?.name || null,
    duration: secs || null, // seconds (Player formats it)
    durationLabel: secs ? fmt(secs) : null,
    thumbnailUrl: hiRes(thumbs[thumbs.length - 1]?.url),
    isMusic: true,
  };
}

function collectSongs(res) {
  const out = [];
  for (const section of res?.contents || []) {
    for (const item of section?.contents || []) {
      const s = toSong(item);
      if (s) out.push(s);
    }
  }
  return out;
}

async function runSearch(query, { network }) {
  const yt = await getClient({ network });
  return collectSongs(await yt.music.search(query, { type: "song" }));
}

/** Songs for `query` (music tracks only — never plain videos). Rejects on failure. */
export async function searchSongs(query, { timeoutMs = 7000 } = {}) {
  const t0 = Date.now();
  try {
    const songs = await withTimeout(runSearch(query, { network: false }), timeoutMs, "music search");
    if (songs.length) return songs;
    // Empty is legitimate for odd queries, but it is also what a rejected local
    // session looks like — one retry with a real session settles it.
    return await withTimeout(runSearch(query, { network: true }), timeoutMs, "music search (network session)");
  } catch (err) {
    log(`"${query}" failed after ${Date.now() - t0}ms: ${String(err?.message || err).slice(0, 140)}`);
    return withTimeout(runSearch(query, { network: true }), timeoutMs, "music search (network session)");
  }
}
