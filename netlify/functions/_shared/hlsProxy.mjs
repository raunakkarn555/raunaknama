import { requestUpstream } from "./googlevideo.mjs";
import { createProxyToken } from "./audioProxyToken.mjs";

// HLS fallback. When the plain itag-140 url is cut after ~850 KB (no PO token),
// the same IOS response also carries an HLS manifest. HLS segments are separate
// short requests that googlevideo does not PO-token-gate. This turns that
// manifest into ONE audio-only media playlist whose manifest/segment urls all go
// through audio-proxy (right User-Agent / IP, CORS-safe), so hls.js (or native
// HLS) can play it.

const SEG_TTL_MS = 3 * 60 * 60 * 1000;

async function fetchText(url, userAgent) {
  const res = await requestUpstream({ url, userAgent, timeoutMs: 8000 });
  if (res.statusCode !== 200) {
    res.destroy();
    throw new Error(`HLS HTTP ${res.statusCode}`);
  }
  let out = "";
  for await (const chunk of res) {
    out += chunk.toString("utf8");
    if (out.length > 2_000_000) break;
  }
  return out;
}

const itagOf = (u) => Number(/\/itag\/(\d+)/.exec(u)?.[1]) || 0;

function pickMedia(master, base) {
  const lines = master.split(/\r?\n/);
  const audio = [];
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.startsWith("#EXT-X-MEDIA") && /TYPE=AUDIO/i.test(l)) {
      const m = /URI="([^"]+)"/.exec(l);
      if (m) audio.push(new URL(m[1], base).toString());
    } else if (l.startsWith("#EXT-X-STREAM-INF")) {
      const bw = Number(/BANDWIDTH=(\d+)/.exec(l)?.[1]) || Infinity;
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || lines[j].startsWith("#"))) j++;
      if (lines[j]) variants.push({ url: new URL(lines[j].trim(), base).toString(), bw });
    }
  }
  if (audio.length) {
    // AAC 128k (234) first, then 48k (233), then whatever is there.
    return audio.find((u) => itagOf(u) === 234) || audio.find((u) => itagOf(u) === 233) || audio[0];
  }
  if (variants.length) return variants.sort((a, b) => a.bw - b.bw)[0].url; // smallest muxed rendition
  return null;
}

/** Fetches the manifest, picks the audio rendition and returns its playlist with every url proxied. */
export async function buildMediaPlaylist({ manifestUrl, userAgent, origin }) {
  const master = await fetchText(manifestUrl, userAgent);
  if (!master.includes("#EXTM3U")) throw new Error("not an HLS manifest");
  let mediaUrl = manifestUrl;
  let text = master;
  if (/#EXT-X-STREAM-INF|#EXT-X-MEDIA/.test(master)) {
    mediaUrl = pickMedia(master, manifestUrl);
    if (!mediaUrl) throw new Error("no audio rendition in HLS manifest");
    text = await fetchText(mediaUrl, userAgent);
    if (!text.includes("#EXTINF")) throw new Error("HLS media playlist has no segments");
  }
  const proxy = (u) => {
    const abs = new URL(u, mediaUrl).toString();
    const t = createProxyToken({ url: abs, userAgent, kind: "seg", ttlMs: SEG_TTL_MS });
    return `${origin}/.netlify/functions/audio-proxy?t=${t}`;
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      const l = line.trim();
      if (!l) return line;
      if (l.startsWith("#")) return l.replace(/URI="([^"]+)"/g, (_, u) => `URI="${proxy(u)}"`);
      return proxy(l);
    })
    .join("\n");
}
