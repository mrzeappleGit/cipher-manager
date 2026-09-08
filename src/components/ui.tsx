import clsx from "clsx";
import { AlertTriangle, Inbox, Loader2, type LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export const cn = clsx;

// ---------------------------------------------------------------------------
// Loading / error / empty
// ---------------------------------------------------------------------------

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("animate-[spin_0.8s_linear_infinite]", className)} />;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-muted">
      <Spinner className="h-6 w-6 text-cyan" />
      <span className="font-mono text-sm">{label}</span>
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-[14px] border border-error/40 bg-error/10 text-error">
        <AlertTriangle className="h-6 w-6" />
      </div>
      <div className="max-w-md font-body text-sm text-text">{message}</div>
      {onRetry && (
        <Button variant="subtle" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  hint,
  children,
}: {
  icon?: LucideIcon;
  title: string;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-[14px] border border-outline bg-surface-2 text-muted">
        <Icon className="h-6 w-6" />
      </div>
      <div className="font-display text-base font-semibold text-text">{title}</div>
      {hint && <div className="max-w-md font-body text-sm text-muted">{hint}</div>}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

export function Card({
  className,
  children,
  hover,
  onClick,
}: {
  className?: string;
  children: ReactNode;
  hover?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "rounded-[20px] border border-outline bg-surface-1",
        hover && "cursor-pointer transition-colors hover:border-outline-2 hover:bg-surface-2",
        className
      )}
    >
      {children}
    </div>
  );
}

/** A surface-2 panel used for charts, tables, and grouped content. */
export function Panel({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-[14px] border border-outline bg-surface-2 shadow-[var(--cm-shadow-1)]",
        className
      )}
    >
      {children}
    </div>
  );
}

export function SectionTitle({
  children,
  right,
}: {
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="font-display text-xs font-bold uppercase tracking-[0.06em] text-muted">
        {children}
      </h2>
      {right}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat cards
// ---------------------------------------------------------------------------

export function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: LucideIcon;
  accent?: string;
}) {
  return (
    <Card className="flex min-h-[110px] flex-col gap-2.5 p-4">
      <div className="font-display text-[10.5px] font-bold uppercase tracking-[0.06em] text-muted">
        {label}
      </div>
      <div className="font-mono text-[26px] leading-none text-text">{value}</div>
      {sub != null && <div className="font-mono text-xs text-cyan">{sub}</div>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Badge (chip): pill with an optional glowing color dot
// ---------------------------------------------------------------------------

export function Badge({
  children,
  color,
  className,
}: {
  children: ReactNode;
  color?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-outline bg-bg px-2 py-0.5 font-mono text-[10.5px] text-text",
        className
      )}
    >
      {color && (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: color, boxShadow: `0 0 5px ${color}` }}
        />
      )}
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type ButtonVariant = "primary" | "subtle" | "ghost" | "danger";

const buttonStyles: Record<ButtonVariant, string> = {
  // The one bold move — the neon gradient. Use once per screen.
  primary:
    "rounded-full font-bold text-[#05060a] shadow-[0_0_10px_rgba(0,245,255,0.4)] hover:brightness-110 [background:linear-gradient(135deg,#00f5ff,#c000ff)]",
  subtle:
    "rounded-lg border border-outline bg-surface-2 text-text hover:border-cyan/60 hover:text-text",
  ghost: "rounded-lg text-muted hover:bg-surface-2 hover:text-text",
  danger: "rounded-lg border border-error/40 bg-error/10 text-error hover:bg-error/20",
};

export function Button({
  variant = "subtle",
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-1.5 px-3.5 py-2 font-body text-sm font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-50",
        buttonStyles[variant],
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function IconButton({
  className,
  children,
  title,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      title={title}
      className={cn(
        "inline-flex items-center justify-center rounded-lg p-1.5 text-muted transition-all hover:bg-surface-1 hover:text-cyan",
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Bar (violet → cyan gradient fill with glow)
// ---------------------------------------------------------------------------

export function Bar({
  value,
  max,
  color,
  className,
}: {
  value: number;
  max: number;
  color?: string;
  className?: string;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className={cn("h-2 w-full overflow-hidden rounded-full bg-bg", className)}>
      <div
        className="h-full rounded-full transition-all"
        style={{
          width: `${pct}%`,
          background: color ?? "linear-gradient(90deg,#c000ff,#00f5ff)",
          boxShadow: "0 0 8px rgba(0,245,255,0.3)",
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function Modal({
  open,
  title,
  children,
  onClose,
  actions,
  danger,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  actions?: ReactNode;
  danger?: boolean;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(3,6,9,0.72)", animation: "cmScrim 150ms ease both" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-[20px] border border-outline bg-surface-3 shadow-[var(--cm-shadow-3)]"
        style={{ animation: "cmPop 190ms var(--cm-ease) both" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-6 pb-4 pt-5">
          {danger && (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] border border-error/35 bg-error/10 text-error">
              <AlertTriangle className="h-5 w-5" />
            </span>
          )}
          <div className="font-display text-lg font-bold text-text">{title}</div>
        </div>
        <div className="px-6 pb-5 font-body text-sm text-text">{children}</div>
        {actions && (
          <div className="flex justify-end gap-2.5 border-t border-outline bg-surface-2 px-6 py-4">
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
