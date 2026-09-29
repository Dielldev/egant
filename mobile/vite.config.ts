import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The phone app: its own entry point, sharing the desktop's transcript fold,
// types and chat components from `../src`. The build lands in `mobile/dist`,
// which the desktop app serves (and, in release builds, carries inside its
// binary) — see `src-tauri/src/mobile/assets.rs`.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    // The desktop app's own source, shared rather than copied.
    alias: { "@egant": fileURLToPath(new URL("../src", import.meta.url)) },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // One bundle for a PWA that loads once and is then cached.
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 1430,
    strictPort: true,
    host: true,
    // Working on the phone UI against a running egant: its API, proxied, so
    // the page and the API share an origin the way they do in production.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:47247",
        changeOrigin: true,
      },
    },
  },
});
