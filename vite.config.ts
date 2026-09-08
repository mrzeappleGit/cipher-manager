/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const host = process.env.TAURI_DEV_HOST;

// `--mode snapshot` produces a single self-contained HTML file (into
// dist-snapshot/) used to build the shareable snapshot page.
export default defineConfig(({ mode }) => {
  const snapshot = mode === "snapshot";
  return {
    plugins: [react(), tailwindcss(), ...(snapshot ? [viteSingleFile()] : [])],

    test: {
      environment: "happy-dom",
      setupFiles: ["src/test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
    },

    // Vite options tailored for Tauri development
    clearScreen: false,
    build: {
      outDir: snapshot ? "dist-snapshot" : "dist",
      emptyOutDir: true,
    },
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
      watch: {
        // Tell Vite to ignore watching `src-tauri`
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});
