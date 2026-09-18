import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const vitePort = Number(process.env.VITE_PORT) || 1420;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available.
  // `VITE_PORT` overrides the default so multiple local sessions can run side
  // by side (e.g. `VITE_PORT=1421`); `strictPort` keeps the bind loud instead
  // of silently drifting to another port Tauri isn't pointed at.
  server: {
    port: vitePort,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          // HMR needs its own port — one past the dev server so it never
          // collides with it (or with a sibling session's dev server).
          port: vitePort + 1,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
