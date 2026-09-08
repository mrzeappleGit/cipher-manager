// Client-side store for headless `claude -p` runs. Starts jobs via the backend
// and polls their status until they finish, so the Jobs panel updates live.

import { useSyncExternalStore } from "react";
import { api } from "../api";
import { notifyDesktop } from "./notify";
import { flushSettings, getSettings, settingsReady } from "./settings";
import { notify } from "./toast";
import type { AuditEntry, Job } from "../types";

/** A finished run distilled into a dismissible pop-up card (the Jarvis-style
 * result trail): what ran, a tail of its output, and any vault files it wrote. */
export interface ResultCard {
  id: string;
  label: string;
  skill: string;
  ok: boolean;
  finishedAt: string;
  excerpt: string;
  files: Array<{ name: string; path: string }>;
}

interface JobsState {
  jobs: Job[];
  history: AuditEntry[];
  cards: ResultCard[];
  open: boolean;
  selected: string | null;
}

let state: JobsState = { jobs: [], history: [], cards: [], open: false, selected: null };
let listeners: Array<() => void> = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;
let polling = false;

function set(patch: Partial<JobsState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function upsert(job: Job) {
  const rest = state.jobs.filter((j) => j.id !== job.id);
  set({ jobs: [job, ...rest] });
}

function ensurePolling() {
  if (pollTimer) return;
  pollTimer = setInterval(poll, 900);
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
  const running = state.jobs.filter((j) => j.status === "running");
  if (running.length === 0) {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    return;
  }
  for (const j of running) {
    try {
      const fresh = await api.getJob(j.id);
      upsert(fresh);
      if (fresh.status !== "running") {
        loadHistory();
        void addResultCard(fresh);
        // Phone push (ntfy) — so briefs/harvests land on the phone when the
        // user isn't at the PC. Configured via Settings → Remote access.
        {
          const ok = fresh.status === "done";
          import("./ntfy")
            .then((n) =>
              n.pushPhone(
                `${fresh.label} ${ok ? "finished" : "failed"}`,
                ok
                  ? (fresh.output ?? "").replace(/\s+/g, " ").trim().slice(-300) || "Done."
                  : "Check the Jobs panel output.",
                ok
              )
            )
            .catch(() => {});
        }
        if (getSettings().notifications) {
          const ok = fresh.status === "done";
          const view = () => viewJobResult(fresh);
          notify[ok ? "success" : "error"](
            `${fresh.label} ${ok ? "finished" : "failed"} — click to view`,
            view
          );
          // Tray case: the desktop notification informs (no click callback on
          // desktop — see notify.ts); the clickable toast covers the app itself.
          notifyDesktop(
            `${fresh.label} ${ok ? "finished" : "failed"}`,
            ok ? "The result is ready in Cipher Manager." : "Check the Jobs panel output.",
            view
          );
        }
      }
    } catch {
      /* transient; try again next tick */
    }
  }
  } finally {
    polling = false;
  }
}

/** Whether a job for this skill is currently running (dedup guard for
 * assistant-initiated runs). */
export function hasRunningJob(skill: string): boolean {
  return state.jobs.some((j) => j.skill === skill && j.status === "running");
}

/** Distill a finished job into a result card, including vault files the run
 * wrote (anything modified after the job started). */
async function addResultCard(j: Job): Promise<void> {
  const out = j.output.trim();
  const excerpt = out.length > 280 ? `…${out.slice(-280)}` : out;
  let files: ResultCard["files"] = [];
  const vaultDir = getSettings().vaultDir.trim();
  if (vaultDir && j.startedAt) {
    try {
      const started = new Date(j.startedAt).getTime();
      files = (await api.listVault(vaultDir))
        .filter((d) => d.modified && new Date(d.modified).getTime() >= started)
        .slice(0, 5)
        .map((d) => ({ name: d.name, path: d.path }));
    } catch {
      /* vault unreadable — card still useful without file links */
    }
  }
  const card: ResultCard = {
    id: j.id,
    label: j.label,
    skill: j.skill,
    ok: j.status === "done",
    finishedAt: j.finishedAt ?? new Date().toISOString(),
    excerpt,
    files,
  };
  set({ cards: [card, ...state.cards.filter((c) => c.id !== card.id)].slice(0, 6) });

  // The run wrote to the vault → push the GitHub backup. No-ops for non-repo
  // vaults; only failures surface.
  if (files.length > 0) {
    api
      .syncVaultGit(vaultDir)
      .catch((e) => notify.error(`Vault sync failed: ${e instanceof Error ? e.message : String(e)}`));
  }
}

/** CLIs that can run a headless job. */
export type Engine = "claude" | "codex" | "gemini";

export function dismissCard(id: string): void {
  set({ cards: state.cards.filter((c) => c.id !== id) });
}

export function clearCards(): void {
  set({ cards: [] });
}

/** Where "view result" goes: brief-ish runs open Documents on the newest brief
 * (ponytail: name heuristic; a per-skill "result target" if more skills need it),
 * everything else opens the Jobs panel on that job's output. */
function viewJobResult(j: Job): void {
  if (/brief/i.test(`${j.skill} ${j.label}`)) {
    window.location.hash = "#/documents?open=brief";
  } else {
    openJobs(j.id);
  }
}

/** Kick off a headless run and reveal the Jobs panel. */
export async function startJob(params: {
  skill: string;
  label: string;
  prompt: string;
  /** Working directory override; defaults to the settings workDir. */
  cwd?: string;
  /** Model override, passed to the CLI as `--model <x>` (default: CLI default). */
  model?: string;
  /** Open the Jobs panel on start (default true; automations pass false). */
  reveal?: boolean;
  /** Which CLI runs it (default "claude"). */
  engine?: Engine;
  /** Recheck queued work after settings writes, immediately before dispatch. */
  canLaunch?: () => boolean;
}): Promise<string | null> {
  try {
  await settingsReady;
  if (!getSettings().actingMode) throw new Error("Enable Acting mode before running jobs.");
  await flushSettings();
  const s = getSettings();
  if (!s.actingMode) throw new Error("Acting mode was turned off before launch.");
  if (params.canLaunch && !params.canLaunch()) return null;
  const cwd = params.cwd?.trim() || s.workDir;
  const model = params.model?.trim();
  const engine = params.engine ?? "claude";
  // Codex/Gemini take -m for the model; Claude takes --model (and its own args).
  const [bin, args] =
    engine === "codex"
      ? [s.codexBin, [s.codexArgs, model && `-m ${model}`]]
      : engine === "gemini"
        ? [s.geminiBin, [s.geminiArgs, model && `-m ${model}`]]
        : [s.claudeBin, [s.claudeArgs, model && `--model ${model}`]];
    const id = await api.runSkill({
      skill: params.skill,
      label: params.label,
      prompt: params.prompt,
      bin,
      args: args.filter(Boolean).join(" "),
      cwd,
    });
    const now = new Date().toISOString();
    upsert({
      id,
      skill: params.skill,
      label: params.label,
      status: "running",
      output: "",
      exitCode: null,
      cwd: cwd || null,
      startedAt: now,
      finishedAt: null,
    });
    if (params.reveal !== false) set({ open: true, selected: id });
    ensurePolling();
    return id;
  } catch (e) {
    notify.error(`Couldn't start: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Ask the backend to stop a running job; the poll picks up the new status. */
export async function cancelJob(id: string): Promise<void> {
  try {
    await api.stopJob(id);
  } catch (e) {
    notify.error(`Couldn't stop: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Load the persisted audit log (history that survives restarts). */
export async function loadHistory(): Promise<void> {
  try {
    const h = await api.getAudit(100);
    set({ history: h });
  } catch {
    /* ignore */
  }
}

export function openJobs(id?: string) {
  set({ open: true, selected: id ?? state.selected ?? state.jobs[0]?.id ?? null });
  loadHistory();
}
export function closeJobs() {
  set({ open: false });
}
export function selectJob(id: string) {
  set({ selected: id });
}

function subscribe(l: () => void): () => void {
  listeners.push(l);
  return () => {
    listeners = listeners.filter((x) => x !== l);
  };
}
const getSnapshot = () => state;

export function useJobs(): JobsState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
