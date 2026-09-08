# Windows installation and optional integrations

The Windows x64 NSIS installer includes the desktop app and its matching `serve.exe` local server. It does not install agent CLIs, model runtimes, media tools or integration credentials. WebView2 is required by Tauri; the installer handles its installation when needed. Internet access may be needed for that first installation.

Open Settings → Local server and choose **Start server** for interactive agent sessions or the local web app at `http://127.0.0.1:4600`. Starting is explicit and binds only to loopback. The app verifies the server identity and version; an unrelated process on port 4600 is reported rather than killed. Start/stop controls are desktop-only.

Closing or quitting the desktop UI leaves the server and its agent sessions running. Use **Stop server** explicitly after ending active agent sessions, jobs and recordings. The authenticated shutdown checks for active work and refuses to interrupt it. If a request is still finishing, retry after it completes. The server is a user process, not a Windows Service; rebooting Windows stops it. Existing custom login launchers are independent of this setting.

Before upgrading or uninstalling, finish active work and stop the server from Settings. Quit the desktop app from its tray menu, then run the installer or Windows uninstall. Never replace an in-use `serve.exe`; Windows may report it locked. After upgrading, start the new bundled server. A compatible older server is identified by version and can be stopped explicitly; an older server without the lifecycle protocol must be stopped using its original launcher. User data and credentials belong to the Windows account; back them up separately before changing machines. See testing-windows.md for the recorded Sandbox upgrade/uninstall checks and remaining manual checks.

| Optional feature | Install/configure only if used |
| --- | --- |
| Claude Code, Codex or Gemini sessions and jobs | Install the chosen CLI separately, sign in using its own setup, and configure its executable path in Settings. The app does not bundle CLI licenses or accounts. |
| Local web/phone access | The bundled server covers local use. Remote access requires a deliberate network bind and its access token. Tailscale is optional for private remote access; use the pairing controls rather than exposing the server publicly. |
| Clips, video/screen recording and media conversion | Install FFmpeg and make it available on PATH. Audio capture/transcription requirements depend on the selected recording path. |
| Local AI and screen descriptions | Install Ollama, download the models you select, and configure the local endpoint. GPU acceleration depends on the model and your hardware. |
| Local meeting transcription | WhisperX is optional; the existing local workflow uses Docker Desktop and an appropriate WhisperX image/GPU setup. Alternatively configure a supported hosted transcription provider. |
| Voice wake word | Configure a Porcupine access key and the appropriate native runtime/model files. These optional licensed assets are not included in the installer. |
| Schedule/snapshot publishing or other SSH workflows | Install Windows OpenSSH client, configure your own host alias and destination paths, and verify your connection. No SSH host, private key or remote account is supplied. |
| Calendar, Asana, Gmail, AI, speech or home automation | Supply your own endpoints/accounts/tokens in Settings. Each service remains optional. Gmail package tracking reads mail; external service access follows the configured integration. |
| Proton Mail | Requires Proton Bridge and a build with the optional `proton` feature. The default Windows beta does not include that feature. |

For a source build, install Node.js/npm, the Rust MSVC toolchain and Visual Studio C++ Build Tools. Run `npm install`, then `npm run release` to prepare both frontends, build and stage the matching server, and produce the NSIS installer. `npm run prepare:bundle` prepares the server without building the installer. No publishing or signing happens automatically.

Debug `cargo check`/`cargo test` do not require a prebuilt sidecar. In development, the start control uses a sibling `serve.exe` or falls back to `src-tauri/target/release/serve.exe`. Release builds require the staged sidecar and never substitute a missing server silently.
