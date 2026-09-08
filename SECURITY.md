# Security and privacy

Report a vulnerability through the repository's private vulnerability reporting feature when enabled. Do not put credentials, private transcripts, calendar links or recordings into a public issue. If private reporting is unavailable, open an issue asking for a private contact channel without vulnerability details or sensitive data.

## Data boundaries

- History browsing reads local Claude, Codex and Antigravity files. Demo data is fictional.
- Settings and local application state live in the current user's profile. Provider credentials use Windows Credential Manager; older plaintext settings are migrated when the desktop app starts.
- AI, speech, calendar, mail, Home Assistant and notification integrations contact the services the user configures. Provider requests can include selected notes, transcripts, audio, images or prompts. Enable only the integrations you intend to use.
- Cloud snapshots can contain project metadata, calendar entries and complete recent notes. Publishing is off by default and requires an explicit SSH destination. Access control on the destination website is the operator's responsibility; cipherManager does not configure it.
- Scribe can process text from other applications when explicitly enabled. Recording and wake-word features require their own setup and permissions.
- Acting mode permits commands and agent processes to run with the user's account privileges. It is off by default. Switching it off prevents new guarded launches; it does not revoke commands already delivered to a running terminal or stop work already in flight.
- Remote access can expose both personal information and execution capabilities. Keep the default loopback binding or use a private authenticated network; do not port-forward the service onto the public internet.

## Known platform limitation

This beta supports Windows x64. Tauri's Linux GTK3 dependency still resolves to `glib` 0.18, which is affected by [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html). It is not in the Windows dependency graph, including when optional features are enabled. The fixed `glib` 0.20 series is incompatible with the current GTK3 bindings; keep this advisory tracked until Tauri's Linux dependency stack can be upgraded. Linux builds are unsupported.

## Before making an existing repository public

Deleting a secret in a new commit does not remove it from history, tags, release attachments, forks or other clones. Revoke a leaked credential first, then follow [GitHub's sensitive-data removal instructions](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).

Use the clean source export described in `docs/releasing.md` when old private history should not travel with the public project. Automated scans help find known patterns; they do not prove that every file is safe to share. Review the exported files and generated release assets before publication.
