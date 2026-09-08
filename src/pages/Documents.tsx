import { BookOpen, FileText, FolderOpen, GitBranch, Sparkles, Sunrise, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Page } from "../components/Layout";
import { Badge, Card, EmptyState, ErrorState, IconButton, Loading, SectionTitle } from "../components/ui";
import { SpeakButton } from "../components/SpeakButton";
import { api, isSnapshot } from "../api";
import { notify, withToast } from "../lib/toast";
import { useAsync } from "../lib/useAsync";
import { useSettings } from "../lib/settings";
import { formatBytes, formatRelative } from "../lib/format";
import { lineDiff, type DiffLine } from "../lib/diff";
import type { DocFile, DoctorReport, InboxProposal, InboxSource } from "../types";

interface Reader {
  name: string;
  path?: string;
  content: string;
  loading: boolean;
}

const SUMMARY_PREFIX = "cipher-manager.summary.";

export default function DocumentsPage() {
  const { data, error, loading, reload } = useAsync(() => api.getDocuments(), []);
  const [reader, setReader] = useState<Reader | null>(null);

  const summaries = useMemo(() => {
    const out: { day: string; text: string }[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(SUMMARY_PREFIX)) {
          out.push({ day: k.slice(SUMMARY_PREFIX.length), text: localStorage.getItem(k) || "" });
        }
      }
    } catch {
      /* ignore */
    }
    out.sort((a, b) => b.day.localeCompare(a.day));
    return out;
  }, []);

  function openDoc(doc: DocFile) {
    setReader({ name: doc.name, path: doc.path, content: "", loading: true });
    api
      .readDocument(doc.path)
      .then((content) => setReader({ name: doc.name, path: doc.path, content, loading: false }))
      .catch((e) =>
        setReader({ name: doc.name, path: doc.path, content: `Failed to read file: ${e}`, loading: false })
      );
  }

  const vaultDir = useSettings().vaultDir.trim();
  const vault = useAsync<DocFile[]>(
    () => (vaultDir || isSnapshot() ? api.listVault(vaultDir) : Promise.resolve([])),
    [vaultDir]
  );
  const [vaultQuery, setVaultQuery] = useState("");
  const [syncing, setSyncing] = useState(false);
  const vaultFiles = useMemo(() => {
    const all = vault.data ?? [];
    const q = vaultQuery.trim().toLowerCase();
    return q ? all.filter((d) => d.name.toLowerCase().includes(q)) : all;
  }, [vault.data, vaultQuery]);

  // Morning briefs get their own section, newest first: vault output/briefs
  // (where the skill writes now) merged with legacy ~/.claude/plans brief-*.md.
  const briefs = useMemo(() => {
    const isBrief = (d: DocFile) =>
      d.name.toLowerCase().replace(/\\/g, "/").includes("output/briefs/") ||
      d.name.toLowerCase().startsWith("brief-");
    return [...(vault.data ?? []), ...(data?.plans ?? [])]
      .filter(isBrief)
      .sort((a, b) => (b.name.split(/[\\/]/).pop() ?? "").localeCompare(a.name.split(/[\\/]/).pop() ?? ""));
  }, [data, vault.data]);

  // Vault docs need the vault reader; everything else reads via ~/.claude.
  function openAny(doc: DocFile) {
    if (doc.kind === "vault") openVaultDoc(doc);
    else openDoc(doc);
  }

  // Deep link (#/documents?open=brief) from job notifications: open the newest brief.
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (params.get("open") === "brief" && briefs.length > 0) {
      openAny(briefs[0]);
      setParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, briefs]);

  function openVaultDoc(doc: DocFile) {
    setReader({ name: doc.name, path: doc.path, content: "", loading: true });
    api
      .readVaultFile(vaultDir, doc.path)
      .then((content) => setReader({ name: doc.name, path: doc.path, content, loading: false }))
      .catch((e) =>
        setReader({ name: doc.name, path: doc.path, content: `Failed to read file: ${e}`, loading: false })
      );
  }

  if (loading) return <Loading label="Finding documents…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;

  const plans = data.plans.filter((d) => !d.name.toLowerCase().startsWith("brief-"));

  const isEmpty = data.plans.length === 0 && data.memory.length === 0 && summaries.length === 0;

  return (
    <Page title="Documents" subtitle="Plans, project memory, and generated summaries in ~/.claude">
      {isEmpty ? (
        <EmptyState
          icon={FileText}
          title="No documents yet"
          hint="Plans, per-project memory, and AI summaries will show up here as you create them."
        />
      ) : (
        <div className="space-y-6">
          {briefs.length > 0 && (
            <section>
              <SectionTitle right={<span className="text-xs text-faint">~/.claude/plans</span>}>
                <span className="inline-flex items-center gap-1.5">
                  <Sunrise className="h-3.5 w-3.5" /> Morning briefs
                </span>
              </SectionTitle>
              <Card className="max-h-[19rem] overflow-y-auto p-0">
                {briefs.map((d) => (
                  <DocRow key={d.path} doc={d} onOpen={() => openAny(d)} />
                ))}
              </Card>
            </section>
          )}

          {plans.length > 0 && (
            <section>
              <SectionTitle right={<span className="text-xs text-faint">~/.claude/plans</span>}>
                Plans
              </SectionTitle>
              <Card className="overflow-hidden p-0">
                {plans.map((d) => (
                  <DocRow key={d.path} doc={d} onOpen={() => openDoc(d)} />
                ))}
              </Card>
            </section>
          )}

          {data.memory.map((g) => (
            <section key={g.title}>
              <SectionTitle right={<span className="text-xs text-faint">memory</span>}>
                {g.title}
              </SectionTitle>
              <Card className="overflow-hidden p-0">
                {g.docs.map((d) => (
                  <DocRow key={d.path} doc={d} onOpen={() => openDoc(d)} />
                ))}
              </Card>
            </section>
          ))}

          {summaries.length > 0 && (
            <section>
              <SectionTitle right={<span className="text-xs text-faint">local</span>}>
                AI summaries
              </SectionTitle>
              <Card className="overflow-hidden p-0">
                {summaries.map((s) => (
                  <button
                    key={s.day}
                    onClick={() => setReader({ name: `Summary · ${s.day}`, content: s.text, loading: false })}
                    className="group flex w-full items-center gap-3 border-b border-outline px-4 py-3 text-left last:border-0 transition-colors hover:bg-surface-3"
                  >
                    <Sparkles className="h-4 w-4 shrink-0 text-violet" />
                    <span className="font-body text-sm text-text">{s.day}</span>
                    <span className="flex-1 truncate font-body text-xs text-muted">{s.text}</span>
                  </button>
                ))}
              </Card>
            </section>
          )}
        </div>
      )}

      {vaultDir && (
        <section className="mt-6">
          <SectionTitle
            right={
              <span className="flex items-center gap-2">
                <input
                  value={vaultQuery}
                  onChange={(e) => setVaultQuery(e.target.value)}
                  placeholder="Filter…"
                  className="w-32 rounded-lg border border-outline bg-transparent px-2 py-1 font-body text-xs text-text outline-none placeholder:text-faint focus:border-accent"
                />
                <span className="font-mono text-xs text-faint">{vaultFiles.length}</span>
                <IconButton
                  title="Sync vault to GitHub (commit, pull, push)"
                  onClick={() => {
                    if (syncing) return;
                    setSyncing(true);
                    api
                      .syncVaultGit(vaultDir)
                      .then((msg) => notify.success(msg))
                      .catch((e) => notify.error(`Sync failed: ${e instanceof Error ? e.message : String(e)}`))
                      .finally(() => setSyncing(false));
                  }}
                >
                  <GitBranch className={syncing ? "h-4 w-4 animate-pulse" : "h-4 w-4"} />
                </IconButton>
              </span>
            }
          >
            <span className="inline-flex items-center gap-1.5">
              <BookOpen className="h-3.5 w-3.5" /> Vault
            </span>
          </SectionTitle>
          <VaultDoctor vaultDir={vaultDir} />
          {vaultDir && <MemoryInbox vaultDir={vaultDir} />}
          {vault.loading ? (
            <Loading label="Reading vault…" />
          ) : vault.error ? (
            <Card className="px-4 py-3 font-body text-xs text-warn">{vault.error}</Card>
          ) : vaultFiles.length === 0 ? (
            <Card className="px-4 py-5 text-center font-body text-xs text-muted">
              No markdown files found in <span className="font-mono">{vaultDir}</span>.
            </Card>
          ) : (
            <Card className="max-h-[28rem] overflow-y-auto p-0">
              {vaultFiles.map((d) => (
                <DocRow key={d.path} doc={d} onOpen={() => openVaultDoc(d)} />
              ))}
            </Card>
          )}
        </section>
      )}

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
              <FileText className="h-4 w-4 shrink-0 text-cyan" />
              <span className="flex-1 truncate font-mono text-sm text-text">{reader.name}</span>
              {!reader.loading && reader.content && (
                <SpeakButton id={`doc:${reader.name}`} text={reader.content} />
              )}
              {reader.path && (
                <>
                  <IconButton
                    title="Reveal in file manager"
                    onClick={() =>
                      withToast(api.revealPath(reader.path!), { error: "Couldn't reveal file" })
                    }
                  >
                    <FolderOpen className="h-4 w-4" />
                  </IconButton>
                </>
              )}
              <IconButton title="Close" onClick={() => setReader(null)}>
                <X className="h-4 w-4" />
              </IconButton>
            </div>
            <div className="selectable overflow-y-auto px-5 py-4">
              {reader.loading ? (
                <Loading label="Reading…" />
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

function VaultDoctor({ vaultDir }: { vaultDir: string }) {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      setReport(await api.vaultDoctor(vaultDir));
    } catch (e) {
      notify.error(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (busy || !report?.patch) return;
    const rel = report.contractRel ?? "CLAUDE.md";
    setBusy(true);
    try {
      // Append-only: never overwrite the existing contract body.
      let existing = "";
      if (report.contractRel) {
        existing = await api.readVaultFile(vaultDir, rel);
      }
      const next = existing ? `${existing.replace(/\s+$/, "")}\n${report.patch}` : report.patch;
      await api.writeVaultFile(vaultDir, rel, next);
      notify.success(`${rel} updated.`);
    } catch (e) {
      notify.error(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
    await run(); // re-diagnose — a good patch moves toward healthy
  }

  return (
    <div className="mb-4 rounded-[12px] border border-outline bg-surface-2 p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-display text-[11px] font-bold uppercase tracking-[1px] text-muted">
          Contract doctor
        </span>
        <button
          onClick={() => void run()}
          disabled={busy}
          className="rounded-lg border border-outline px-2.5 py-1 font-body text-xs text-muted transition-colors hover:border-cyan/50 hover:text-text disabled:opacity-50"
        >
          {busy ? "Checking…" : "Check routing"}
        </button>
      </div>
      {report && report.healthy && (
        <div className="font-body text-xs text-muted">
          ✓ Contract and folders agree — nothing to change.
        </div>
      )}
      {report && !report.healthy && (
        <>
          <ul className="mb-2 space-y-1">
            {report.findings.map((f, i) => (
              <li key={i} className="flex items-start gap-2 font-body text-xs text-muted">
                <span className="shrink-0 rounded bg-bg px-1.5 py-0.5 font-mono text-[10px] text-violet">
                  {f.kind}
                </span>
                {f.detail}
              </li>
            ))}
          </ul>
          {report.patch && (
            <>
              <div className="mb-1 font-body text-[11px] text-faint">
                Proposed {report.contractRel ? `addition to ${report.contractRel}` : "new CLAUDE.md"} — review, then apply:
              </div>
              <pre className="mb-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-outline bg-bg p-3 font-mono text-[11px] leading-relaxed text-muted">
                {report.patch}
              </pre>
              <button
                onClick={() => void apply()}
                disabled={busy}
                className="rounded-lg border border-cyan/40 bg-accent-soft px-3 py-1.5 font-body text-xs font-medium text-cyan transition-colors hover:brightness-110 disabled:opacity-50"
              >
                Apply to {report.contractRel ?? "CLAUDE.md"}
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}

function MemoryInbox({ vaultDir }: { vaultDir: string }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<InboxProposal[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // proposal id being decided
  const [diffs, setDiffs] = useState<Record<string, DiffLine[]>>({});
  const busyRef = useRef(false);

  useEffect(() => {
    api.inboxList().then(setItems).catch(() => setItems([]));
  }, []);

  const pending = (items ?? []).filter((p) => p.status === "pending");
  const decidedCount = (items ?? []).length - pending.length;
  if (!items || (pending.length === 0 && decidedCount === 0)) return null;

  async function decide(p: InboxProposal, approve: boolean) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(p.id);
    try {
      await api.inboxDecide(vaultDir, p.id, approve);
      setItems(await api.inboxList());
      notify[approve ? "success" : "info"](
        approve ? `Promoted — ${p.targetRel}` : "Rejected (vault untouched)."
      );
    } catch (e) {
      notify.error(String((e as Error).message ?? e));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  async function showDiff(p: InboxProposal) {
    if (diffs[p.id]) return;
    try {
      const existing = await api.readVaultFile(vaultDir, p.targetRel);
      // Compare bodies: strip the existing note's frontmatter (same regex as
      // parseMeetingNote) so the refreshed provenance block doesn't drown the diff.
      const body = existing.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
      setDiffs((m) => ({ ...m, [p.id]: lineDiff(body, p.body.trim()) }));
    } catch {
      setDiffs((m) => ({ ...m, [p.id]: lineDiff("", p.body.trim()) }));
    }
  }

  function sourceButton(s: InboxSource, i: number) {
    if (s.kind === "session" && s.projectId && s.sessionId) {
      const q = s.messageUuid ? `?msg=${s.messageUuid}` : "";
      return (
        <button
          key={i}
          onClick={() => navigate(`/projects/${s.projectId}/sessions/${s.sessionId}${q}`)}
          className="rounded border border-outline px-1.5 py-0.5 font-mono text-[10px] text-cyan hover:border-cyan/50"
        >
          {s.label}
        </button>
      );
    }
    if (s.rel) {
      const abs = `${vaultDir.replace(/[/\\]+$/, "")}/${s.rel}`;
      return (
        <button
          key={i}
          onClick={() =>
            void api.openUrl(`obsidian://open?path=${encodeURIComponent(abs)}`).catch(() => {})
          }
          className="rounded border border-outline px-1.5 py-0.5 font-mono text-[10px] text-violet hover:border-violet/50"
        >
          {s.label}
        </button>
      );
    }
    return (
      <span key={i} className="rounded border border-outline px-1.5 py-0.5 font-mono text-[10px] text-faint">
        {s.label}
      </span>
    );
  }

  return (
    <div className="mb-4 rounded-[12px] border border-outline bg-surface-2 p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-display text-[11px] font-bold uppercase tracking-[1px] text-muted">
          Memory inbox {pending.length > 0 && <span className="text-cyan">({pending.length})</span>}
        </span>
        {pending.some((p) => p.op === "create") && (
          <button
            onClick={async () => {
              for (const p of pending.filter((x) => x.op === "create")) await decide(p, true);
            }}
            disabled={busy !== null}
            className="rounded-lg border border-outline px-2.5 py-1 font-body text-xs text-muted transition-colors hover:border-cyan/50 hover:text-text disabled:opacity-50"
          >
            Approve all new notes
          </button>
        )}
      </div>
      {pending.length === 0 && (
        <div className="font-body text-xs text-muted">Nothing pending — {decidedCount} decided.</div>
      )}
      <div className="space-y-3">
        {pending.map((p) => (
          <div key={p.id} className="rounded-[10px] border border-outline bg-bg p-3">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span
                className="rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase"
                style={{
                  background: p.op === "create" ? "rgba(0,245,255,0.12)" : "rgba(192,0,255,0.12)",
                  color: p.op === "create" ? "#00f5ff" : "#c000ff",
                }}
              >
                {p.op}
              </span>
              <span className="font-body text-[13px] font-medium text-text">{p.title}</span>
              <span className="ml-auto font-mono text-[10px] text-faint">{p.targetRel}</span>
            </div>
            {p.reason && <div className="mb-1.5 font-body text-xs text-muted">{p.reason}</div>}
            <div className="mb-2 flex flex-wrap gap-1.5">{p.sources.map(sourceButton)}</div>
            {p.op === "update" ? (
              <details onToggle={() => void showDiff(p)} className="mb-2">
                <summary className="cursor-pointer font-body text-xs text-faint hover:text-text">
                  Show diff against the existing note
                </summary>
                <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-outline bg-surface-2 p-2 font-mono text-[11px] leading-relaxed">
                  {(diffs[p.id] ?? []).map((d, i) => (
                    <div
                      key={i}
                      className={
                        d.t === "add" ? "text-emerald-400" : d.t === "del" ? "text-error line-through" : "text-muted"
                      }
                    >
                      {d.t === "add" ? "+ " : d.t === "del" ? "- " : "  "}
                      {d.line}
                    </div>
                  ))}
                </pre>
              </details>
            ) : (
              <details className="mb-2">
                <summary className="cursor-pointer font-body text-xs text-faint hover:text-text">
                  Preview note
                </summary>
                <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-outline bg-surface-2 p-2 font-mono text-[11px] leading-relaxed text-muted">
                  {p.body}
                </pre>
              </details>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => void decide(p, true)}
                disabled={busy !== null}
                className="rounded-lg border border-cyan/40 bg-accent-soft px-3 py-1.5 font-body text-xs font-medium text-cyan transition-colors hover:brightness-110 disabled:opacity-50"
              >
                {busy === p.id ? "…" : "Approve"}
              </button>
              <button
                onClick={() => void decide(p, false)}
                disabled={busy !== null}
                className="rounded-lg border border-outline px-3 py-1.5 font-body text-xs text-muted transition-colors hover:border-warn hover:text-warn disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DocRow({ doc, onOpen }: { doc: DocFile; onOpen: () => void }) {
  return (
    <div
      onClick={onOpen}
      className="group flex cursor-pointer items-center gap-3 border-b border-outline px-4 py-3 last:border-0 transition-colors hover:bg-surface-3"
    >
      <FileText className="h-4 w-4 shrink-0 text-muted" />
      <span className="min-w-0 flex-1 truncate font-mono text-sm text-text">{doc.name}</span>
      <Badge>{doc.kind}</Badge>
      <span className="hidden w-16 text-right font-mono text-xs text-faint sm:inline">
        {formatBytes(doc.sizeBytes)}
      </span>
      <span className="hidden w-24 text-right font-mono text-xs text-muted md:inline">
        {formatRelative(doc.modified)}
      </span>
      <div
        className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        onClick={(e) => e.stopPropagation()}
      >
        {doc.kind === "vault" && (
          <IconButton
            title="Open in Obsidian"
            onClick={() =>
              withToast(api.openUrl(`obsidian://open?path=${encodeURIComponent(doc.path)}`), {
                error: "Couldn't open Obsidian",
              })
            }
          >
            <BookOpen className="h-4 w-4" />
          </IconButton>
        )}
        <IconButton
          title="Reveal in file manager"
          onClick={() => withToast(api.revealPath(doc.path), { error: "Couldn't reveal file" })}
        >
          <FolderOpen className="h-4 w-4" />
        </IconButton>
      </div>
    </div>
  );
}
