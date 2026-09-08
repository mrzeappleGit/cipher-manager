import { defineConfig } from "vite";

// Single-file-ish output; the Even app hosts dist/ as a local web app.
export default defineConfig({
  base: "./",
  build: { target: "es2020" },
});
