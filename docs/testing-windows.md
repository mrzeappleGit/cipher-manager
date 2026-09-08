# Windows release verification

## Recorded beta validation — 2026-09-08

Artifact: `cipherManager_0.2.0-beta.1_x64-setup.exe`, SHA-256 `7e1c5e9b754e9e3f309b2ebf4406b75033a773cb08205ff763cde98e344d3aeb`.

- `npm run check`: passed (82 frontend tests, 2 source-export tests, 132 Rust library tests and 1 server test; 22 live/helper Rust tests ignored). Frontend and snapshot production builds passed. npm audit reported zero known vulnerabilities.
- Isolated packaged-server smoke: passed on the build host and against the installed copy in Windows Sandbox.
- Windows Sandbox build 26100: installed previous 0.1.0, upgraded to this beta, repeated installation, verified both installed executables, checked that the desktop process stayed running for 12 seconds, and uninstalled successfully. Sample user settings survived both upgrade and uninstall; both executables were removed.
- Even G2 source checks: 6 tests and TypeScript passed. Device behavior was not tested.

This is an automated installation/runtime check. Desktop rendering, tray interactions, live provider credentials, scheduling with Windows Task Scheduler and audio/video/hardware still require the manual checks below. A running desktop process alone does not prove that every UI feature works. The existing personal installation was not replaced.

## Automated isolated server smoke

Run against the newly built or installed `serve.exe`, using Windows PowerShell 5.1 or newer:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-windows.ps1 -ServePath 'C:\path\to\serve.exe' -ExpectedVersion '0.2.0-beta.1'
```

Use the version of the artifact being checked. `-ExpectedVersion` is optional; without it the smoke checks that health reports a version, but does not compare it with a release tag. The script needs no Node.js, Rust toolchain, agent CLI, provider account or existing local server.

The script creates empty temporary roots for `CIPHER_STATE_DIR`, `CIPHER_CLAUDE_DIR`, `CIPHER_CODEX_DIR` and `CIPHER_ANTIGRAVITY_DIR`, and passes a separate profile and AppData environment to the hidden child process. It creates the Claude root before launch because a nonexistent Claude override falls back to the real home directory. It chooses an available loopback port and verifies the health instance belongs to the process it launched before performing checks.

Checks cover server identity/version/protocol, empty project history, denial of GET execution, Host and Origin validation, Acting mode off on a fresh profile, authenticated native-only shutdown, stale-instance rejection, and clean process exit. No execution permission is enabled. Requests avoid credential-store APIs and job-list redaction, which can consult the real Windows credential vault despite profile environment overrides. Tokens stay in memory or the isolated state directory and are never printed. Temporary files and the owned child process are cleaned up on success or failure.

A passing smoke verifies this server binary and its HTTP boundaries. It does **not** verify installer behavior, desktop WebView behavior, Windows Credential Manager, audio/video devices, scheduled tasks, signing reputation or phone connectivity.

## Clean Windows VM or Windows Sandbox

Use a disposable Windows account/VM without your normal profile, SSH configuration, cloud credentials or agent history. Record the Windows version, artifact filename/hash and test results. Do not map a real user profile into Windows Sandbox.

1. Install the NSIS or MSI artifact. Confirm installation succeeds and the app opens. Confirm `serve.exe` is present beside the desktop executable, then run the automated smoke against that installed copy.
2. Verify the initial UI: no projects or credentials, Acting mode off, publishing/Scribe destinations empty, and missing optional tools explained. Open Settings, search, documents and the agent page; test keyboard navigation and ordinary window/tray behavior.
3. Start and stop the bundled server from Settings. Verify the displayed version, rejected attempts to stop while a test agent/job/recording is active, then successful stop after that work finishes. Closing the desktop window must leave an interactive agent session available in the local web client.
4. Use disposable credentials to verify credential-store migration, failed-write retry, restart persistence and redacted live/audit output. Test an inaccessible/corrupted settings file: Acting mode must remain off until deliberately re-enabled. Never copy production secrets into test fixtures.
5. Create a harmless scheduled automation, turn Acting mode off and confirm its next trigger refuses to launch. Upgrade a test installation containing a legacy scheduled launcher; verify it is disabled and can be recreated through Skills.
6. Upgrade over the previous test release with sample settings/history. Confirm the new UI and bundled server versions, preserved data, and a clear refusal to replace/stop an older active server until work finishes.
7. Stop active work and the local server, then uninstall. Verify installer-owned binaries/shortcuts are removed. Inspect retained user data and document the retention behavior; uninstall must not silently delete unrelated CLI history or vault files. Reinstall and repeat first launch.

Android, Even G2, optional Proton support and external publishing require separate device/integration testing. SSH upload tests must use a disposable destination with explicit credentials and protected URLs; the automated smoke never publishes anything.
