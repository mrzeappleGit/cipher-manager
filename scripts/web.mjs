// One-command local web app: build the frontend, then build & run the server.
//
//   npm run web                 -> http://localhost:4600
//   npm run web -- --port 8080  -> pass flags through to the server
//   npm run web -- --host 0.0.0.0

import { spawnSync } from "node:child_process";
import { utimesSync } from "node:fs";

const isWin = process.platform === "win32";

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: isWin });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

console.log("\n[1/2] Building web frontend…");
run("npm", ["run", "build"]);

// The server embeds ./dist at compile time via include_dir, which does not
// auto-detect dist changes on stable Rust. Bump serve.rs's mtime so cargo
// recompiles it and re-embeds the freshly built assets.
try {
  const now = new Date();
  utimesSync("src-tauri/src/bin/serve.rs", now, now);
} catch {
  /* non-fatal */
}

console.log("\n[2/2] Starting server (Ctrl+C to stop)…\n");
run("cargo", [
  "run",
  "--quiet",
  "--manifest-path",
  "src-tauri/Cargo.toml",
  "--bin",
  "serve",
  "--",
  ...process.argv.slice(2),
]);
