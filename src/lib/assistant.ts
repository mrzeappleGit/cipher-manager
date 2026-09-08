// The Jarvis router. Three tiers, cheapest first:
//   1. Regex fast-path — brief/deck questions answered deterministically from
//      data already on disk or one deck fetch. No AI, no cost.
//   2. Read-before-generate — no fresh brief? Kick the morning-brief skill
//      (acting-gated); the job-finish toast closes the loop.
//   3. Model router — everything else goes to the configured AI provider once:
//      it either names a skill to run or answers directly.

import { api } from "../api";
import { isProviderReady, runPrompt } from "./ai";
import * as deck from "./deck";
import { hasRunningJob, startJob } from "./jobs";
import { getSettings } from "./settings";
import type { DocFile, Skill } from "../types";
import { keyRef, keyConfigured } from "./secrets";

export interface AssistantReply {
  text: string;
  /** Optional place to jump to for the full result. */
  link?: { label: string; hash: string };
  /** True when a headless job was started rather than answered inline. */
  startedJob?: boolean;
  /** Web-search citations (Web mode). */
  sources?: Array<{ title: string; url: string }>;
}

const BRIEF_RE = /\b(rundown|briefs?|briefing)\b/i;
const DECK_RE = /\b(deck|meetings?|calendar|schedule|agenda|day ahead|due|overdue)\b/i;

export async function askAssistant(query: string): Promise<AssistantReply> {
  const q = query.trim();
  if (!q) return { text: "Say or type something first." };
  if (BRIEF_RE.test(q)) return briefReply();
  if (DECK_RE.test(q)) return deckReply();
  return routeWithModel(q);
}

/** Strip markdown decoration so a report reads well aloud. */
function despan(md: string): string {
  return md
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*[-*]\s*/gm, "")
    .replace(/\*\*|\*|`/g, "")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Today's brief from the vault; generate it if it's missing (acting-gated). */
async function briefReply(): Promise<AssistantReply> {
  const s = getSettings();
  const link = { label: "Open brief", hash: "#/documents?open=brief" };
  // Config/read problems must be said out loud, never silently turned into a
  // generation run — that's how one question once fanned out into five jobs.
  if (!s.vaultDir.trim()) {
    return {
      text: "The vault folder isn't set in Settings, so I can't look for briefs. Point it at your Obsidian vault (Settings → vault folder) and ask again.",
    };
  }
  let files: DocFile[];
  try {
    files = await api.listVault(s.vaultDir);
  } catch (e) {
    return { text: `I couldn't read the vault: ${e instanceof Error ? e.message : String(e)}` };
  }
  const brief = files.find((d: DocFile) =>
    d.name.toLowerCase().replace(/\\/g, "/").includes(`output/briefs/brief-${today()}`)
  );
  if (brief) {
    const text = await api.readVaultFile(s.vaultDir, brief.path);
    return { text: despan(text), link };
  }
  if (hasRunningJob("morning-brief")) {
    return { text: "Today's brief is already being generated — hang tight, you'll get a notification when it's ready." };
  }
  if (!s.actingMode) {
    return {
      text: "There's no brief for today yet, and Acting mode is off so I can't generate one. Turn it on in Settings and ask again.",
    };
  }
  await startJob({
    skill: "morning-brief",
    label: "morning-brief",
    prompt: 'Use the "morning-brief" skill.\n\n',
    reveal: false,
  });
  return {
    text: "There's no brief for today yet — I'm generating one now. You'll get a notification when it's ready; click it to read or play the brief.",
    startedJob: true,
  };
}

/** Deterministic spoken digest of today's deck — one fetch, no AI. */
async function deckReply(): Promise<AssistantReply> {
  const s = getSettings();
  if (s.icsUrls.length === 0 && !keyConfigured("asana-token", s.asanaToken)) {
    return { text: "The Deck isn't configured — add calendar feeds or an Asana token in Settings." };
  }
  const d = await api.getDeck({
    icsUrls: s.icsUrls,
    asanaToken: keyRef("asana-token", s.asanaToken),
    asanaProject: s.asanaProject,
    asanaWorkspace: s.asanaWorkspace,
  });
  const now = new Date();
  const hidden = new Set(s.hiddenTags.map((t) => t.toLowerCase()));
  const meetings = deck.todaysEvents(deck.parseEvents(d), now).filter((e) => e.kind !== "Block");
  const tasks = deck.parseTasks(d).filter((t) => !t.tags.some((tag) => hidden.has(tag.toLowerCase())));
  const by = (b: deck.Bucket) => tasks.filter((t) => deck.taskBucket(t.due, now) === b);

  const parts: string[] = [];
  const upcomingMeetings = meetings.filter((e) => e.end > now);
  parts.push(
    meetings.length === 0
      ? "No meetings today."
      : `${meetings.length} meeting${meetings.length === 1 ? "" : "s"} today: ` +
          meetings.map((e) => `${e.title} at ${deck.fmtTime(e.start)}`).join(", ") +
          "." +
          (upcomingMeetings.length && upcomingMeetings.length < meetings.length
            ? ` ${upcomingMeetings.length} still ahead.`
            : "")
  );
  const overdue = by("Overdue");
  const dueToday = by("Today");
  parts.push(
    dueToday.length
      ? `Due today: ${dueToday.map((t) => t.name).join(", ")}.`
      : "Nothing due today."
  );
  if (overdue.length) {
    parts.push(
      `${overdue.length} overdue, oldest first: ${overdue
        .slice(0, 4)
        .map((t) => `${t.name} (${deck.dueLabel(t.due, now)})`)
        .join(", ")}${overdue.length > 4 ? `, and ${overdue.length - 4} more` : ""}.`
    );
  }
  return { text: parts.join(" "), link: { label: "Open Deck", hash: "#/deck" } };
}

/** One provider call: either picks a skill to run or answers directly. */
async function routeWithModel(q: string): Promise<AssistantReply> {
  const s = getSettings();
  if (!isProviderReady(s)) {
    return { text: "Set up an AI provider in Settings to ask me general questions." };
  }
  let skills: Skill[] = [];
  try {
    skills = await api.getSkills();
  } catch {
    /* no skills — plain answer still works */
  }
  const list = skills.map((sk) => `- ${sk.id}: ${sk.description || sk.name}`).join("\n");
  const out = await runPrompt(`You are the router for a personal agentic OS. Reply with ONLY a JSON object, no code fences.

Available skills:
${list || "- (none)"}

If the user's request asks to perform one of those skills, reply:
{"action":"run_skill","skill":"<skill id>","prompt":"<one-line instruction for the run>"}

Otherwise answer it yourself, briefly and in plain spoken language (no markdown):
{"action":"answer","text":"<your answer>"}

User request: """${q}"""`);

  let parsed: { action?: string; skill?: string; prompt?: string; text?: string } = {};
  try {
    parsed = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
  } catch {
    return { text: out.trim() }; // model ignored the format; its text is still the answer
  }

  if (parsed.action === "run_skill" && parsed.skill) {
    const sk = skills.find((x) => x.id === parsed.skill);
    if (!sk) return { text: parsed.text || out.trim() };
    if (!s.actingMode) {
      return { text: `That maps to the "${sk.name}" skill, but Acting mode is off — turn it on in Settings and ask again.` };
    }
    await startJob({
      skill: sk.id,
      label: sk.name,
      prompt: `Use the "${sk.name}" skill.\n\n${parsed.prompt || q}`,
      model: sk.model ?? undefined,
      reveal: false,
    });
    return {
      text: `Running ${sk.name} now — you'll get a notification when it finishes.`,
      startedJob: true,
    };
  }
  return { text: parsed.text || "I didn't get a usable answer — try rephrasing." };
}
