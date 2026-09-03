import { cn } from "@/lib/utils";

export function WickMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("text-fg", className)} aria-hidden>
      <rect x="14.5" y="3" width="3" height="7" fill="currentColor" opacity="0.4" />
      <rect x="10" y="10" width="12" height="15" fill="currentColor" />
      <rect x="14.5" y="25" width="3" height="4" className="fill-accent" />
    </svg>
  );
}

export function TokenMark({ id, symbol, className }: { id: string; symbol: string; className?: string }) {
  const n = id.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const rot = (n % 4) * 90;
  return (
    <div
      className={cn(
        "relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-elevated font-mono text-2xs font-medium tracking-wide text-fg",
        className,
      )}
      aria-hidden
    >
      <span
        className="absolute inset-1 rounded-xs bg-accent/25"
        style={{ transform: `rotate(${rot}deg)` }}
      />
      <span className="relative">{symbol.slice(0, 2)}</span>
    </div>
  );
}
