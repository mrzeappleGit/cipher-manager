// Roadmap data for the Cipher suite. Edit here to update the Roadmap tab —
// it's plain structured data, no backend needed.

export type RoadmapStatus = "shipped" | "in-progress" | "planned";

export interface RoadmapItem {
  title: string;
  detail?: string;
  status: RoadmapStatus;
}

export interface RoadmapPhase {
  name: string;
  note?: string;
  items: RoadmapItem[];
}

export interface RoadmapProject {
  id: string;
  name: string;
  tagline: string;
  accent: "cyan" | "violet" | "magenta";
  phases: RoadmapPhase[];
}

const s = (title: string, detail?: string): RoadmapItem => ({ title, detail, status: "shipped" });
const plan = (title: string, detail?: string): RoadmapItem => ({ title, detail, status: "planned" });

export const ROADMAP: RoadmapProject[] = [
  {
    id: "cipherManager",
    name: "cipherManager",
    tagline: "Usage console + agentic OS for Claude Code",
    accent: "cyan",
    phases: [
      {
        name: "Windows beta preparation",
        note: "release candidate",
        items: [
          s("Portable setup", "Publishing and companion endpoints require your own configuration; no personal server fallback."),
          s("Bundled local server", "Explicit start, status and authenticated stop with active-work protection."),
          s("Persistence and execution safety", "Awaited hydration, atomic writes, retryable secret migration and backend Acting-mode checks."),
          s("Public source preparation", "MIT license, clean source export, secret scans and draft-only Windows release workflow."),
          plan("Release validation", "Complete clean Windows installation, upgrade, desktop UI and optional integration checks before publication."),
        ],
      },
      {
        name: "Foundation",
        note: "shipped",
        items: [
          s("CipherCore neon UI", "Imported design system — fonts, tokens, glows, shell."),
          s("Usage analytics", "Tokens, models, projects, and cost reference from ~/.claude."),
          s("Usage core", "Data-driven particle sphere: density by activity, hubs = projects."),
          s("Activity map", "Calendar heatmap of daily usage."),
          s("Transcript browser + search", "Browse sessions and full-text search history."),
          s("Disk cleanup", "Find and archive/delete heavy sessions."),
          s("Web server + snapshot", "Run in a browser locally or share a static snapshot."),
        ],
      },
      {
        name: "Phase 1 — Command & glance",
        note: "shipped",
        items: [
          s("Command palette (⌘K)", "Jump to any project/screen and run actions."),
          s("Live token tracker", "Rolling last-5h / 24h tokens and messages."),
          s("File link-out", "Reveal a transcript's .jsonl in the OS file manager."),
        ],
      },
      {
        name: "Phase 2 — Knowledge surfaced",
        note: "shipped",
        items: [
          s("Documents trail", "Plans, per-project memory, and AI summaries with a reader."),
          s("Directives", "Pick up where you left off + optional AI suggest-focus."),
          s("Insights feed", "Peak day, concentration, dormant projects, cache reuse."),
        ],
      },
      {
        name: "Phase 3 — Assistant touches",
        note: "shipped",
        items: [
          s("Ask your history (RAG)", "Retrieval over transcripts → cited answers."),
          s("Read-aloud", "Web Speech + ElevenLabs TTS across summaries, Ask, rundown."),
          s("Desktop notifications", "Alert when a background AI task finishes."),
          s("The rundown", "Spoken briefing from recent activity + insights."),
        ],
      },
      {
        name: "Phase 4 — Agentic OS",
        note: "shipped",
        items: [
          s("Skills registry", "Reads ~/.claude/skills; one-click cards grouped by domain."),
          s("Execution engine", "Headless claude -p runner with streamed output."),
          s("Acting-mode gate", "Off by default; confirm prompt + working dir before running."),
          s("Job cancel", "Stop a running job; process reaped and marked canceled."),
          s("Audit log", "Every run persisted to ~/.claude/cipher-jobs/audit.jsonl."),
          s("Roadmap tab", "This view — unified roadmap across the Cipher suite."),
          s("Quick-action launcher", "Resume in Claude Code from a project's page (terminal at its folder)."),
          s("Skill-creator flow", "Describe a skill; a headless run writes the SKILL.md for you."),
          s("Skill editor", "Edit SKILL.md in-app (incl. per-skill model); writes confined to ~/.claude/skills."),
          s("Morning briefs", "Deck snapshot feeds the brief; briefs listed on Documents with read-aloud."),
          s("Free-prompt runner", "Run any ad-hoc prompt with a working dir, not just a skill."),
          s("Automations scheduler", "Once-a-day scheduled prompts/skills while the app is open."),
          s("Memory / vault browser", "Read-only markdown vault on the Documents page; skill runs write reports."),
          s("Voice input", "Mic on Ask — ElevenLabs Scribe or OpenAI Whisper via your existing keys."),
          s("System tray + autostart", "Close hides to tray; reminders/automations keep running. Launch-at-login toggle."),
        ],
      },
      {
        name: "Phase 5 — Memory layer",
        note: "shipped",
        items: [
          s("Vault write command", "write_vault_file, confined to the vault dir (no escapes, .md only)."),
          s("Vault structure contract", "MainVault/CLAUDE.md: existing folders documented, output/<kind>/ for generated reports."),
          s("Skills file into the vault", "Morning brief writes to output/briefs/; Documents merges vault + legacy briefs."),
          s("Obsidian deep links", "Open any vault doc in Obsidian (obsidian://) from Documents."),
        ],
      },
      {
        name: "Phase 6 — The router (Jarvis)",
        note: "shipped",
        items: [
          s("Assistant input", "Global floating panel: text + mic; voice queries speak their answers."),
          s("Regex fast-path", "Rundown/brief/deck queries answered deterministically — no AI, no cost."),
          s("Model router", "One provider call classifies: run a skill (acting-gated, skill's model) or answer directly."),
          s("Read-before-generate", "Fresh brief → read it; missing → morning-brief job starts, finish toast closes the loop."),
        ],
      },
      {
        name: "Phase 7 — Cards & optimization",
        note: "shipped",
        items: [
          s("Result cards", "Finished jobs pop a dismissible card: output tail + Obsidian links to vault files the run wrote."),
          s("Skill analytics", "Per-skill runs, avg duration, and failures from audit.jsonl on each card."),
          s("Improve this skill", "SKILL.md + recent run outputs → provider; proposed rewrite lands in the editor for review."),
        ],
      },
      {
        name: "Phase 8 — Architecture builder",
        note: "shipped",
        items: [
          s("OS architect flow", "Brain-dump (talk or type) → proposed domain/skill checklist → one headless run writes every SKILL.md."),
          s("Automation suggestions", "Proposed daily tasks land in Automations disabled, with time and model, to opt in."),
        ],
      },
      {
        name: "Phase 9 — Automations grow up",
        note: "shipped",
        items: [
          s("Day-of-week scheduling", "Per-automation day picker (weekday-only briefs and the like)."),
          s("Closed-app automations", "Task Scheduler pipes the prompt into headless claude via a hidden launcher; app creates/toggles/deletes the tasks."),
        ],
      },
      {
        name: "Phase 10 — Go mobile",
        note: "the web server becomes the phone app",
        items: [
          s("Serve access token", "Non-loopback binds require a token (?token= grants a cookie); localhost stays open."),
          s("Remote access card", "Serve health + outbound (AV-block) check, Tailscale URL, phone-pairing QR, APK link."),
          s("Meeting notes on the phone", "Read-only vault over serve: summaries, tasks-for-me, and rescue rows from the couch."),
          s("PWA install", "Manifest, icons, and a service worker so add-to-home-screen makes it a fullscreen app."),
          s("Android app", "Installable WebView APK (mobile/android) that points at the PC's server — real app, own icon."),
          s("Responsive pass", "Mobile nav drawer; Assistant/Jobs fit a phone; Tailscale HTTPS reaches it anywhere."),
          s("Quick scripts", "Drop .bat/.ps1 into cipher-manager/scripts; one tap on the Deck runs them on the PC — your own named scripts."),
          s("Phone push (ntfy)", "Finished jobs/automations ping the phone — briefs and harvests land while you're away."),
          s("Home-screen widgets", "Next-up countdown that ticks offline, plus a paged brief with deep links and a gated skill button — pairs as a G2 client."),
          s("Package tracking", "Reads shipping mail in Gmail (read-only) and links out to each carrier's own page — Deck strip + Packages tab. No tracking API: USPS wants $599/mo, AfterShip $119/mo, and Amazon has none at any price, while the carriers already email you every status for free."),
        ],
      },
      {
        name: "Phase 12 — Meeting recorder",
        note: "replaces the Obsidian Whisper plugin",
        items: [
          s("Record mic + system audio", "WASAPI loopback captures Teams/Zoom natively — no virtual cables."),
          s("Transcribe → vault note", "Chunk-safe STT (Scribe/Whisper), AI summary + action items, git-synced to output/meetings/."),
          s("Auto-record meetings", "Opt-in: starts with the calendar event, silence-aware stop for overruns."),
          s("Speaker diarization", "Two-track: your mic is always “Me”; remote voices get Speaker N + who-is-who renaming."),
          s("Local WhisperX (GPU)", "Point at a local ASR container; docker auto-starts per transcription and stops after."),
          s("Import audio", "Native file picker (or the event modal) runs any recording through the same pipeline."),
          s("Meeting notes on the Deck", "Summaries inline with read-aloud, AI redo buttons, and your action items → to-dos."),
          s("Never lose a recording", "Record boots Docker Desktop itself and pre-warms the container; unprocessed recordings resurface on the Deck with one-click rescue."),
          s("Meeting screen capture", "Record a chosen window during meetings; Ollama describes slides/screenshares and the notes land inline in the transcript. Plus a Dashboard herdr launcher."),
          s("Video speaker ID", "Teams active-speaker tiles name the diarized voices: sampled every 30s, majority-voted, AI text guess as fallback."),
        ],
      },
      {
        name: "Phase 13 — Clip pipeline",
        note: "clipping-tool + twitch-downloader folded in",
        items: [
          s("CLIP IT", "Create a real Twitch clip of the live stream with a label + note; log with reel export."),
          s("!clip chat command", "IRC-over-WebSocket listener answers broadcaster/mods with the clip URL."),
          s("Latest VODs picker", "Fill the sizzle source from your recent VODs — stream → highlights in one page."),
          s("Visual highlight AI", "Make clips scans the whole VOD with local Qwen3-VL (Ollama) — scores, reasons, and boundaries; loudness stays as tie-breaker."),
          s("Clip editor", "Facecam vertical layout (drag the cam/game boxes), burned animated captions (WhisperX/Whisper, 3 presets), and a visual timeline trim with source preview."),
          s("Cloud AI scoring", "Highlights and meeting vision can run on Gemini/GPT/Claude APIs — model picker, keys from Settings, pennies per VOD on Gemini Flash."),
          s("Cloud snapshot", "Hourly + on-quit read-only cache at your configured SSH destination — age badge, ntfy failure alert"),
        ],
      },
      {
        name: "Phase 14 — Smarter brain",
        note: "recall spans everything you know",
        items: [
          s("Vault-aware recall", "Ask searches meeting notes, briefs, and your notes beside the transcripts — cited together."),
          s("Semantic recall", "Local embeddings (Ollama on the GPU) rank vault chunks by meaning; vectors cached on disk."),
          s("People pages", "output/people/<name>.md per person: action items + meetings, rebuilt after every note; 1:1 button on events."),
          s("Memory-harvest skill", "Nightly 21:30 automation distils sessions + meetings into durable, deduped notes."),
          s("Weekly review", "Friday 16:00 automation: the week's meetings, memory, and open items → review note."),
          s("Embed transcripts too", "Semantic recall over session excerpts, not just the vault — Ask merges both."),
          s("Outcome-aware recall", "Session index embeds assistant conclusions; Ask cites the exact message."),
          s("Contract doctor", "Deterministic vault routing check — drift findings + preview-then-apply patch."),
          s("Memory inbox", "Harvest proposes; you approve — provenance frontmatter, source links, diffs, dedupe."),
          s("Meeting prep briefs", "Event modal assembles open action items per person, last meeting's summary, related notes."),
          s("Actions → to-dos", "Your action items auto-flow into the Deck to-do list when a meeting note files (deduped)."),
        ],
      },
      {
        name: "Phase 16 — Multi-tool cockpit",
        note: "Claude, Codex, and Antigravity in one place",
        items: [
          s("Read Codex history", "~/.codex sessions merge into projects, session viewer, usage stats, and search."),
          s("Codex semantic recall", "Codex digests join the embeddings index — Ask and voice recall span both tools."),
          s("Codex job engine", "Run headless jobs with codex exec; engine picker on skill runs and the free-prompt runner."),
          s("Gemini job engine", "Run headless jobs with gemini --yolo; third option in the engine picker."),
          s("Antigravity history", "Google Antigravity conversations (history.jsonl) merge into projects, search, and semantic recall."),
          s("Agent sessions", "Interactive PTY terminals hosted by serve — resume any past conversation, new project/chat in-app, phone attach."),
        ],
      },
      {
        name: "Phase 17 — Desk tools",
        note: "the small things you'd otherwise alt-tab for",
        items: [
          s("Screenshots tab", "Region / window / full-screen capture, each copied to the clipboard and saved to a folder you pick; gallery with lightbox, re-copy, reveal, delete."),
          s("Capture hotkey", "Global Ctrl+Alt+S grabs a region even with the app in the tray."),
          s("Universal search", "⌘K also finds installed apps and local files (Windows Search index), and answers sums and unit conversions inline."),
          s("Universal search window", "Finder-style panel in its own window: scope bar, date filter, sortable Name/Kind/Where/Date/Size columns, keyboard nav. Spans sessions, vault notes, projects, docs, skills, local files, apps and screenshots."),
          s("Global search hotkey", "Ctrl+Alt+Space summons the search window from any application; results open in the main window or the OS."),
        ],
      },
      {
        name: "Phase 15 — Voice assistant",
        note: "say “Cipher” and it does things",
        items: [
          s("Wake word (Porcupine)", "Always-listening ear in Rust; custom “Cipher” keyword, pauses during meeting recordings."),
          s("Intent router", "Instant app actions (record, scripts, to-dos, agenda) → Home Assistant conversation → Claude job fallback."),
          s("Spoken replies", "TTS + toast for every answer; status pill shows listening/awake/thinking."),
          s("Speak job results", "Voice-started Claude jobs read their result aloud on completion (concise-answer prompt)."),
          s("Voice follow-ups", "After an HA reply the mic re-arms — “and the kitchen too” works; silent windows cancel quietly."),
          s("Ask my history by voice", "“Cipher, how did we fix X?” — semantic recall over vault + sessions, answered aloud."),
          s("Vault curator", "Sunday librarian pass flags stale/duplicate/contradictory notes; all automations now push to the phone."),
        ],
      },
      {
        name: "Phase 11 — Cloud sync",
        note: "Nextcloud carries the data",
        items: [
          s("Shared config store", "Settings/automations/todos mirrored to ~/.claude/cipher-manager; web clients inherit the desktop config."),
          s("Vault git sync", "Commit/pull/push the vault's GitHub backup — automatic after skill runs write reports, manual from Documents."),
        ],
      },
      {
        name: "Cipher suite — folded in",
        note: "one app for everything",
        items: [
          s("Deck (CipherDeck)", "Calendar + tasks dashboard ported in: ICS feeds, Asana, live up-next, agenda, week ahead."),
          s("Highlights (cipherSizzle)", "Auto-cut the loudest VOD moments; native Rust port, jobs-engine pipeline."),
          s("Highlights workspace (sizzle-parity)", "Clip grid with excitement sort + tier tags, Adjust start & end re-cut, and a compilation builder — the internal-tool half of sizzle.gg."),
          s("Even G2 glasses HUD (v1)", "even-g2/ Even Hub plugin + /api/g2 facade: paired read-only HUD (NOW/BRIEF/DECK/PROJECTS/STATUS), 6-digit pairing approved in Settings, sha256 scoped tokens. Hardware checks pending."),
          s("Schedule maker + creator card", "Stream schedule tool and Twitch/YouTube stats on the dashboard."),
          s("Meeting recorder (Whisper plugin)", "The Obsidian plugin's job, in-app with system audio — see Phase 12."),
          s("Clip pipeline (clipping-tool)", "Live clips + chat command + VOD picker — see Phase 13."),
          s("Home Assistant card", "Deck card: light/switch toggles, scene buttons, sensor glances — PC + phone; entities picked in Settings."),
          s("Scribe (CipherScribe)", "System-wide grammar + AI rewrite folded in from the standalone tray app: live docking nib via UI Automation, suggestions panel with Fix all, Ctrl+Alt+G / Ctrl+Alt+R, apply-in-place with clipboard restore."),
          plan("More folded in", "Next candidate: content-calendar — see ROADMAP.md."),
        ],
      },
    ],
  },
  {
    id: "cipherDeck",
    name: "CipherDeck",
    tagline: "Native calendar + tasks dashboard (Rust / egui)",
    accent: "violet",
    phases: [
      {
        name: "Dashboard",
        note: "shipped",
        items: [
          s("Native Rust app", "Single self-contained executable built with egui/eframe."),
          s("Live clock + up-next hero", "Countdown to the next event front and center."),
          s("Today's agenda", "The day's meetings at a glance."),
          s("Tasks grouped", "Overdue / Today / Upcoming buckets."),
          s("Stats + week ahead", "At-a-glance counts and the coming week."),
        ],
      },
      {
        name: "Integrations",
        note: "shipped",
        items: [
          s("Calendar feeds (ICS)", "Outlook/Google .ics with TZID handling."),
          s("Asana tasks", "My Tasks or a project, paginated, incl. overdue."),
          s("Recurring events", "RRULE expansion (BYDAY, COUNT, UNTIL, EXDATE)."),
          s("Sample-data fallback", "Runs out of the box; falls back if a feed is down."),
          s("Offline cache", "Last live data shown instantly on launch."),
        ],
      },
      {
        name: "Desktop polish",
        note: "shipped",
        items: [
          s("Meeting notifications", "Desktop toast + taskbar flash + in-app banner."),
          s("Actionable", "Join-call button and click-through to Asana."),
          s("System tray", "Show / Refresh / Quit; close hides to tray."),
          s("Launch-at-login + start-minimized", "Windows autostart options."),
          s("In-app Settings", "Edit everything without touching config.toml."),
        ],
      },
      {
        name: "Planned",
        note: "seeded — edit in src/lib/roadmap.ts",
        items: [
          plan("More task sources", "Todoist / Google Tasks alongside Asana."),
          plan("Cross-platform autostart", "Launch-at-login on macOS and Linux."),
          plan("Custom themes", "Beyond dark/light — accent presets and layouts."),
          plan("Focus / agenda widgets", "Compact always-on-top or tray-popover view."),
        ],
      },
    ],
  },
];

export const STATUS_META: Record<RoadmapStatus, { label: string; dot: string; text: string }> = {
  shipped: { label: "Shipped", dot: "#00f5ff", text: "text-cyan" },
  "in-progress": { label: "In progress", dot: "#c000ff", text: "text-violet" },
  planned: { label: "Planned", dot: "#555", text: "text-muted" },
};

export function countByStatus(projects: RoadmapProject[]): Record<RoadmapStatus, number> {
  const out: Record<RoadmapStatus, number> = { shipped: 0, "in-progress": 0, planned: 0 };
  for (const p of projects) {
    for (const ph of p.phases) {
      for (const it of ph.items) out[it.status]++;
    }
  }
  return out;
}
