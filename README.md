# cipherManager

A Windows desktop workspace for local agent history, search, notes and interactive agent sessions. Built with Tauri 2, React and Rust. Licensed under [MIT](LICENSE).

The first downloadable release targets **Windows x64**. Android, Even G2 and Stream Deck companion source is included for experimentation; those companions are not part of the supported Windows installer.

## Features

- Browse Claude, Codex and Antigravity project/session history with usage analytics and search.
- Read documents and vault notes; optionally ask an AI provider to answer with sources.
- Run interactive agent sessions through the bundled local server.
- Optional calendar/tasks, meeting notes, automations, screenshots, voice, Scribe, package tracking and video tools.

Advanced integrations require your own tools, accounts and configuration. See [dependencies and server lifecycle](docs/dependencies.md). Demo data is fictional and labeled in the UI.

## Install and first launch

Download the Windows installer from [GitHub Releases](https://github.com/mrzeappleGit/cipher-manager/releases). Beta builds may be unsigned; check the release notes and published checksums. Installers are intended for the current Windows user.

1. Open cipherManager. It discovers supported history in your Windows user profile; an empty profile should show empty history without requiring any agent installation.
2. In Settings, select a vault folder only if you want vault features. Configure only the integrations you need.
3. To use interactive Agents, install and sign in to your preferred agent CLI. Start the bundled server through Settings → Remote access.
4. Acting mode starts off. Enable it only when you want the app to launch jobs, scripts or agents.
5. Configure credentials in the desktop app. Calendar URLs, notification topics and cloud snapshots may also contain private information; keep them out of public issues.

Closing the window hides it in the tray. Quitting the desktop UI does not terminate the separate server or its agent sessions. Stop active work and use the server's Stop control before upgrading or uninstalling; see [Windows testing](docs/testing-windows.md).

## Privacy

Reading history is local. Optional integrations send the inputs needed for their functions to the configured providers. For example, AI summaries send text, transcription sends audio, and SSH snapshot publishing can upload recent notes and calendar data. Nothing is published to a default personal website.

Credentials use Windows Credential Manager. Other app settings and state are stored under the user's `.claude/cipher-manager` directory. Cloud publishing is off by default and requires an explicit destination whose access controls you manage.

Read [SECURITY.md](SECURITY.md) before enabling remote access or publishing a snapshot.

## Build from source

Use Node.js 22 or newer, a current Rust stable toolchain, and the [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/): Microsoft C++ Build Tools and WebView2.

```powershell
npm ci
npm run tauri dev
```

The web-only development preview uses fictional data:

```powershell
npm run dev
```

Checks:

```powershell
npm test
node --test scripts/export-public.test.mjs
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo check --manifest-path src-tauri/Cargo.toml --bins
```

Windows installer (builds the frontend, snapshot template and bundled server):

```powershell
npm run release
```

Artifacts are written under `src-tauri/target/release/bundle/nsis/`. Signing and publication are separate from compiling.

For a standalone live web server, run `npm run web`. It embeds the frontend at compile time, so rebuild after UI changes. Server access is powerful: it includes file and execution operations, not just a read-only dashboard. Keep it on loopback or a private authenticated network.

## Development layout

- `src/api.ts`: desktop/web/snapshot dispatch.
- `src/pages/` and `src/lib/`: React views and frontend stores.
- `src-tauri/src/commands.rs`: shared backend commands.
- `src-tauri/src/bin/serve.rs`: the HTTP server and PTY session host.
- `src-tauri/src/service.rs`: desktop management of the bundled server.
- `scripts/`: builds, checks and public-source preparation.

Backend commands are registered in `lib.rs`, exposed in `api.ts`, and added to `serve.rs` when web access is intended. Settings are frontend-owned and mirrored to disk; execution authorization is enforced again by the backend.

See [release preparation](docs/releasing.md), [third-party notices](THIRD_PARTY_NOTICES.md) and the [roadmap](ROADMAP.md). Avoid live/ignored integration tests unless you intend their external side effects.
