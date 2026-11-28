import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Safety net: if this app is ever opened directly via `vite` (port 5173)
    // instead of `netlify dev`, still forward /api/* to a locally running
    // Netlify Functions dev server (`netlify functions:serve`, port 9999)
    // instead of falling through to Vite's SPA/index.html fallback — that
    // fallback (returning index.html for unmatched routes) is what caused
    // the "Unexpected token '<'" JSON parse errors: fetch('/api/playlists')
    // was getting index.html back instead of real JSON.
    host: true, // reachable from a phone on the same Wi-Fi (http://<pc-ip>:5173)
    proxy: {
      // changeOrigin stays OFF on purpose: the stream function builds the audio-proxy URL from the
      // request's Host header. With changeOrigin it became http://localhost:9999/... which a phone
      // can't reach, so songs failed to stream and fell back to the YouTube player (dies on lock).
      "/api": {
        target: "http://localhost:9999",
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/, "/.netlify/functions"),
      },
      "/.netlify": { target: "http://localhost:9999", changeOrigin: false },
    },
  },
});
