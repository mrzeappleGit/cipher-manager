// Tauri's beforeBuildCommand: build both embedded frontends, then the sidecar.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, utimesSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
  return result;
}

const rust = run("rustc", ["-vV"], { encoding: "utf8", stdio: "pipe" });
const triple = rust.stdout.match(/^host: (\S+)$/m)?.[1];
if (!triple || triple !== "x86_64-pc-windows-msvc") {
  throw new Error("The beta installer currently targets Windows x64 MSVC only.");
}
if (process.env.TAURI_ENV_TARGET_TRIPLE && process.env.TAURI_ENV_TARGET_TRIPLE !== triple) {
  throw new Error("Cross-compiling the server sidecar is not supported by this release script.");
}

for (const script of ["build", "build:snapshot"]) {
  // npm supplies its JS entrypoint when used as beforeBuildCommand/npm run.
  if (process.env.npm_execpath) run(process.execPath, [process.env.npm_execpath, "run", script]);
  else run("npm.cmd", ["run", script], { shell: true });
}

// include_dir does not track changes on stable Rust. Force a fresh embedding.
const now = new Date();
utimesSync(path.join(root, "src-tauri/src/bin/serve.rs"), now, now);
const env = { ...process.env };
delete env.CARGO_BUILD_TARGET;
const config = JSON.parse(env.TAURI_CONFIG || "{}");
// Break the bootstrap dependency: the initial server build cannot bundle itself.
env.TAURI_CONFIG = JSON.stringify({ ...config, bundle: { ...config.bundle, externalBin: [] } });
run("cargo", ["build", "--release", "--manifest-path", "src-tauri/Cargo.toml", "--bin", "serve"], { env });

const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(root, process.env.CARGO_TARGET_DIR)
  : path.join(root, "src-tauri/target");
const binaries = path.join(root, "src-tauri/binaries");
mkdirSync(binaries, { recursive: true });
copyFileSync(path.join(targetDir, "release/serve.exe"), path.join(binaries, `serve-${triple}.exe`));
console.log(`Bundled server prepared: serve-${triple}.exe`);
