import {
  Blocks,
  CalendarClock,
  FileText,
  FolderOpen,
  ListTree,
  Pencil,
  Play,
  Plus,
  Save,
  ShieldAlert,
  Sparkles,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Page } from "../components/Layout";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  IconButton,
  Loading,
  Modal,
  SectionTitle,
  Spinner,
  cn,
} from "../components/ui";
import { api } from "../api";
import { notify, withToast } from "../lib/toast";
import { startJob, type Engine } from "../lib/jobs";
import { useAsync } from "../lib/useAsync";
import { getSettings, useSettings } from "../lib/settings";
import { improveSkill, isProviderReady } from "../lib/ai";
import { generationPrompt, proposeArchitecture, type ProposedSkill } from "../lib/architect";
import { MicButton } from "../components/MicButton";
import { formatRelative } from "../lib/format";
import {
  addAutomation,
  runAutomation,
  removeAutomation,
  toggleAutomation,
  useAutomations,
} from "../lib/automations";
import type { Skill } from "../types";

interface Reader {
  name: string;
  skillId: string;
  path: string;
  content: string;
  loading: boolean;
  /** When non-null, the modal is in edit mode with this draft text. */
  draft: string | null;
  saving: boolean;
  improving: boolean;
}

/** Per-skill run stats derived from the audit log. */
export interface SkillStats {
  runs: number;
  failed: number;
  avgMs: number | null;
}

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
}

const UNGROUPED = "Skills";

const FRONTMATTER = /^(---\r?\n)([\s\S]*?)(\r?\n---)/;

/** Read the `model:` value from a SKILL.md's frontmatter ("" when unset). */
function getFrontModel(text: string): string {
  const fm = FRONTMATTER.exec(text);
  const line = fm?.[2].split(/\r?\n/).find((l) => /^model\s*:/i.test(l));
  if (!line) return "";
  return line.slice(line.indexOf(":") + 1).trim().replace(/^["']|["']$/g, "");
}

/** Set/replace/remove the `model:` line in a SKILL.md's frontmatter. */
function setFrontModel(text: string, model: string): string {
  const v = model.trim();
  const fm = FRONTMATTER.exec(text);
  if (!fm) return v ? `---\nmodel: ${v}\n---\n\n${text}` : text;
  const lines = fm[2].split(/\r?\n/).filter((l) => !/^model\s*:/i.test(l));
  if (v) lines.push(`model: ${v}`);
  return fm[1] + lines.join("\n") + fm[3] + text.slice(fm[0].length);
}

function defaultPrompt(skill: Skill): string {
  return `Use the "${skill.name}" skill.\n\n`;
}

export default function SkillsPage() {
  const { data, error, loading, reload } = useAsync(() => api.getSkills(), []);
  const audit = useAsync(() => api.getAudit(500), []);
  const settings = useSettings();

  const stats = useMemo(() => {
    const m = new Map<string, { runs: number; failed: number; totalMs: number; timed: number }>();
    for (const e of audit.data ?? []) {
      const cur = m.get(e.skill) ?? { runs: 0, failed: 0, totalMs: 0, timed: 0 };
      cur.runs++;
      if (e.status === "failed") cur.failed++;
      if (e.finishedAt) {
        cur.totalMs += new Date(e.finishedAt).getTime() - new Date(e.startedAt).getTime();
        cur.timed++;
      }
      m.set(e.skill, cur);
    }
    const out = new Map<string, SkillStats>();
    for (const [k, v] of m) {
      out.set(k, { runs: v.runs, failed: v.failed, avgMs: v.timed ? v.totalMs / v.timed : null });
    }
    return out;
  }, [audit.data]);
  const [reader, setReader] = useState<Reader | null>(null);
  const [runTarget, setRunTarget] = useState<Skill | null>(null);
  const [actingWarn, setActingWarn] = useState(false);
  const [freeRun, setFreeRun] = useState(false);
  const [creator, setCreator] = useState(false);
  const [architect, setArchitect] = useState(false);

  /** Gate an action behind acting mode; returns true when allowed. */
  function gated(fn: () => void) {
    if (!getSettings().actingMode) setActingWarn(true);
    else fn();
  }

  function onRun(sk: Skill) {
    gated(() => setRunTarget(sk));
  }

  const groups = useMemo(() => {
    const map = new Map<string, Skill[]>();
    for (const sk of data ?? []) {
      const key = sk.domain?.trim() || UNGROUPED;
      (map.get(key) ?? map.set(key, []).get(key)!).push(sk);
    }
    // Keep the catch-all group last; sort the rest alphabetically.
    return [...map.entries()].sort(([a], [b]) => {
      if (a === UNGROUPED) return 1;
      if (b === UNGROUPED) return -1;
      return a.localeCompare(b);
    });
  }, [data]);

  function openSkill(sk: Skill) {
    const base = {
      name: sk.name,
      skillId: sk.id,
      path: sk.path,
      draft: null,
      saving: false,
      improving: false,
    };
    setReader({ ...base, content: "", loading: true });
    api
      .readDocument(sk.path)
      .then((content) => setReader({ ...base, content, loading: false }))
      .catch((e) => setReader({ ...base, content: `Failed to read skill: ${e}`, loading: false }));
  }

  /** Ask the provider for a better SKILL.md based on recent run outputs; the
   * proposal lands as an editable draft, never saved directly. */
  function improveSkillDraft(r: Reader) {
    setReader({ ...r, improving: true });
    const runs = (audit.data ?? [])
      .filter((e) => e.skill === r.skillId)
      .slice(0, 5)
      .map((e) => ({ status: e.status, excerpt: e.outputExcerpt }));
    improveSkill(r.content, runs)
      .then((proposed) => setReader({ ...r, improving: false, draft: proposed }))
      .catch((e) => {
        notify.error(`Couldn't improve: ${e instanceof Error ? e.message : String(e)}`);
        setReader({ ...r, improving: false });
      });
  }

  function saveSkill(r: Reader) {
    if (r.draft === null) return;
    const draft = r.draft;
    setReader({ ...r, saving: true });
    api
      .writeSkill(r.path, draft)
      .then(() => {
        setReader({ ...r, content: draft, draft: null, saving: false });
        reload(); // frontmatter (name/description/model) may have changed
      })
      .catch((e) => {
        notify.error(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`);
        setReader({ ...r, saving: false });
      });
  }

  if (loading) return <Loading label="Finding skills…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;

  return (
    <Page
      title="Skills"
      subtitle="Codified workflows from ~/.claude/skills — the backbone of your agentic OS"
      actions={
        <span className="inline-flex items-center gap-2">
          <Button variant="subtle" onClick={() => gated(() => setFreeRun(true))}>
            <Terminal className="h-3.5 w-3.5" /> Run prompt
          </Button>
          <Button variant="subtle" onClick={() => gated(() => setCreator(true))}>
            <Sparkles className="h-3.5 w-3.5" /> New skill
          </Button>
          <Button variant="subtle" onClick={() => setArchitect(true)}>
            <ListTree className="h-3.5 w-3.5" /> OS architect
          </Button>
        <span
          className={
            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] " +
            (settings.actingMode
              ? "border-cyan/40 text-cyan"
              : "border-outline text-muted")
          }
          title={settings.actingMode ? "Skills can run" : "Enable Acting mode in Settings to run skills"}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{
              backgroundColor: settings.actingMode ? "#00f5ff" : "#555",
              boxShadow: settings.actingMode ? "0 0 6px #00f5ff" : "none",
            }}
          />
          acting {settings.actingMode ? "on" : "off"}
        </span>
        </span>
      }
    >
      {data.length === 0 ? (
        <EmptyState
          icon={Blocks}
          title="No skills yet"
          hint="Add skills under ~/.claude/skills/<name>/SKILL.md (a markdown file with a name and description). They'll appear here as one-click cards."
        />
      ) : (
        <div className="space-y-7">
          {groups.map(([domain, list]) => (
            <section key={domain}>
              <SectionTitle right={<span className="text-xs text-faint">{list.length}</span>}>
                {domain}
              </SectionTitle>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {list.map((sk) => (
                  <SkillCard
                    key={sk.id}
                    skill={sk}
                    stats={stats.get(sk.id)}
                    onView={() => openSkill(sk)}
                    onRun={() => onRun(sk)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <AutomationsSection skills={data} onGate={gated} />

      {runTarget && (
        <RunModal skill={runTarget} onClose={() => setRunTarget(null)} />
      )}
      {freeRun && <FreePromptModal onClose={() => setFreeRun(false)} />}
      {creator && <CreateSkillModal onClose={() => setCreator(false)} />}
      {architect && (
        <ArchitectModal skills={data} onGate={gated} onClose={() => setArchitect(false)} />
      )}

      <Modal
        open={actingWarn}
        title="Acting mode is off"
        onClose={() => setActingWarn(false)}
        actions={
          <Link
            to="/settings"
            onClick={() => setActingWarn(false)}
            className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 font-body text-sm font-bold text-[#05060a] [background:linear-gradient(135deg,#00f5ff,#c000ff)]"
          >
            Open Settings
          </Link>
        }
      >
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warn" />
          <p className="font-body text-sm leading-relaxed text-muted">
            Running skills launches a real headless <span className="font-mono text-text">claude -p</span>{" "}
            process on your machine. Turn on <span className="font-medium text-text">Acting mode</span>{" "}
            in Settings first — it's off by default so nothing executes without you opting in.
          </p>
        </div>
      </Modal>

      {reader && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ background: "rgba(3,6,9,0.72)", animation: "cmScrim 150ms ease both" }}
          onClick={() => setReader(null)}
        >
          <div
            className="flex max-h-[82vh] w-full max-w-2xl flex-col overflow-hidden rounded-[16px] border border-outline bg-surface-2 shadow-[var(--cm-shadow-3)]"
            style={{ animation: "cmPop 190ms var(--cm-ease) both" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 border-b border-outline px-5 py-3.5">
              <Blocks className="h-4 w-4 shrink-0 text-cyan" />
              <span className="flex-1 truncate font-mono text-sm text-text">{reader.name}</span>
              {reader.draft === null ? (
                !reader.loading && (
                  <>
                    {isProviderReady(settings) && (
                      <IconButton
                        title="Improve with AI (uses recent run outputs; you review before saving)"
                        onClick={() => !reader.improving && improveSkillDraft(reader)}
                      >
                        {reader.improving ? <Spinner className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
                      </IconButton>
                    )}
                    <IconButton
                      title="Edit skill"
                      onClick={() => setReader({ ...reader, draft: reader.content })}
                    >
                      <Pencil className="h-4 w-4" />
                    </IconButton>
                  </>
                )
              ) : (
                <>
                  <Button
                    variant="primary"
                    disabled={reader.saving || !reader.draft.trim()}
                    onClick={() => saveSkill(reader)}
                  >
                    <Save className="h-3.5 w-3.5" /> {reader.saving ? "Saving…" : "Save"}
                  </Button>
                  <Button
                    variant="subtle"
                    disabled={reader.saving}
                    onClick={() => setReader({ ...reader, draft: null })}
                  >
                    Cancel
                  </Button>
                </>
              )}
              <IconButton
                title="Reveal in file manager"
                onClick={() => withToast(api.revealPath(reader.path), { error: "Couldn't reveal file" })}
              >
                <FolderOpen className="h-4 w-4" />
              </IconButton>
              <IconButton title="Close" onClick={() => setReader(null)}>
                <X className="h-4 w-4" />
              </IconButton>
            </div>
            <div className="selectable flex flex-1 flex-col overflow-y-auto px-5 py-4">
              {reader.loading ? (
                <Loading label="Reading…" />
              ) : reader.draft !== null ? (
                <>
                  <div className="mb-3 [&>label]:mt-0">
                    <ModelField
                      value={getFrontModel(reader.draft)}
                      onChange={(v) => setReader({ ...reader, draft: setFrontModel(reader.draft!, v) })}
                    />
                  </div>
                  <textarea
                    value={reader.draft}
                    onChange={(e) => setReader({ ...reader, draft: e.target.value })}
                    autoFocus
                    spellCheck={false}
                    className="min-h-[50vh] w-full flex-1 resize-none rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-mono text-[13px] leading-relaxed text-fg outline-none focus:border-accent"
                  />
                </>
              ) : (
                <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-text">
                  {reader.content}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}

function SkillCard({
  skill,
  stats,
  onView,
  onRun,
}: {
  skill: Skill;
  stats?: SkillStats;
  onView: () => void;
  onRun: () => void;
}) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] border border-outline bg-surface-2 text-cyan">
          <Blocks className="h-4 w-4" strokeWidth={1.9} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-body text-[15px] font-semibold text-text">{skill.name}</div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-faint">
            {skill.id}
            {skill.model && <span className="text-violet"> · {skill.model}</span>}
          </div>
        </div>
      </div>
      <p className="line-clamp-3 min-h-[3rem] font-body text-[13px] leading-relaxed text-muted">
        {skill.description || "No description."}
      </p>
      {stats && stats.runs > 0 && (
        <div className="font-mono text-[10px] text-faint">
          {stats.runs} run{stats.runs === 1 ? "" : "s"}
          {stats.avgMs !== null && <> · ~{fmtDur(stats.avgMs)}</>}
          {stats.failed > 0 && <span className="text-warn"> · {stats.failed} failed</span>}
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-outline pt-3">
        <Button variant="subtle" className="flex-1" onClick={onRun}>
          <Play className="h-3.5 w-3.5" /> Run
        </Button>
        <IconButton title="View skill" onClick={onView}>
          <FileText className="h-4 w-4" />
        </IconButton>
        {skill.modified && (
          <span className="ml-auto hidden font-mono text-[11px] text-faint sm:inline">
            {formatRelative(skill.modified)}
          </span>
        )}
      </div>
    </Card>
  );
}

function ModelField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <>
      <label className="mb-1 mt-3 block text-xs font-medium text-faint">Model</label>
      <input
        type="text"
        list="cm-model-suggestions"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="default — or haiku / sonnet / opus / a full model id"
        className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2 font-mono text-[13px] text-fg outline-none placeholder:text-faint focus:border-accent"
      />
      <datalist id="cm-model-suggestions">
        <option value="haiku" />
        <option value="sonnet" />
        <option value="opus" />
      </datalist>
    </>
  );
}

/** Claude / Codex / Gemini engine toggle for headless runs. */
function EngineField({
  value,
  onChange,
}: {
  value: Engine;
  onChange: (e: Engine) => void;
}) {
  return (
    <div className="mt-3">
      <label className="mb-1 block text-xs font-medium text-faint">Engine</label>
      <div className="flex gap-1 rounded-lg border border-line bg-panel-2 p-1">
        {(["claude", "codex", "gemini"] as const).map((e) => (
          <button
            key={e}
            onClick={() => onChange(e)}
            className={
              "flex-1 rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors " +
              (value === e ? "bg-accent text-white" : "text-muted hover:text-fg")
            }
          >
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}

function RunModal({ skill, onClose }: { skill: Skill; onClose: () => void }) {
  const s = getSettings();
  const [prompt, setPrompt] = useState(defaultPrompt(skill));
  const [model, setModel] = useState(skill.model ?? "");
  const [engine, setEngine] = useState<Engine>("claude");
  const cwd = s.workDir || "~/.claude";

  function run() {
    startJob({ skill: skill.id, label: skill.name, prompt, model, engine });
    onClose();
  }

  return (
    <Modal
      open
      title={`Run · ${skill.name}`}
      onClose={onClose}
      actions={
        <Button variant="primary" onClick={run} disabled={!prompt.trim()}>
          <Play className="h-4 w-4" /> Run
        </Button>
      }
    >
      <label className="mb-1 block text-xs font-medium text-faint">Prompt</label>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={6}
        autoFocus
        className="w-full resize-y rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-mono text-[13px] leading-relaxed text-fg outline-none placeholder:text-faint focus:border-accent"
        placeholder='Use the "…" skill.'
      />
      <ModelField value={model} onChange={setModel} />
      <EngineField value={engine} onChange={setEngine} />
      <div className="mt-3 space-y-1 rounded-lg border border-outline bg-surface-1 px-3 py-2.5 font-mono text-[11px] text-muted">
        <div>
          {engine === "codex" ? (
            <>
              <span className="text-faint">exec</span> {s.codexBin || "codex"} exec "…"{" "}
              {model.trim() && <span className="text-faint">-m {model.trim()} </span>}
            </>
          ) : engine === "gemini" ? (
            <>
              <span className="text-faint">exec</span> {s.geminiBin || "gemini"} --yolo "…"{" "}
              {model.trim() && <span className="text-faint">-m {model.trim()} </span>}
            </>
          ) : (
            <>
              <span className="text-faint">exec</span> {s.claudeBin || "claude"} -p "…"{" "}
              {model.trim() && <span className="text-faint">--model {model.trim()} </span>}
              {s.claudeArgs && <span className="text-faint">{s.claudeArgs}</span>}
            </>
          )}
        </div>
        <div>
          <span className="text-faint">cwd</span> {cwd}
        </div>
      </div>
      <p className="mt-2 font-body text-[11px] leading-relaxed text-faint">
        Launches a real headless {engine === "codex" ? "Codex" : "Claude Code"} run. Output streams
        into the Jobs panel.
      </p>
    </Modal>
  );
}

function FreePromptModal({ onClose }: { onClose: () => void }) {
  const s = getSettings();
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState(s.workDir);
  const [engine, setEngine] = useState<Engine>("claude");

  function run() {
    const t = prompt.trim();
    startJob({
      skill: "adhoc",
      label: t.length > 48 ? `${t.slice(0, 48)}…` : t,
      prompt: t,
      cwd,
      engine,
    });
    onClose();
  }

  return (
    <Modal
      open
      title="Run a prompt"
      onClose={onClose}
      actions={
        <Button variant="primary" onClick={run} disabled={!prompt.trim()}>
          <Play className="h-4 w-4" /> Run
        </Button>
      }
    >
      <label className="mb-1 block text-xs font-medium text-faint">Prompt</label>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={6}
        autoFocus
        className="w-full resize-y rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-mono text-[13px] leading-relaxed text-fg outline-none placeholder:text-faint focus:border-accent"
        placeholder="Anything — summarize a repo, write a report, fix a file…"
      />
      <label className="mb-1 mt-3 block text-xs font-medium text-faint">Working directory</label>
      <input
        type="text"
        value={cwd}
        onChange={(e) => setCwd(e.target.value)}
        placeholder="~/.claude"
        className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2 font-mono text-[13px] text-fg outline-none placeholder:text-faint focus:border-accent"
      />
      <EngineField value={engine} onChange={setEngine} />
      <p className="mt-2 font-body text-[11px] leading-relaxed text-faint">
        Runs headless{" "}
        <span className="font-mono text-text">
          {engine === "codex"
            ? `${s.codexBin || "codex"} exec`
            : engine === "gemini"
              ? `${s.geminiBin || "gemini"} --yolo`
              : `${s.claudeBin || "claude"} -p`}
        </span>{" "}
        in the directory above. Output streams into the Jobs panel.
      </p>
    </Modal>
  );
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function CreateSkillModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const slug = slugify(name);

  function create() {
    startJob({
      skill: "skill-creator",
      label: `New skill: ${slug}`,
      prompt: `Create a new Claude Code skill file at ~/.claude/skills/${slug}/SKILL.md.

It must start with YAML frontmatter:
---
name: ${slug}
description: <one line saying what the skill does and when to use it>
---

followed by clear, step-by-step markdown instructions for carrying out the skill.

What the skill should do:
${desc.trim()}

Write the file, then print its full path and final contents.`,
    });
    onClose();
  }

  return (
    <Modal
      open
      title="New skill"
      onClose={onClose}
      actions={
        <Button variant="primary" onClick={create} disabled={!slug || !desc.trim()}>
          <Sparkles className="h-4 w-4" /> Create
        </Button>
      }
    >
      <label className="mb-1 block text-xs font-medium text-faint">Skill name</label>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
        placeholder="e.g. Weekly report"
        className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2 font-body text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
      />
      {slug && (
        <p className="mt-1 font-mono text-[11px] text-faint">~/.claude/skills/{slug}/SKILL.md</p>
      )}
      <label className="mb-1 mt-3 block text-xs font-medium text-faint">
        What should it do?
      </label>
      <textarea
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        rows={5}
        placeholder="Describe the workflow — Claude writes the skill file for you."
        className="w-full resize-y rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-body text-[13px] leading-relaxed text-fg outline-none placeholder:text-faint focus:border-accent"
      />
      <p className="mt-2 font-body text-[11px] leading-relaxed text-faint">
        A headless Claude run writes the skill file; it appears here once the job finishes (reload
        the page).
      </p>
    </Modal>
  );
}

function ArchitectModal({
  skills,
  onGate,
  onClose,
}: {
  skills: Skill[];
  onGate: (fn: () => void) => void;
  onClose: () => void;
}) {
  const settings = useSettings();
  const [dump, setDump] = useState("");
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<ProposedSkill[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());

  function propose() {
    setBusy(true);
    proposeArchitecture(dump, skills)
      .then((p) => {
        if (p.length === 0) {
          notify.info("Nothing repeatable found — describe your recurring tasks in more detail.");
        }
        setProposal(p);
        setChecked(new Set(p.map((s) => s.slug)));
      })
      .catch((e) => notify.error(`Couldn't propose: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setBusy(false));
  }

  function generate() {
    const selected = (proposal ?? []).filter((s) => checked.has(s.slug));
    if (selected.length === 0) return;
    onGate(() => {
      startJob({
        skill: "skill-creator",
        label: `OS architect: ${selected.length} skill${selected.length === 1 ? "" : "s"}`,
        prompt: generationPrompt(selected, settings.vaultDir),
      });
      let autos = 0;
      for (const s of selected) {
        if (s.automation?.time) {
          addAutomation({
            name: s.name,
            time: s.automation.time,
            prompt: `Use the "${s.name}" skill.\n\n`,
            model: s.model ?? undefined,
            enabled: false, // opt in from the Automations list once the skill exists
          });
          autos++;
        }
      }
      if (autos > 0) notify.info(`${autos} suggested automation${autos === 1 ? "" : "s"} added (disabled) — enable below when ready`);
      onClose();
    });
  }

  const domains = useMemo(() => {
    const m = new Map<string, ProposedSkill[]>();
    for (const s of proposal ?? []) (m.get(s.domain) ?? m.set(s.domain, []).get(s.domain)!).push(s);
    return [...m.entries()];
  }, [proposal]);

  return (
    <Modal
      open
      title="OS architect"
      onClose={onClose}
      actions={
        proposal === null ? (
          <Button variant="primary" onClick={propose} disabled={busy || dump.trim().length < 40}>
            {busy ? <Spinner className="h-4 w-4" /> : <ListTree className="h-4 w-4" />} Propose skills
          </Button>
        ) : (
          <Button variant="primary" onClick={generate} disabled={checked.size === 0}>
            <Sparkles className="h-4 w-4" /> Generate {checked.size} skill{checked.size === 1 ? "" : "s"}
          </Button>
        )
      }
    >
      {proposal === null ? (
        <>
          <p className="mb-2 font-body text-[13px] leading-relaxed text-muted">
            Stream of consciousness: what do you do day to day — at work and personally? Which
            tasks repeat? Talk or type; the more concrete, the better the proposed skills.
          </p>
          <div className="flex items-start gap-2">
            <textarea
              value={dump}
              onChange={(e) => setDump(e.target.value)}
              rows={8}
              autoFocus
              placeholder="Every morning I check AI news and my competitors… each week I have to report on…"
              className="w-full flex-1 resize-y rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-body text-[13px] leading-relaxed text-fg outline-none placeholder:text-faint focus:border-accent"
            />
            <MicButton onText={(t) => setDump((d) => (d ? `${d} ${t}` : t))} />
          </div>
        </>
      ) : (
        <div className="space-y-4">
          {domains.map(([domain, list]) => (
            <section key={domain}>
              <div className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-faint">{domain}</div>
              <div className="space-y-2">
                {list.map((s) => (
                  <label
                    key={s.slug}
                    className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-outline bg-surface-1 px-3 py-2.5"
                  >
                    <input
                      type="checkbox"
                      checked={checked.has(s.slug)}
                      onChange={() =>
                        setChecked((c) => {
                          const n = new Set(c);
                          n.has(s.slug) ? n.delete(s.slug) : n.add(s.slug);
                          return n;
                        })
                      }
                      className="mt-0.5 h-4 w-4 accent-cyan"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="font-body text-sm font-semibold text-text">{s.name}</span>
                        {s.model && <span className="font-mono text-[10px] text-violet">{s.model}</span>}
                        {s.automation && (
                          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-cyan">
                            <CalendarClock className="h-3 w-3" /> daily {s.automation.time}
                          </span>
                        )}
                      </span>
                      <span className="block font-body text-xs leading-relaxed text-muted">{s.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </section>
          ))}
          <p className="font-body text-[11px] leading-relaxed text-faint">
            One headless run writes every checked SKILL.md (requires Acting mode). Suggested
            automations are added disabled — enable them in the Automations list once the skills
            exist. Reload the page after the job finishes.
          </p>
        </div>
      )}
    </Modal>
  );
}

function AutomationsSection({
  skills,
  onGate,
}: {
  skills: Skill[];
  onGate: (fn: () => void) => void;
}) {
  const autos = useAutomations();
  const settings = useSettings();
  const [adding, setAdding] = useState(false);

  return (
    <section className="mt-8">
      <SectionTitle
        right={
          <Button variant="subtle" onClick={() => onGate(() => setAdding(true))}>
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        }
      >
        Automations
      </SectionTitle>
      {!settings.actingMode && autos.length > 0 && (
        <p className="mb-2 font-body text-xs text-warn">
          Acting mode is off — automations won't run until it's enabled in Settings.
        </p>
      )}
      {autos.length === 0 ? (
        <Card className="px-4 py-5 text-center font-body text-xs text-muted">
          Schedule a prompt or skill to run once a day at a set time (while the app is open) — e.g.
          a morning brief.
        </Card>
      ) : (
        <Card className="p-0">
          {autos.map((a) => (
            <div
              key={a.id}
              className={cn(
                "flex items-center gap-3 border-b border-outline px-4 py-3 last:border-0",
                !a.enabled && "opacity-45"
              )}
            >
              <CalendarClock className="h-4 w-4 shrink-0 text-violet" />
              <div className="min-w-0 flex-1">
                <div className="font-body text-sm font-semibold text-text">{a.name}</div>
                <div className="truncate font-mono text-[11px] text-faint">
                  {a.model && <span className="text-violet">{a.model} · </span>}
                  {a.prompt}
                </div>
              </div>
              <span className="shrink-0 font-mono text-xs text-muted">
                {a.time}
                <span className="text-faint"> · {daysLabel(a.days)}</span>
                {a.system && <span className="text-violet"> · system</span>}
              </span>
              {!a.system && a.lastRun && (
                <span className="hidden shrink-0 font-mono text-[10px] text-faint sm:inline">
                  ran {a.lastRun === new Date().toDateString() ? "today" : a.lastRun}
                </span>
              )}
              <IconButton
                title="Run now (also counts as today's run)"
                onClick={() =>
                  onGate(() => {
                    void runAutomation(a.id);
                  })
                }
              >
                <Play className="h-4 w-4" />
              </IconButton>
              <label className="flex shrink-0 cursor-pointer items-center" title={a.enabled ? "Disable" : "Enable"}>
                <input
                  type="checkbox"
                  checked={a.enabled}
                  onChange={() => {
                    if (a.system) {
                      api
                        .setSystemTaskEnabled(slugify(a.name), !a.enabled)
                        .then(() => toggleAutomation(a.id))
                        .catch((e) => notify.error(`Couldn't update the scheduled task: ${e}`));
                    } else {
                      toggleAutomation(a.id);
                    }
                  }}
                  className="h-4 w-4 accent-cyan"
                />
              </label>
              <IconButton
                title="Delete"
                onClick={() => {
                  if (a.system) {
                    api
                      .deleteSystemTask(slugify(a.name))
                      .then(() => removeAutomation(a.id))
                      .catch((e) => notify.error(`Couldn't remove the scheduled task: ${e}`));
                  } else {
                    removeAutomation(a.id);
                  }
                }}
              >
                <Trash2 className="h-4 w-4" />
              </IconButton>
            </div>
          ))}
        </Card>
      )}
      {adding && <AddAutomationModal skills={skills} onClose={() => setAdding(false)} />}
    </section>
  );
}

const DAY_ABBR = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const DAY_TOKENS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function daysLabel(days?: number[]): string {
  if (!days || days.length === 7) return "daily";
  if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) return "weekdays";
  return days.map((d) => DAY_ABBR[d]).join(" ");
}

function AddAutomationModal({ skills, onClose }: { skills: Skill[]; onClose: () => void }) {
  const [name, setName] = useState("");
  const [time, setTime] = useState("08:00");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [days, setDays] = useState<Set<number>>(new Set([0, 1, 2, 3, 4, 5, 6]));
  const [system, setSystem] = useState(false);
  const [busy, setBusy] = useState(false);

  async function add() {
    const daysArr = days.size === 7 ? undefined : [...days].sort((a, b) => a - b);
    if (system) {
      const s = getSettings();
      const argsStr = [s.claudeArgs, model.trim() && `--model ${model.trim()}`]
        .filter(Boolean)
        .join(" ");
      setBusy(true);
      try {
        await api.createSystemTask({
          slug: slugify(name),
          time,
          days: (daysArr ?? []).map((d) => DAY_TOKENS[d]),
          prompt: prompt.trim(),
          bin: s.claudeBin,
          args: argsStr,
          cwd: s.workDir,
        });
      } catch (e) {
        notify.error(`Couldn't register the task: ${e instanceof Error ? e.message : String(e)}`);
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    addAutomation({
      name: name.trim(),
      time,
      prompt: prompt.trim(),
      model: model.trim() || undefined,
      days: daysArr,
      system: system || undefined,
      enabled: true,
    });
    onClose();
  }

  return (
    <Modal
      open
      title="Add automation"
      onClose={onClose}
      actions={
        <Button
          variant="primary"
          onClick={add}
          disabled={busy || !name.trim() || !prompt.trim() || !time || days.size === 0}
        >
          {busy ? <Spinner className="h-4 w-4" /> : <Plus className="h-4 w-4" />} Add
        </Button>
      }
    >
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="mb-1 block text-xs font-medium text-faint">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            placeholder="Morning brief"
            className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2 font-body text-sm text-fg outline-none placeholder:text-faint focus:border-accent"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-faint">Time</label>
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="rounded-lg border border-line bg-panel-2 px-3 py-2 font-mono text-sm text-fg outline-none focus:border-accent"
          />
        </div>
      </div>
      {skills.length > 0 && (
        <>
          <label className="mb-1 mt-3 block text-xs font-medium text-faint">
            Prefill from a skill (optional)
          </label>
          <select
            defaultValue=""
            onChange={(e) => {
              const sk = skills.find((x) => x.id === e.target.value);
              if (sk) {
                setPrompt(defaultPrompt(sk));
                setModel(sk.model ?? "");
                if (!name.trim()) setName(sk.name);
              }
            }}
            className="w-full rounded-lg border border-line bg-panel-2 px-3 py-2 font-body text-sm text-fg outline-none focus:border-accent"
          >
            <option value="">— custom prompt —</option>
            {skills.map((sk) => (
              <option key={sk.id} value={sk.id}>
                {sk.name}
              </option>
            ))}
          </select>
        </>
      )}
      <label className="mb-1 mt-3 block text-xs font-medium text-faint">Prompt</label>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={5}
        className="w-full resize-y rounded-lg border border-line bg-panel-2 px-3 py-2.5 font-mono text-[13px] leading-relaxed text-fg outline-none placeholder:text-faint focus:border-accent"
        placeholder="What should run each day?"
      />
      <ModelField value={model} onChange={setModel} />
      <label className="mb-1 mt-3 block text-xs font-medium text-faint">Days</label>
      <div className="flex gap-1.5">
        {DAY_ABBR.map((d, i) => (
          <button
            key={d}
            type="button"
            onClick={() =>
              setDays((cur) => {
                const n = new Set(cur);
                n.has(i) ? n.delete(i) : n.add(i);
                return n;
              })
            }
            className={cn(
              "h-8 w-9 rounded-lg border font-mono text-xs transition-colors",
              days.has(i)
                ? "border-cyan/50 text-cyan"
                : "border-outline text-faint hover:text-muted"
            )}
          >
            {d}
          </button>
        ))}
      </div>
      <label className="mt-3 flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          checked={system}
          onChange={(e) => setSystem(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-cyan"
        />
        <span className="font-body text-xs leading-relaxed text-muted">
          Run even when the app is closed (registers a Windows scheduled task that pipes the
          prompt into headless Claude; output logs to ~/.claude/cipher-jobs/tasks)
        </span>
      </label>
      <p className="mt-2 font-body text-[11px] leading-relaxed text-faint">
        {system
          ? "Runs at the set time via Task Scheduler whether or not the app is open."
          : "Fires once a day at (or after) the set time while the app is open, as a headless Claude run in your configured working directory. Requires Acting mode."}
      </p>
    </Modal>
  );
}
