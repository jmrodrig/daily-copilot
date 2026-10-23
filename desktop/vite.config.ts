import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const BACKEND = "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      devOptions: {
        enabled: true
      },
      includeAssets: ["favicon.ico", "favicon.svg", "apple-touch-icon.png"],
      // The app's one bundle has outgrown workbox's 2 MiB default; past it the bundle isn't precached and the build fails.
      workbox: { maximumFileSizeToCacheInBytes: 4 * 1024 * 1024 },
      manifest: {
        name: "Daily Copilot",
        short_name: "Copilot",
        start_url: "/",
        display: "standalone",
        display_override: ["window-controls-overlay", "standalone"],
        theme_color: "#101820",
        background_color: "#101820",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
  server: {
    allowedHosts: true,
    // The backend serves its routes under /api, except /health which lives at the root.
    proxy: {
      "/api": BACKEND,
      "/health": BACKEND,
    },
  },
});
