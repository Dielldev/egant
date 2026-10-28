import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The landing page: its own entry point, borrowing the desktop's mark and
// provider logos from `../src` so the site and the app never drift apart.
// Vercel serves the site at the root, so absolute asset paths are correct on
// every route (client-side routed pages included).
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/",
  plugins: [react()],
  resolve: {
    alias: { "@egant": fileURLToPath(new URL("../src", import.meta.url)) },
  },
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 1440,
    // Screenshots live in ../docs, the mark and logos in ../src.
    fs: { allow: [".."] },
  },
});
