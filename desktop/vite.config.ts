import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const BACKEND = "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    // The backend serves its routes under /api, except /health which lives at the root.
    proxy: {
      "/api": BACKEND,
      "/health": BACKEND,
    },
  },
});
