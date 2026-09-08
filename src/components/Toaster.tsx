import { CheckCircle2, Info, XCircle } from "lucide-react";
import { useSyncExternalStore } from "react";
import { dismissToast, getToasts, subscribe, type ToastKind } from "../lib/toast";

const STYLES: Record<ToastKind, { cls: string; Icon: typeof Info }> = {
  error: { cls: "border-bad/40 bg-bad/15 text-bad", Icon: XCircle },
  success: { cls: "border-good/40 bg-good/15 text-good", Icon: CheckCircle2 },
  info: { cls: "border-line-2 bg-panel-2 text-fg", Icon: Info },
};

export function Toaster() {
  const toasts = useSyncExternalStore(subscribe, getToasts, getToasts);

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[100] flex w-80 flex-col gap-2">
      {toasts.map((t) => {
        const { cls, Icon } = STYLES[t.kind];
        return (
          <div
            key={t.id}
            onClick={
              t.onClick &&
              (() => {
                t.onClick!();
                dismissToast(t.id);
              })
            }
            className={`animate-fade pointer-events-auto flex items-start gap-2 rounded-lg border px-3.5 py-2.5 text-sm shadow-xl backdrop-blur ${cls} ${
              t.onClick ? "cursor-pointer hover:brightness-125" : ""
            }`}
          >
            <Icon className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="leading-snug">{t.msg}</span>
          </div>
        );
      })}
    </div>
  );
}
