import { useMemo, useState } from "react";
import type { Candle, Side } from "@wick/core/market";
import { formatUsd } from "@wick/core/format";
import { useDesk } from "@/lib/store";
import { cn } from "@/lib/utils";

export type ChartMark = {
  price: number;
  label: string;
  tone: "up" | "down" | "muted";
};

export type ChartPrint = {
  ts: number;
  price: number;
  side: Side;
  label: string;
  sol: number;
};

export function CandleChart({
  candles,
  className,
  marks,
  prints,
}: {
  candles: Candle[];
  className?: string;
  marks?: ChartMark[];
  prints?: ChartPrint[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [tip, setTip] = useState<ChartPrint | null>(null);
  const msg = useDesk((s) => s.msg);
  const w = 640;
  const h = 240;
  const pad = 8;

  const stats = useMemo(() => {
    if (!candles.length) return null;
    const highs = candles.map((c) => c.h);
    const lows = candles.map((c) => c.l);
    let max = Math.max(...highs);
    let min = Math.min(...lows);
    const rawSpan = max - min || max * 0.04 || 1;
    for (const m of marks ?? []) {
      if (!Number.isFinite(m.price) || m.price <= 0) continue;
      if (m.price > max && m.price < max + rawSpan * 2) max = m.price;
      if (m.price < min && m.price > min - rawSpan * 2) min = Math.max(0, m.price);
    }
    const span = max - min || max * 0.04 || 1;
    return { max, min, span };
  }, [candles, marks]);

  const printX = useMemo(() => {
    if (!candles.length) return [];
    return (prints ?? []).map((p) => {
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < candles.length; i++) {
        const d = Math.abs(candles[i].t - p.ts);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return { p, i: best };
    });
  }, [candles, prints]);

  if (!stats || candles.length < 2) {
    return (
      <div
        className={cn(
          "flex h-56 items-center justify-center bg-surface text-2xs text-muted",
          className,
        )}
      >
        {msg("chartWait")}
      </div>
    );
  }

  const slot = (w - pad * 2) / candles.length;
  const y = (v: number) => {
    const raw = pad + ((stats.max - v) / stats.span) * (h - pad * 2);
    return Math.min(h - 4, Math.max(4, raw));
  };
  const active = hover != null ? candles[hover] : candles[candles.length - 1];
  const stroke = { up: "var(--color-up)", down: "var(--color-down)", muted: "var(--color-muted)" };
  const shown = tip ?? null;

  return (
    <div className={cn("relative", className)}>
      <div className="pointer-events-none absolute start-3 top-2 z-10 font-mono text-2xs text-muted num">
        {formatUsd(active.c, 6)}
        <span className={active.c >= active.o ? "text-up" : "text-down"}>
          {" "}
          {active.c >= active.o ? "+" : ""}
          {(((active.c - candles[0].o) / candles[0].o) * 100).toFixed(1)}%
        </span>
        {shown ? (
          <span className={shown.side === "buy" ? "text-up" : "text-down"}>
            {" "}
            · {shown.label} {shown.side} {shown.sol.toFixed(2)} SOL
          </span>
        ) : null}
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="h-56 w-full"
        onMouseLeave={() => {
          setHover(null);
          setTip(null);
        }}
        role="img"
        aria-label="Price candles"
      >
        {candles.map((c, i) => {
          const x = pad + i * slot + slot / 2;
          const up = c.c >= c.o;
          const top = y(Math.max(c.o, c.c));
          const bot = y(Math.min(c.o, c.c));
          const body = Math.max(1.2, bot - top);
          return (
            <g key={c.t} onMouseEnter={() => setHover(i)} className="cursor-crosshair">
              <rect x={x - slot / 2} y={0} width={slot} height={h} fill="transparent" />
              <line
                x1={x}
                x2={x}
                y1={y(c.h)}
                y2={y(c.l)}
                stroke={up ? "var(--color-up)" : "var(--color-down)"}
                strokeWidth={1}
              />
              <rect
                x={x - Math.max(1.4, slot * 0.32)}
                y={top}
                width={Math.max(2.8, slot * 0.64)}
                height={body}
                fill={up ? "var(--color-up)" : "var(--color-down)"}
              />
            </g>
          );
        })}
        {(marks ?? []).map((m) => {
          if (!Number.isFinite(m.price) || m.price < 0) return null;
          const yy = pad + ((stats.max - m.price) / stats.span) * (h - pad * 2);
          if (yy < pad - 1 || yy > h - pad + 1) return null;
          return (
            <g key={`${m.label}-${m.tone}`}>
              <line
                x1={pad}
                x2={w - pad}
                y1={yy}
                y2={yy}
                stroke={stroke[m.tone]}
                strokeWidth={1}
                strokeDasharray="4 5"
                opacity={0.85}
              />
              <text
                x={w - pad}
                y={yy - 3}
                textAnchor="end"
                fill={stroke[m.tone]}
                fontSize="10"
                fontFamily="IBM Plex Mono, ui-monospace, monospace"
              >
                {m.label}
              </text>
            </g>
          );
        })}
        {printX.map(({ p, i }, idx) => {
          if (!Number.isFinite(p.price) || p.price <= 0) return null;
          const x = pad + i * slot + slot / 2;
          const yy = y(p.price);
          const fill = p.side === "buy" ? "var(--color-up)" : "var(--color-down)";
          const s = 8;
          const pts =
            p.side === "buy"
              ? `${x},${yy - s} ${x - 6},${yy + 5} ${x + 6},${yy + 5}`
              : `${x},${yy + s} ${x - 6},${yy - 5} ${x + 6},${yy - 5}`;
          return (
            <g
              key={`${p.label}-${p.ts}-${idx}`}
              onMouseEnter={() => setTip(p)}
              onMouseLeave={() => setTip(null)}
              className="cursor-crosshair"
            >
              <circle cx={x} cy={yy} r={11} fill="transparent" />
              <polygon
                points={pts}
                fill={fill}
                stroke="var(--color-bg)"
                strokeWidth={1.4}
                opacity={0.96}
              />
            </g>
          );
        })}
        {hover != null ? (
          <line
            x1={pad + hover * slot + slot / 2}
            x2={pad + hover * slot + slot / 2}
            y1={0}
            y2={h}
            stroke="var(--color-border)"
            strokeDasharray="3 4"
          />
        ) : null}
      </svg>
    </div>
  );
}
