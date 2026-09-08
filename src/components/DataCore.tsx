import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { formatCompact, formatDate, formatRelative, modelColor } from "../lib/format";
import { tokenTotal, type UsageStats } from "../types";

interface Hub {
  value: number; // project tokens (drives size)
  color: string; // hex, from model mix (drives tint)
}

interface Point {
  x: number;
  y: number;
  z: number;
  ph: number;
  cr: number;
  cg: number;
  cb: number;
  hub: boolean;
  hs: number; // hub size scale 0..1
  bright: boolean;
}

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Animated neon particle sphere. Node count and highlighted "hub" nodes are
 * data-driven: hubs are projects (sized by tokens, tinted by model), and the
 * overall density scales with activity.
 */
export function DataCore({
  className,
  count = 520,
  hubs = [],
}: {
  className?: string;
  count?: number;
  hubs?: Hub[];
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const N = Math.max(60, count);
    const maxHub = Math.max(1, ...hubs.map((hub) => hub.value));

    // --- jittered spherical point cloud (Fibonacci distribution) ---
    const pts: Point[] = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const yy = 1 - (i / (N - 1)) * 2;
      const rad = Math.sqrt(Math.max(0, 1 - yy * yy));
      const th = golden * i;
      const rr = 0.6 + Math.random() * 0.42;
      pts.push({
        x: Math.cos(th) * rad * rr + (Math.random() - 0.5) * 0.05,
        y: yy * rr + (Math.random() - 0.5) * 0.05,
        z: Math.sin(th) * rad * rr + (Math.random() - 0.5) * 0.05,
        ph: Math.random() * Math.PI * 2,
        cr: 0,
        cg: 245,
        cb: 255,
        hub: false,
        hs: 0,
        bright: Math.random() < 0.08,
      });
    }

    // --- designate spread-out hub nodes = projects ---
    for (let k = 0; k < hubs.length; k++) {
      const idx = Math.min(N - 1, Math.floor(((k + 0.5) / hubs.length) * N));
      const [cr, cg, cb] = hexRgb(hubs[k].color);
      const p = pts[idx];
      p.hub = true;
      p.hs = hubs[k].value / maxHub;
      p.cr = cr;
      p.cg = cg;
      p.cb = cb;
      p.bright = false;
    }

    // --- nearest-neighbor mesh edges ---
    const edges: Array<[number, number]> = [];
    const seen = new Set<string>();
    for (let i = 0; i < N; i++) {
      let n1 = -1,
        n2 = -1,
        d1 = Infinity,
        d2 = Infinity;
      for (let j = 0; j < N; j++) {
        if (j === i) continue;
        const dx = pts[i].x - pts[j].x;
        const dy = pts[i].y - pts[j].y;
        const dz = pts[i].z - pts[j].z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < d1) {
          d2 = d;
          n2 = n1;
          d1 = d;
          n1 = j;
        } else if (d < d2) {
          d2 = d;
          n2 = j;
        }
      }
      for (const j of [n1, n2]) {
        if (j < 0) continue;
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push([i, j]);
        }
      }
    }

    let w = 0,
      h = 0;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = rect.width;
      h = rect.height;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let tx = 0,
      ty = 0,
      mx = 0,
      my = 0;
    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      tx = (e.clientX - rect.left) / rect.width - 0.5;
      ty = (e.clientY - rect.top) / rect.height - 0.5;
    };
    const onLeave = () => {
      tx = 0;
      ty = 0;
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);

    const sx = new Float32Array(N);
    const sy = new Float32Array(N);
    const depth = new Float32Array(N);
    const rz = new Float32Array(N);
    const order = Array.from({ length: N }, (_, i) => i);

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let angle = 0;
    let t0 = performance.now();
    let raf = 0;
    let running = true;

    const render = (now: number) => {
      const dt = Math.min(0.05, (now - t0) / 1000);
      t0 = now;
      angle += dt * 0.18;
      mx += (tx - mx) * 0.05;
      my += (ty - my) * 0.05;

      const ay = angle + mx * 0.6;
      const ax = -0.32 + my * 0.5;
      const cosY = Math.cos(ay),
        sinY = Math.sin(ay),
        cosX = Math.cos(ax),
        sinX = Math.sin(ax);
      const R = Math.min(w, h) * 0.42;
      const cx = w / 2,
        cy = h / 2;
      const f = 3.2;

      for (let i = 0; i < N; i++) {
        const p = pts[i];
        const x = p.x * cosY - p.z * sinY;
        const z = p.x * sinY + p.z * cosY;
        const y2 = p.y * cosX - z * sinX;
        const z2 = p.y * sinX + z * cosX;
        const persp = f / (f - z2);
        sx[i] = cx + x * R * persp;
        sy[i] = cy + y2 * R * persp;
        rz[i] = z2;
        depth[i] = Math.max(0, Math.min(1, (z2 + 1.2) / 2.4));
      }
      order.sort((a, b) => rz[a] - rz[b]);

      ctx.clearRect(0, 0, w, h);

      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.5);
      g.addColorStop(0, "rgba(0,245,255,0.14)");
      g.addColorStop(0.42, "rgba(0,245,255,0.045)");
      g.addColorStop(1, "rgba(0,245,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      ctx.globalCompositeOperation = "lighter";

      for (const [i, j] of edges) {
        const d = (depth[i] + depth[j]) / 2;
        ctx.strokeStyle = `rgba(0,245,255,${(0.04 + d * 0.2).toFixed(3)})`;
        ctx.lineWidth = 0.5 + d * 0.7;
        ctx.beginPath();
        ctx.moveTo(sx[i], sy[i]);
        ctx.lineTo(sx[j], sy[j]);
        ctx.stroke();
      }

      for (const i of order) {
        const p = pts[i];
        const d = depth[i];
        const tw = 0.7 + 0.3 * Math.sin(now * 0.002 + p.ph);
        if (p.hub) {
          const r = (0.7 + d * 1.9) * (1.5 + p.hs * 1.9);
          const a = Math.min(1, (0.35 + d * 0.6) * tw);
          // soft halo
          ctx.fillStyle = `rgba(${p.cr},${p.cg},${p.cb},${(a * 0.22).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(sx[i], sy[i], r * 2.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = `rgba(${p.cr},${p.cg},${p.cb},${a.toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(sx[i], sy[i], r, 0, Math.PI * 2);
          ctx.fill();
        } else {
          const r = (p.bright ? 1.5 : 1) * (0.7 + d * 1.9);
          const a = Math.min(1, (0.22 + d * 0.7) * tw);
          ctx.fillStyle = p.bright
            ? `rgba(190,255,255,${a.toFixed(3)})`
            : `rgba(0,245,255,${a.toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(sx[i], sy[i], r, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.globalCompositeOperation = "source-over";
      if (running && !reduce) raf = requestAnimationFrame(render);
    };

    const onVis = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!reduce) {
        running = true;
        t0 = performance.now();
        raf = requestAnimationFrame(render);
      }
    };
    document.addEventListener("visibilitychange", onVis);

    if (reduce) render(performance.now());
    else raf = requestAnimationFrame(render);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
    };
  }, [count, hubs]);

  return <canvas ref={ref} className={className} />;
}

// ---------------------------------------------------------------------------
// Hero: the data core with corner HUD cards + a center headline metric
// ---------------------------------------------------------------------------

function Corner({ className }: { className: string }) {
  return <span className={`pointer-events-none absolute h-4 w-4 border-cyan/25 ${className}`} />;
}

function HudCard({
  label,
  value,
  className,
  onClick,
}: {
  label: string;
  value: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`absolute w-[168px] max-w-[42%] rounded-[8px] border border-outline bg-bg/70 px-3 py-2 backdrop-blur-sm transition-colors ${
        onClick ? "cursor-pointer hover:border-cyan/50" : ""
      } ${className ?? ""}`}
    >
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 rotate-45 bg-cyan" style={{ boxShadow: "0 0 6px #00f5ff" }} />
        <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-cyan">{label}</span>
      </div>
      <div className="mt-1 truncate font-mono text-[11px] text-muted">{value}</div>
    </div>
  );
}

export function UsageCore({
  usage,
  onOpenProject,
}: {
  usage: UsageStats;
  onOpenProject?: (id: string) => void;
}) {
  const { total, top, hubs, count } = useMemo(() => {
    const total = tokenTotal(usage.tokens);
    const projects = [...usage.byProject]
      .filter((p) => tokenTotal(p.tokens) > 0)
      .sort((a, b) => tokenTotal(b.tokens) - tokenTotal(a.tokens));

    // Model mix → hub colors (proportional to token share).
    const models = [...usage.byModel]
      .filter((m) => tokenTotal(m.tokens) > 0)
      .sort((a, b) => tokenTotal(b.tokens) - tokenTotal(a.tokens));
    const totalModel = models.reduce((s, m) => s + tokenTotal(m.tokens), 0) || 1;
    const pickColor = (frac: number) => {
      let acc = 0;
      for (const m of models) {
        acc += tokenTotal(m.tokens) / totalModel;
        if (frac <= acc) return modelColor(m.model);
      }
      return "#00f5ff";
    };

    const capped = projects.slice(0, 50);
    const hubs: Hub[] = capped.map((p, i) => ({
      value: tokenTotal(p.tokens),
      color: pickColor((i + 0.5) / Math.max(1, capped.length)),
    }));

    // Density scales with activity (bounded).
    const count = Math.max(
      220,
      Math.min(900, Math.round(usage.sessionCount * 6 + usage.projectCount * 12 + 160))
    );

    return { total, top: projects[0], hubs, count };
  }, [usage]);

  return (
    <div className="relative mb-4 h-[360px] overflow-hidden rounded-[14px] border border-outline bg-surface-2 shadow-[var(--cm-shadow-1)]">
      <DataCore className="absolute inset-0 h-full w-full" count={count} hubs={hubs} />

      <Corner className="left-3 top-3 border-l border-t" />
      <Corner className="right-3 top-3 border-r border-t" />
      <Corner className="bottom-3 left-3 border-b border-l" />
      <Corner className="bottom-3 right-3 border-b border-r" />

      {top && (
        <HudCard
          className="left-5 top-5"
          label="Top project"
          value={top.name}
          onClick={onOpenProject ? () => onOpenProject(top.id) : undefined}
        />
      )}
      <HudCard className="right-5 top-5" label="Last active" value={formatRelative(usage.lastActivity)} />
      <HudCard className="bottom-5 left-5" label="Projects" value={`${usage.projectCount} · ${hubs.length} mapped`} />
      <HudCard
        className="bottom-5 right-5"
        label="Sessions"
        value={`${formatCompact(usage.sessionCount)} · ${usage.byModel.length} models`}
      />

      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
        <div className="mb-3 flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[3px] text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-cyan" style={{ boxShadow: "0 0 6px #00f5ff" }} />
          Usage core
          {usage.firstActivity && (
            <span className="text-faint">
              · {formatDate(usage.firstActivity)} – {formatDate(usage.lastActivity)}
            </span>
          )}
        </div>
        <div
          className="font-mono text-[56px] font-medium leading-none text-text"
          style={{ textShadow: "0 0 26px rgba(0,245,255,0.4)" }}
        >
          {formatCompact(total)}
        </div>
        <div className="mt-3 font-display text-[11px] font-bold uppercase tracking-[3px] text-muted">
          tokens processed
        </div>
      </div>
    </div>
  );
}
