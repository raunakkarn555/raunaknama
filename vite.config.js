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
    proxy: {
      "/api": {
        target: "http://localhost:9999",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, "/.netlify/functions"),
      },
    },
  },
});
