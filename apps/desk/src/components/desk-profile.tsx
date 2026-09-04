import { DeskFilters } from "./desk-filters";
import { Sheet } from "./sheet";
import { WalletChip } from "./wallet-chip";
import { formatSol } from "@wick/core/format";
import { canSignHot } from "@wick/core/hot-wallet";
import { useDesk } from "@/lib/store";
import { cn } from "@/lib/utils";

function Row({
  checked,
  onChange,
  warn,
  children,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  warn?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-h-12 items-center gap-3 border-b border-border px-2 last:border-0">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className={cn("size-4", warn ? "accent-warn" : "accent-accent")}
      />
      <span className={cn("text-sm", warn && checked ? "text-warn" : "text-fg")}>{children}</span>
    </label>
  );
}

export function DeskProfile({ onClose }: { onClose: () => void }) {
  const msg = useDesk((s) => s.msg);
  const settings = useDesk((s) => s.settings);
  const patch = useDesk((s) => s.patchSettings);
  const equity = useDesk((s) => s.equity());
  const chainSol = useDesk((s) => s.chainSol);
  const riskHalt = useDesk((s) => s.riskHalt);
  const vault = useDesk((s) => s.hotVault);
  const unlocked = useDesk((s) => s.hotUnlocked);
  const pk = useDesk((s) => s.walletPk);
  const hot = canSignHot(vault, unlocked, pk);

  return (
    <Sheet title={msg("profile")} onClose={onClose} wide>
      <div className="px-4 py-4">
        <p className="mb-4 font-mono text-2xs text-subtle">{msg("profileHint")}</p>

        <div className="mb-5 rounded-md bg-elevated p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="kicker">{msg("deskWallet")}</span>
            <WalletChip />
          </div>
          <div className="grid grid-cols-2 gap-3 font-mono text-sm num">
            <div>
              <div className="text-2xs text-subtle">{msg("equity")}</div>
              <div>{formatSol(equity)}</div>
            </div>
            <div>
              <div className="text-2xs text-subtle">{msg("chainSol")}</div>
              <div>{chainSol == null ? "—" : formatSol(chainSol)}</div>
            </div>
          </div>
          <p className="mt-3 font-mono text-2xs text-warn">
            {hot ? msg("execArmed") : vault ? msg("hotLocked") : msg("noWallet")}
            {riskHalt ? ` · ${msg("riskHalt")}` : ""}
          </p>
        </div>

        <h3 className="kicker mb-2">{msg("live")}</h3>
        <div className="mb-5 rounded-md bg-elevated px-1">
          <Row checked={settings.confirmLive} onChange={(on) => patch({ confirmLive: on })}>
            {msg("confirmLive")}
          </Row>
          <Row checked={settings.snipeLive} onChange={(on) => patch({ snipeLive: on })} warn>
            {msg("snipeLive")}
          </Row>
          <Row checked={settings.snipeLaunch} onChange={(on) => patch({ snipeLaunch: on })}>
            {msg("snipeLaunch")}
          </Row>
          <Row checked={settings.snipeMigrate} onChange={(on) => patch({ snipeMigrate: on })}>
            {msg("snipeMigrate")}
          </Row>
          <p className="px-2 py-2 font-mono text-2xs text-subtle">{msg("snipeLiveHint")}</p>
        </div>

        <h3 className="kicker mb-2">{msg("scan")}</h3>
        <div className="mb-5 rounded-md bg-elevated px-1">
          <Row checked={settings.hideRugs} onChange={(on) => patch({ hideRugs: on })}>
            {msg("hideRugs")}
          </Row>
          <Row checked={settings.hasX} onChange={(on) => patch({ hasX: on })}>
            {msg("hasX")}
          </Row>
          <label className="flex min-h-12 items-center justify-between gap-3 px-2">
            <span className="text-sm">{msg("quick")}</span>
            <input
              type="number"
              min={0.1}
              step={0.1}
              value={Number(Number(settings.quickBuy).toFixed(4))}
              onChange={(e) => patch({ quickBuy: Number(e.target.value) || 0.1 })}
              className="h-11 w-20 rounded-sm bg-bg px-2 font-mono text-sm text-fg outline-none"
            />
          </label>
        </div>

        <h3 className="kicker mb-2">{msg("filter")}</h3>
        <div className="rounded-md bg-elevated">
          <DeskFilters />
        </div>

        <p className="mt-5 text-2xs leading-relaxed text-subtle">{msg("about")}</p>
      </div>
    </Sheet>
  );
}
