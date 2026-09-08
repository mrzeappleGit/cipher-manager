# cipherManager 0.2.0-beta.1

Windows x64 beta for local agent history, notes and interactive sessions.

- Bundled local server with explicit start/stop/status controls; agent sessions survive closing the desktop UI.
- Configurable SSH publishing destinations; no personal cloud or Scribe endpoint on fresh installs.
- Safer credential migration, ordered atomic settings saves, live job redaction, guarded execution and vault writes.
- System automations use a checked application entry point. Unsafe legacy task launchers are disabled on upgrade; recreate those automations in Skills.
- Fictional demo projects and neutral schedule artwork; MIT license and public-source export tooling.
- Dependency security updates, including React Router 7.18.3; hash-route deep links and back navigation covered by regression checks.

## Installation and limitations

Use the Windows setup executable and compare its SHA-256 with SHA256SUMS.txt. This beta is unsigned unless the release explicitly states otherwise. The companion server must be stopped after active work finishes before upgrade/uninstall.

The installer does not include agent CLIs, media binaries, models or provider accounts. See dependencies.md in the source docs. Proton mail support is disabled in the default build. Android, G2 and Stream Deck companions are experimental source-only integrations for this release.

Settings are shared using last-writer-wins semantics across clients. Atomic file replacement prevents partial writes; it is not collaborative merging. Turning Acting mode off prevents new guarded launches but does not stop existing processes or undo terminal input already sent.

Before publishing this draft, complete the clean Windows installation/upgrade/uninstall checklist in docs/testing-windows.md and review the source export for private material. Do not attach private snapshots, recordings, credential files or audit reports.
