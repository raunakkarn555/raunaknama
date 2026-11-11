// Maps a search-result payload (modern "grid" shape) to flat card objects.
// The sample below simulates the upstream response so the UI can be built
// and tested without network access; swap it for a real fetch later.

const DEMO = [
  ["Midnight Drive", "Neon Harbor"], ["A Very Long Track Title That Needs Truncating Properly", "The Extraordinarily Named Collective"],
  ["Slow Rivers", "Aanya Rao"], ["Paper Planes", "Kite & Co."], ["Golden Hour", "Marlow"], ["Static Bloom", "Velvet Circuit"],
  ["Monsoon Letters", "Ishaan Mehta"], ["Low Tide", "Saltwater Radio"], ["City of Glass", "Rhea Kapoor"], ["Afterglow", "Juno Park"],
  ["Evergreen", "Pine & Wire"], ["Orbit", "Little Satellite"],
];

const demoItem = ([title, artist], i) => {
  const n = String(i + 1).padStart(2, "0");
  return {
    videoRenderer: {
      videoId: `sim_trck_${n}`,
      trackingParams: `CAkQ-r8DIhMI_demo_${n}`,
      title: { runs: [{ text: title }] },
      ownerText: { runs: [{ text: artist }] },
      lengthText: { simpleText: `${2 + (i % 4)}:${String((i * 17) % 60).padStart(2, "0")}` },
      thumbnail: {
        thumbnails: [
          { url: `https://picsum.photos/seed/sim${n}/120/120`, width: 120, height: 120 },
          { url: `https://picsum.photos/seed/sim${n}/640/640`, width: 640, height: 640 },
        ],
      },
    },
  };
};

export const SIMULATED_SEARCH_RESPONSE = {
  contents: {
    twoColumnSearchResultsRenderer: {
      primaryContents: {
        sectionListRenderer: {
          contents: [
            { itemSectionRenderer: { contents: [...DEMO.map(demoItem), { adSlotRenderer: {} }] } },
          ],
        },
      },
    },
  },
};

const text = (node) =>
  node?.simpleText ?? (Array.isArray(node?.runs) ? node.runs.map((r) => r?.text ?? "").join("") : "");

/** "1:02:10" -> 3730 ; returns null if unparseable. */
export function durationToSeconds(label) {
  if (typeof label !== "string" || !/^\d+(:\d{1,2}){1,2}$/.test(label)) return null;
  return label.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
}

function bestThumbnail(list) {
  if (!Array.isArray(list)) return null;
  const sorted = list
    .filter((t) => typeof t?.url === "string" && /^https:\/\//.test(t.url))
    .sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0));
  return sorted[0]?.url ?? null;
}

export function parseSearchResults(raw) {
  const sections =
    raw?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
  if (!Array.isArray(sections)) return [];

  const items = [];
  for (const section of sections) {
    for (const entry of section?.itemSectionRenderer?.contents ?? []) {
      const v = entry?.videoRenderer;
      if (!v?.videoId) continue;
      const durationLabel = text(v.lengthText);
      items.push({
        id: v.videoId,
        trackingToken: v.trackingParams ?? null,
        title: text(v.title) || "Untitled",
        subtitle: text(v.ownerText) || "Unknown artist",
        duration: durationLabel || null,
        durationSeconds: durationToSeconds(durationLabel),
        thumbnailUrl: bestThumbnail(v.thumbnail?.thumbnails),
      });
    }
  }
  return items;
}
