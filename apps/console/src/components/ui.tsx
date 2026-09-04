import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "quiet" | "danger" | "up";

export function Button({
  variant = "quiet",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "inline-flex h-10 items-center justify-center gap-1.5 rounded-sm px-3.5 text-sm font-medium transition-colors duration-[var(--motion-quick)] disabled:cursor-not-allowed disabled:opacity-40",
        variant === "primary" && "bg-fg text-bg hover:bg-fg/90",
        variant === "quiet" && "bg-elevated text-fg hover:bg-elevated/70",
        variant === "danger" && "bg-down/15 text-down hover:bg-down/25",
        variant === "up" && "bg-up/15 text-up hover:bg-up/25",
        className,
      )}
    />
  );
}

export function Pill({
  tone = "muted",
  children,
  className,
}: {
  tone?: "muted" | "up" | "down" | "warn" | "accent";
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-xs px-2 font-mono text-2xs font-medium tracking-wide",
        tone === "muted" && "bg-elevated text-muted",
        tone === "up" && "bg-up/15 text-up",
        tone === "down" && "bg-down/15 text-down",
        tone === "warn" && "bg-warn/15 text-warn",
        tone === "accent" && "bg-accent/20 text-accent",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Kicker({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("kicker", className)}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-center text-sm text-muted">{children}</p>;
}

export function Stat({
  label,
  value,
  tone,
  className,
}: {
  label: string;
  value: ReactNode;
  tone?: "up" | "down" | "warn";
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col", className)}>
      <span className="truncate text-2xs text-subtle">{label}</span>
      <span
        className={cn(
          "truncate font-mono text-sm num",
          tone === "up" && "text-up",
          tone === "down" && "text-down",
          tone === "warn" && "text-warn",
        )}
      >
        {value}
      </span>
    </div>
  );
}
