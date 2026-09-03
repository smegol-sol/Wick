import type { InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-11 w-full rounded-sm bg-elevated px-3 text-sm text-fg outline-none",
        "shadow-[var(--shadow-border)] placeholder:text-subtle",
        "transition-[box-shadow] duration-150",
        "focus-visible:shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-accent)_70%,transparent)]",
        className,
      )}
      {...props}
    />
  );
}
