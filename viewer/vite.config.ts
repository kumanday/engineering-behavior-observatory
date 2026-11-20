import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { viewerSourceDigest } from "./source-digest.mjs";

const viewerDir = dirname(fileURLToPath(import.meta.url));
/** Records which sources this build came from, so a server can tell a stale viewer/dist from a current one. */
const buildStamp = (): Plugin => ({
  name: "ebo-build-stamp", apply: "build",
  closeBundle() { writeFileSync(join(viewerDir, "dist", "build-stamp.json"), `${JSON.stringify({ sourceDigest: viewerSourceDigest(viewerDir) })}\n`); },
});

export default defineConfig({
  plugins: [buildStamp()],
  base: "./",                       // served by `ebo atlas serve` and opened from packets as plain static files
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 8000,
    // Stable file names: rebuilds overwrite in place instead of accumulating hashed copies.
    rolldownOptions: { output: { entryFileNames: "assets/[name].js", chunkFileNames: "assets/[name].js", assetFileNames: "assets/[name][extname]" } },
    rollupOptions: { output: { entryFileNames: "assets/[name].js", chunkFileNames: "assets/[name].js", assetFileNames: "assets/[name][extname]" } },
  },
  optimizeDeps: { exclude: ["@duckdb/duckdb-wasm"] },
  worker: { format: "es", rollupOptions: { output: { entryFileNames: "assets/[name].js" } } },
});
