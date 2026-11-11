// Quick localhost check of the stream resolver pipeline.
//
//   node test-resolver.mjs                 # 5 built-in songs
//   node test-resolver.mjs ID1 ID2 ...     # your own YouTube video ids
//   node test-resolver.mjs --fallback      # Piped-first mode (what ?fallback=true does)
//
// For every song it resolves a stream URL exactly like /api/stream does,
// measures the time in ms, then sends a Range request (bytes=0-1023) to the
// returned URL — and to each backup URL — and expects HTTP 200 / 206.
// Run from a normal (non-datacenter) connection for the most realistic result.

import { resolveStreamFast } from "./netlify/functions/_shared/streamResolver.mjs";
import { PIPED_INSTANCES } from "./netlify/functions/_shared/pipedResolver.mjs";

const SONGS = [
  { id: "dQw4w9WgXcQ", label: "Rick Astley - Never Gonna Give You Up (music video)" },
  { id: "JGwWNGJdvx8", label: "Ed Sheeran - Shape of You (music video)" },
  { id: "kJQP7kiw5Fk", label: "Luis Fonsi - Despacito (music video)" },
  { id: "60ItHLz5WEA", label: "Alan Walker - Faded (official audio-style upload)" },
  { id: "9bZkp7q19f0", label: "PSY - Gangnam Style (music video)" },
];

const args = process.argv.slice(2);
const fallback = args.includes("--fallback");
const ids = args.filter((a) => !a.startsWith("--"));
const songs = ids.length ? ids.map((id) => ({ id, label: id })) : SONGS;

async function probe(url) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { Range: "bytes=0-1023", "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    const bytes = res.body ? (await res.arrayBuffer()).byteLength : 0;
    return { status: res.status, ok: res.status === 200 || res.status === 206, bytes, ms: Date.now() - t0 };
  } catch (e) {
    return { status: e.name === "TimeoutError" ? "timeout" : "error", ok: false, bytes: 0, ms: Date.now() - t0, err: e.message };
  }
}

console.log(`Node ${process.version} | Piped instances: ${PIPED_INSTANCES.join(", ") || "none"} | mode: ${fallback ? "fallback" : "normal"}\n`);

let pass = 0;
const times = [];
for (const s of songs) {
  console.log(`▶ ${s.label}  [${s.id}]`);
  const t0 = Date.now();
  let hit = null;
  try {
    hit = await resolveStreamFast(s.id, { fallback });
  } catch (e) {
    console.log(`  ✗ resolver threw: ${e.message}`);
  }
  const ms = Date.now() - t0;
  if (!hit) {
    console.log(`  ✗ no stream resolved (${ms} ms)\n`);
    continue;
  }
  times.push(ms);
  const main = await probe(hit.url);
  console.log(`  resolved via ${hit.client}${hit.itag ? ` (itag ${hit.itag})` : ""} in ${ms} ms`);
  console.log(`  primary  : HTTP ${main.status} ${main.ok ? "✓ playable" : "✗"} (${main.bytes} bytes, ${main.ms} ms)`);
  let anyOk = main.ok;
  for (const b of hit.fallbacks || []) {
    const r = await probe(b.url);
    anyOk ||= r.ok;
    console.log(`  backup   : ${b.client} HTTP ${r.status} ${r.ok ? "✓ playable" : "✗"} (${r.ms} ms)`);
  }
  if (anyOk) pass++;
  console.log();
}

const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
console.log(`Result: ${pass}/${songs.length} songs playable | avg resolve ${avg} ms`);
process.exit(pass === songs.length ? 0 : 1);
