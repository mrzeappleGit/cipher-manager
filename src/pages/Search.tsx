import { Search as SearchIcon, Terminal, User } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Page } from "../components/Layout";
import { EmptyState, ErrorState, Loading } from "../components/ui";
import { api } from "../api";
import { useAsync } from "../lib/useAsync";
import { formatRelative } from "../lib/format";

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const active = debounced.length >= 2;
  const { data, error, loading } = useAsync(
    () => (active ? api.search(debounced, 200) : Promise.resolve([])),
    [debounced]
  );

  const results = data ?? [];

  return (
    <Page
      title="Search"
      subtitle="Full-text search across every prompt and message in all projects"
    >
      <div className="relative mb-5">
        <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-faint" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your conversations…"
          className="w-full rounded-xl border border-line bg-panel py-3.5 pl-11 pr-4 text-base text-fg outline-none placeholder:text-faint focus:border-accent"
        />
      </div>

      {!active ? (
        <EmptyState
          icon={SearchIcon}
          title="Search your Claude Code history"
          hint="Type at least 2 characters to search across all transcripts."
        />
      ) : loading ? (
        <Loading label="Searching transcripts…" />
      ) : error ? (
        <ErrorState message={error} />
      ) : results.length === 0 ? (
        <EmptyState
          icon={SearchIcon}
          title="No matches"
          hint={`Nothing found for "${debounced}".`}
        />
      ) : (
        <>
          <div className="mb-3 text-xs text-faint">
            {results.length}
            {results.length === 200 ? "+" : ""} matches
          </div>
          <div className="space-y-2">
            {results.map((r, i) => (
              <button
                key={i}
                onClick={() => navigate(`/projects/${r.projectId}/sessions/${r.sessionId}`)}
                className="block w-full rounded-xl border border-line bg-panel p-3.5 text-left transition-colors hover:border-line-2 hover:bg-panel-2"
              >
                <div className="mb-1.5 flex items-center gap-2 text-xs">
                  <span
                    className="flex h-5 w-5 items-center justify-center rounded"
                    style={{
                      backgroundColor: r.role === "user" ? "#7c6cf51f" : "#34d3991f",
                      color: r.role === "user" ? "#a78bfa" : "#34d399",
                    }}
                  >
                    {r.role === "user" ? (
                      <User className="h-3 w-3" />
                    ) : (
                      <Terminal className="h-3 w-3" />
                    )}
                  </span>
                  <span className="font-medium text-fg">{r.projectName}</span>
                  {r.sessionTitle && (
                    <>
                      <span className="text-faint">/</span>
                      <span className="truncate text-muted">{r.sessionTitle}</span>
                    </>
                  )}
                  <span className="ml-auto shrink-0 text-faint">
                    {formatRelative(r.timestamp)}
                  </span>
                </div>
                <div className="selectable text-sm leading-relaxed text-muted">
                  <Highlight text={r.snippet} query={debounced} />
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </Page>
  );
}

function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  const parts = useMemo(() => {
    const q = query.toLowerCase();
    if (!q) return [{ s: text, hit: false }];
    const lower = text.toLowerCase();
    const out: { s: string; hit: boolean }[] = [];
    let i = 0;
    while (i < text.length) {
      const idx = lower.indexOf(q, i);
      if (idx === -1) {
        out.push({ s: text.slice(i), hit: false });
        break;
      }
      if (idx > i) out.push({ s: text.slice(i, idx), hit: false });
      out.push({ s: text.slice(idx, idx + q.length), hit: true });
      i = idx + q.length;
    }
    return out;
  }, [text, query]);

  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded bg-accent/30 px-0.5 text-fg">
            {p.s}
          </mark>
        ) : (
          <span key={i}>{p.s}</span>
        )
      )}
    </>
  );
}
