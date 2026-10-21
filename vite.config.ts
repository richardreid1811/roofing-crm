import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 2000 },
  optimizeDeps: { exclude: ["@duckdb/duckdb-wasm"] },
  // `npm run dev` serves the UI; run `wrangler dev` in a second terminal for /api.
  server: { proxy: { "/api": "http://localhost:8787" } },
});
