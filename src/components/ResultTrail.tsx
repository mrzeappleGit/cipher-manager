// Jarvis-style result pop-ups: every finished job leaves a dismissible card
// with its output tail and links to the vault files it wrote.

import { BookOpen, CheckCircle2, Terminal, X, XCircle } from "lucide-react";
import { api } from "../api";
import { dismissCard, openJobs, useJobs } from "../lib/jobs";
import { withToast } from "../lib/toast";

export function ResultTrail() {
  const { cards } = useJobs();
  if (cards.length === 0) return null;

  return (
    <div className="fixed bottom-16 right-4 z-[85] flex w-[22rem] flex-col-reverse gap-2">
      {cards.map((c) => (
        <div
          key={c.id}
          className="animate-fade rounded-[12px] border border-outline bg-surface-2 px-3.5 py-3 shadow-[var(--cm-shadow-3)]"
        >
          <div className="flex items-center gap-2">
            {c.ok ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-good" />
            ) : (
              <XCircle className="h-4 w-4 shrink-0 text-bad" />
            )}
            <span className="flex-1 truncate font-body text-sm font-semibold text-text">
              {c.label}
            </span>
            <button
              onClick={() => openJobs(c.id)}
              title="Open job output"
              className="rounded p-1 text-muted transition-colors hover:text-cyan"
            >
              <Terminal className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => dismissCard(c.id)}
              title="Dismiss"
              className="rounded p-1 text-muted transition-colors hover:text-cyan"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {c.excerpt && (
            <p className="mt-1.5 line-clamp-3 font-mono text-[11px] leading-relaxed text-muted">
              {c.excerpt}
            </p>
          )}
          {c.files.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {c.files.map((f) => (
                <button
                  key={f.path}
                  onClick={() =>
                    withToast(api.openUrl(`obsidian://open?path=${encodeURIComponent(f.path)}`), {
                      error: "Couldn't open Obsidian",
                    })
                  }
                  title="Open in Obsidian"
                  className="inline-flex max-w-full items-center gap-1 rounded-full border border-outline px-2 py-0.5 font-mono text-[10px] text-muted transition-colors hover:border-cyan/50 hover:text-cyan"
                >
                  <BookOpen className="h-3 w-3 shrink-0" />
                  <span className="truncate">{f.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
