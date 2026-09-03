import { cn } from "@/lib/utils";

export function PageTabs<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (id: T) => void;
  items: Array<{ id: T; label: string; count?: number }>;
}) {
  return (
    <div className="mb-3 flex flex-wrap gap-1">
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          onClick={() => onChange(it.id)}
          className={cn(
            "h-11 rounded-sm px-3 text-2xs font-medium tracking-wide transition-[background-color,color] duration-150",
            value === it.id ? "bg-fg text-bg" : "text-muted hover:text-fg",
          )}
        >
          {it.label}
          {it.count != null ? (
            <span className="ms-1.5 font-mono num opacity-70"> {it.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
