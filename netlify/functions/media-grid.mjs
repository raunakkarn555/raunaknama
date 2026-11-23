import { parseSearchResults, SIMULATED_SEARCH_RESPONSE } from "./_shared/mediaSearchParser.mjs";

// GET /api/media-grid  ->  { items: [...] }  (simulated data for UI work)
export const handler = async () => ({
  statusCode: 200,
  headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" },
  body: JSON.stringify({ items: parseSearchResults(SIMULATED_SEARCH_RESPONSE) }),
});
