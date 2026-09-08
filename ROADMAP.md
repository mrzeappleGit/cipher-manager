# Roadmap — cipherManager (2026-09-08)

Reviewed the current working tree, including work in progress. This updates the July 9 survey; “implemented” means present in code, not independently verified in the installed app. The release preparation below was implemented after the initial review.

The biggest opportunity is making the existing tools work reliably together: capture a meeting, track its actions, recall the evidence, and resume the work. There is already enough feature breadth to support that workflow.

## Implemented for the Windows beta

Portable publishing defaults, bundled server controls, atomic ordered state saves, startup hydration, retryable credential migration, job redaction, Acting-mode launch gates, checked scheduled tasks, confined vault writes and truthful automation launch bookkeeping are implemented with regression coverage. MIT licensing, a clean source exporter, redacted secret scans and Windows draft-release CI are prepared. See docs/testing-windows.md for validation scope; publication and integration/device checks remain separate.

## Next

- **Make connection and source failures visible and recoverable** — retry failed backend detection, separate explicit demo mode from service failure, replace the unconditional “connected” footer, and show failed search sources alongside successful results with retry. · effort: M · V/E/C: 5/2/5 · `src/api.ts:99`, `src/components/Layout.tsx:247`, `src/lib/universal.ts:501`
- **Open search results at the matching message** — preserve messageUuid in transcript-search and Finder links using the existing ?msg= behavior in Ask and SessionView. · effort: S · V/E/C: 4/1/5 · `src/pages/Search.tsx:80`, `src/lib/universal.ts:353`, `src/pages/Ask.tsx:209`
- **Stabilize keyboard navigation** — separate palette reset-on-open from asynchronous list loading, reuse one navigation list so all screens remain discoverable, and use a native button for opening document rows. · effort: S · V/E/C: 4/1/5 · `src/components/CommandPalette.tsx:45`, `src/components/CommandPalette.tsx:86`, `src/pages/Documents.tsx:549`
- **Keep recalled notes inside the app** — add a per-note Documents deep link and reuse it for Finder and Ask source cards; retain “Open in Obsidian” as an optional action, making the existing reader useful from the phone too. · effort: M · V/E/C: 4/2/4 · `src/pages/Documents.tsx:84`, `src/lib/universal.ts:373`, `src/pages/Ask.tsx:174`
- **Close the meeting → task → prep loop** — attach source-note/action identity to imported tasks, preserve completion across re-summarization, and use completion state in prep briefs; current text-only to-dos lose provenance, while people pages aggregate historical actions without consulting completion. · effort: M · V/E/C: 5/3/4 · `src/lib/deckStore.ts:7`, `src/lib/deckStore.ts:117`, `src/lib/meetingRec.ts:516`, `src/lib/people.ts:67`, `src/lib/prep.ts:32`
- **Recover jobs and make terminal delivery failures explicit** — hydrate Jobs from the existing listJobs API, prevent overlapping polls, report rejected terminal writes and retain failed mobile input for manual retry; do not automatically replay commands whose delivery is uncertain. · effort: M · V/E/C: 5/3/5 · `src/lib/jobs.ts:31`, `src/lib/jobs.ts:47`, `src/pages/Agents.tsx:74`

## Later / speculative

- **Backlinks in the document reader** — expose notes that link to the current note, starting with existing generated wiki-links and a small local index; useful once in-app note navigation is complete. · effort: M · V/E/C: 3/3/3 · `src/lib/people.ts:108`, `src/pages/Documents.tsx:24`
- **Reduce initial loading work if phone measurements justify it** — the main production JS chunk is 938.92 kB minified / 273.13 kB gzip; measure real-phone startup, then defer heavy dashboard/chart dependencies as needed. Chunk size alone does not establish slow interaction. · effort: S–M · V/E/C: 3/2/3 · `src/App.tsx:27`, `src/pages/Dashboard.tsx:26`
- **Make package corrections explicit** — “Put back in transit” clears the manual override, which cannot override an email-derived delivered status; support an explicit in-transit override or limit that action to manually delivered items. · effort: S · V/E/C: 3/1/5 · `src/pages/Packages.tsx:270`, `src/lib/packageStore.ts:18`
- **Content-calendar integration or another task provider** — retained from the previous survey; implement when a concrete recurring workflow cannot be handled by current Schedule/Deck features. · effort: M–L · V/E/C: 2/4/2 · `src/pages/Schedule.tsx:1`, `src/pages/Deck.tsx:95`

V/E/C = value, effort, confidence, each 1–5; higher effort means more work. Security and execution-control correctness take priority over pure value-to-effort. S is localized; M crosses a few existing layers; L includes substantial integration/platform work. These are relative sizes, not time commitments.

## Evidence behind the priorities

- **Migration failure:** migrated starts at zero and only increases, so migrated >= 0 always writes the completion marker even after caught failures; subsequent launches return immediately. Separately, spreading the old settings object retains anthropicApiKey after copying it into apiKeys; clearing the new field does not remove the old one.
- **Live output:** append_output stores raw text, read_job/read_jobs clone it, and finish_job scrubs it only at completion. If a child process prints a stored secret, running-job polls can receive it before scrubbing. The redactor also omits additional Gmail mailbox IDs supported by the presence map. No actual secret exposure was tested or observed.
- **Execution control:** generated Windows task scripts invoke the CLI without consulting Acting mode. The Skills page explicitly says automations will not run while the switch is off. UI guards in some callers do not enforce that promise at the shared execution boundary.
- **Persistence:** boot loads are asynchronous; onPersist ignores edits until ready, then sends independent saves. Rust writes destination JSON directly. This establishes lost-edit and interrupted-write risks, not evidence that user data has already been lost. Atomic replacement addresses interrupted writes, not cross-client last-writer-wins conflicts.
- **Automation launch:** the ticker and “Run now” call markRan before startJob, whose failure result is null. A launch failure can consume the day's scheduled run. Independent desktop/web runners have no shared claim to prevent simultaneous launches.
- **Vault containment:** the writer rejects .. and absolute paths, but writes the joined path without resolving linked parents or an existing linked file. The issue requires such a link to exist; this review did not inspect the user's vault for links or attempt an out-of-vault write.
- **Search and status:** the initial health result is cached for the page lifetime, including failure; reads then select mock data. A “sample data” badge exists, but the footer always says “connected.” Finder drops rejected sources, and transcript results omit message anchors already supported by the reader.
- **Task completion:** dedupe only checks identical open to-dos, so re-importing a completed action can create another open item. People/prep generation has no shared action-completion identity. This is a concrete reason to connect the existing workflows rather than add another task source.

## Implemented inventory (unranked)

- Usage analytics, activity and project drill-down — `src/pages/Dashboard.tsx:26`, `src/pages/Projects.tsx:1`.
- Claude, Codex and Antigravity history ingestion — `src-tauri/src/claude.rs:1`, `src-tauri/src/codex.rs:1`, `src-tauri/src/antigravity.rs:1`.
- Calendar, Asana tasks, personal to-dos, meeting prep and quick scripts — `src/pages/Deck.tsx:95`.
- Vault/document reader, contract doctor and reviewable memory inbox — `src/pages/Documents.tsx:24`, `src/pages/Documents.tsx:378`.
- Keyword and semantic recall with answer sources — `src/pages/Ask.tsx:40`, `src-tauri/src/brain.rs:1`.
- Transcript search, command palette and cross-source Finder — `src/pages/Search.tsx:11`, `src/components/CommandPalette.tsx:66`, `src/lib/universal.ts:334`.
- Headless jobs, automations, audit history and Windows scheduled tasks — `src/lib/jobs.ts:1`, `src/pages/Skills.tsx:100`, `src-tauri/src/commands.rs:1800`.
- Interactive agent terminals hosted by serve — `src/pages/Agents.tsx:248`, `src-tauri/src/agents.rs:240`.
- Meeting capture, transcription, notes, people pages and action import — `src/lib/meetingRec.ts:1`, `src/lib/people.ts:1`.
- Voice commands, spoken responses and follow-ups — `src/lib/voice.ts:1`, `src-tauri/src/voice.rs:1`.
- Live clips, VOD highlights, captions and compilations — `src/pages/Highlights.tsx:207`, `src-tauri/src/sizzle.rs:1`.
- Package tracking from mail with manual correction — `src/pages/Packages.tsx:131`; Proton support is feature-gated and disabled in the default Rust build (`src-tauri/Cargo.toml`).
- Screenshots, global shortcuts and Scribe — `src/pages/Screenshots.tsx:1`, `src/App.tsx:104`, `src-tauri/src/scribe/mod.rs:1`.
- Shared settings, OS credentials, remote access, cloud snapshot and G2 pairing — `src/lib/appState.ts:1`, `src-tauri/src/secrets.rs:1`, `src/pages/Settings.tsx:1476`, `src-tauri/src/snapshot.rs:1`, `src-tauri/src/g2.rs:1`.

The previous “Now” items are implemented: phone vault routes in serve and the remote-access Settings card. Voice result speech, follow-ups and phone job notifications are present too. They should no longer appear as new feature proposals. The in-app roadmap now records the implemented beta preparation; unimplemented product improvements remain below.

## Comparable-tool check

- [Raycast Search Bar](https://manual.raycast.com/search-bar) makes apps, commands, files, events and quicklinks reachable through one search. cipherManager has the foundations; the relevant improvement is reliable, complete navigation and correct result destinations.
- [Obsidian Backlinks](https://obsidian.md/help/Plugins/Backlinks) exposes references into the active note with surrounding context. cipherManager generates wiki-links in people pages; an in-app reader and modest backlinks view would make those relationships navigable.

These comparisons inform workflow proposals, not a requirement to match either product feature for feature.

## Initial review validation (before release changes)

- `npm.cmd test -- --reporter=dot`: **48 tests passed across 7 files**; output also included AbortError and refused localhost:3000 requests. The suite succeeds but needs better isolation from backend detection during imports.
- `npm.cmd run build`: **passed**, including TypeScript checking; Vite reported a large main chunk and mixed static/dynamic imports.
- `cargo check --manifest-path src-tauri/Cargo.toml --bins`: **passed** for the default feature set; one unused imap_date warning. The optional Proton feature was not checked.
- This was a source/build review, not a live desktop, phone, audio, credential-store or hardware test. Rust unit tests were not run. Existing uncommitted application work was preserved.
- README claims about a read-only web server and data remaining local no longer describe all supported behavior; AGENTS.md says there is no JS test framework although Vitest is installed. Refresh documentation around actual optional integrations and commands.

## Explicitly out of scope

- A broad backend rewrite or splitting commands.rs solely because it is large — the shared-command layout is deliberate; fix common boundaries where callers already converge.
- New state-management, test or search frameworks — installed tools and existing helpers cover these improvements.
- External vector database or custom embedding model — no demonstrated need beyond the local index.
- Multi-user/cloud-hosted brain, continuous screen-history capture or a new graph editor — substantial expansion without a demonstrated workflow gap.
- More integrations before execution, persistence and recall are dependable — preserve existing content-calendar/task-provider ideas without committing to them yet.
- Destructive unattended skills — retain the prior roadmap's restriction; execution-control work must not expand authorization.
- Discord self-bots, marketplace submission for the personal Stream Deck plugin and an iOS-native app — remain outside the previously agreed scope.
