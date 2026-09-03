import { cn } from "@/lib/utils";

export function Sheet({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <>
      <button
        type="button"
        className="sheet-veil fixed inset-0 z-50 bg-bg/70"
        aria-label="Close"
        onClick={onClose}
      />
      <div
        className={cn(
          "sheet-panel fixed inset-y-0 end-0 z-50 flex w-full flex-col bg-surface pb-[env(safe-area-inset-bottom)] shadow-[var(--shadow-border)]",
          wide ? "max-w-md" : "max-w-sm",
        )}
        role="dialog"
        aria-label={title}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-medium tracking-tight">{title}</h2>
          <button
            type="button"
            className="flex h-11 min-w-11 items-center justify-end text-xs text-muted hover:text-fg"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
      </div>
    </>
  );
}
