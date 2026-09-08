// Minimal global toast store (no external deps, no context provider needed).

export type ToastKind = "error" | "success" | "info";
export interface Toast {
  id: number;
  kind: ToastKind;
  msg: string;
  /** When set, the toast is clickable (jump to a result) and lingers longer. */
  onClick?: () => void;
}

let toasts: Toast[] = [];
let listeners: Array<() => void> = [];
let counter = 1;

function emit() {
  for (const l of listeners) l();
}

export function subscribe(l: () => void): () => void {
  listeners.push(l);
  return () => {
    listeners = listeners.filter((x) => x !== l);
  };
}

export function getToasts(): Toast[] {
  return toasts;
}

export function toast(kind: ToastKind, msg: unknown, onClick?: () => void): void {
  const id = counter++;
  toasts = [...toasts, { id, kind, msg: messageOf(msg), onClick }];
  emit();
  setTimeout(() => dismissToast(id), onClick ? 9000 : 4200);
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

// `unknown`, not `string`, on purpose: half the call sites pass a caught error
// straight through. Tauri's `invoke` rejects with the RAW value, so a Rust
// `Result<_, String>` arrives as a plain string — `.message` on it is
// undefined, and `notify.error((e as Error).message)` renders a toast with no
// text at all. Coercing here fixes every call site at once instead of asking
// ~20 of them to remember.
export const notify = {
  error: (m: unknown, onClick?: () => void) => toast("error", m, onClick),
  success: (m: unknown, onClick?: () => void) => toast("success", m, onClick),
  info: (m: unknown, onClick?: () => void) => toast("info", m, onClick),
};

/** Pass the caught value straight to `notify.*` where you can — this is for
 *  the sites that need the text inline in a template. */
export function messageOf(e: unknown): string {
  const raw = e && typeof e === "object" && "message" in e ? (e as { message?: unknown }).message : e;
  const s = raw == null ? "" : String(raw);
  // A blank message is the bug this exists to kill — never render an empty toast.
  return s.trim() || "Failed, but reported no error message.";
}

/** Run a promise, showing a toast on failure (and optionally on success). */
export function withToast<T>(
  p: Promise<T>,
  opts: { error: string; success?: string }
): Promise<T | void> {
  return p
    .then((v) => {
      if (opts.success) notify.success(opts.success);
      return v;
    })
    .catch((e) => {
      notify.error(`${opts.error}: ${messageOf(e)}`);
    });
}
