import { Link, useRouterState } from "@tanstack/react-router";
import { Activity, Bell, BookOpen, Copy, Radio, ScanLine, Sigma, CircleUser } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { WickMark } from "./mark";
import { Input } from "./ui/input";
import { DeskProfile } from "./desk-profile";
import { RadarPanel, RadarToast } from "./radar-panel";
import { RiskChip } from "./risk-strip";
import { ChainBagSync } from "./chain-bag-sync";
import { HotLockSync } from "./hot-lock-sync";
import { formatSol } from "@/lib/format";
import { canSignHot } from "@/lib/hot-wallet";
import { type Alert, useDesk } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { Msg } from "@/lib/i18n";

const NAV: Array<{ to: string; key: Msg; icon: typeof Radio }> = [
  { to: "/", key: "pulse", icon: Radio },
  { to: "/discover", key: "scan", icon: ScanLine },
  { to: "/lab", key: "lab", icon: Sigma },
  { to: "/tape", key: "tape", icon: Activity },
  { to: "/copy", key: "copyDesk", icon: Copy },
  { to: "/book", key: "book", icon: BookOpen },
];

export function DeskShell({ children }: { children: React.ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const msg = useDesk((s) => s.msg);
  const equity = useDesk((s) => s.equity());
  const settings = useDesk((s) => s.settings);
  const armLiveStore = useDesk((s) => s.armLive);
  const alerts = useDesk((s) => s.alerts);
  const tokens = useDesk((s) => s.tokens);
  const liveOk = useDesk((s) => s.liveOk);
  const liveAt = useDesk((s) => s.liveAt);
  const now = useDesk((s) => s.now);
  const [q, setQ] = useState("");
  const [radar, setRadar] = useState(false);
  const [profile, setProfile] = useState(false);
  const [toast, setToast] = useState<Alert | null>(null);
  const [needSign, setNeedSign] = useState(false);
  const toastId = useRef<string | null>(null);
  const unread = alerts.filter((a) => !a.read).length;
  const latest = alerts[0];
  const armed = settings.execLive || settings.snipeLive;

  useEffect(() => {
    document.documentElement.lang = "en";
    document.documentElement.dir = "ltr";
  }, []);

  useEffect(() => {
    if (radar || profile || !latest || latest.read) return;
    if (latest.id === toastId.current) return;
    toastId.current = latest.id;
    setToast(latest);
    const t = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(t);
  }, [latest?.id, latest?.read, radar, profile]);

  const hits = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (query.length < 1) return [];
    return tokens
      .filter((t) => `${t.symbol} ${t.name} ${t.mint}`.toLowerCase().includes(query))
      .slice(0, 6);
  }, [q, tokens]);

  function armLive(on: boolean) {
    if (!on) {
      armLiveStore(false);
      setNeedSign(false);
      return;
    }
    const st = useDesk.getState();
    if (canSignHot(st.hotVault, st.hotUnlocked, st.walletPk)) {
      armLiveStore(true);
      setNeedSign(false);
      return;
    }
    setNeedSign(true);
    setProfile(true);
  }

  return (
    <div dir="ltr" className="flex h-dvh max-h-dvh flex-col overflow-hidden bg-bg text-fg">
      <ChainBagSync />
      <HotLockSync />
      <header className="sticky top-0 z-40 border-b border-border bg-bg/95 backdrop-blur-sm">
        <div className="flex items-center gap-2 px-3 py-2">
          <Link to="/" className="flex items-center gap-2 pe-1">
            <WickMark className="size-6" />
            <span className="text-[11px] font-semibold tracking-[0.22em] uppercase">{msg("app")}</span>
          </Link>
          <nav className="hidden items-center gap-0.5 xl:flex">
            {NAV.map((n) => {
              const on = n.to === "/" ? pathname === "/" : pathname.startsWith(n.to);
              return (
                <Link
                  key={n.to}
                  to={n.to}
                  className={cn(
                    "flex h-11 items-center rounded-sm px-3 text-xs font-medium tracking-wide",
                    on ? "bg-elevated text-fg" : "text-muted hover:text-fg",
                  )}
                >
                  {msg(n.key)}
                </Link>
              );
            })}
          </nav>
          <div className="relative ms-auto min-w-0 flex-1 max-w-[11rem] sm:max-w-xs">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={msg("search")}
              aria-label={msg("search")}
              className="h-11 text-base md:text-sm"
            />
            {hits.length ? (
              <ul className="absolute inset-x-0 top-full z-40 mt-1 overflow-hidden rounded-md bg-surface shadow-[var(--shadow-border)]">
                {hits.map((t) => (
                  <li key={t.id}>
                    <Link
                      to="/token/$id"
                      params={{ id: t.id }}
                      className="flex items-center justify-between px-3 py-2 text-sm hover:bg-elevated"
                      onClick={() => setQ("")}
                    >
                      <span>{t.symbol}</span>
                      <span className="font-mono text-2xs text-muted">{t.chain}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <span className="hidden h-9 items-center rounded-sm px-2 font-mono text-2xs uppercase sm:flex">
            <span className="text-warn">{msg("execArmed")}</span>
          </span>
          <RiskChip />
          <div className="hidden text-end sm:block">
            <div className="font-mono text-2xs text-muted">{msg("equity")}</div>
            <div className="font-mono text-xs num">{formatSol(equity)}</div>
          </div>
          <button
            className="relative flex size-11 items-center justify-center rounded-sm text-muted hover:text-fg"
            onClick={() => {
              setProfile(false);
              setRadar((v) => !v);
            }}
            aria-label={msg("alerts")}
          >
            <Bell className="size-4" />
            {unread > 0 ? (
              <span className="absolute top-1.5 end-1.5 min-w-4 rounded-full bg-accent px-1 text-center font-mono text-2xs leading-4 text-accent-fg num">
                {unread > 9 ? "9+" : unread}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            className={cn(
              "relative flex size-11 items-center justify-center rounded-sm",
              profile ? "bg-elevated text-fg" : "text-muted hover:text-fg",
            )}
            onClick={() => {
              setRadar(false);
              setProfile((v) => !v);
            }}
            aria-label={msg("profile")}
          >
            <CircleUser className="size-4" />
            {armed ? <span className="absolute top-1.5 end-1.5 size-1.5 rounded-full bg-warn" /> : null}
          </button>
        </div>
      </header>

      {!radar && !profile && toast ? (
        <RadarToast
          alert={toast}
          onOpen={() => {
            setToast(null);
            setRadar(true);
          }}
        />
      ) : null}

      <main
        className={cn(
          "relative flex min-h-0 flex-1 flex-col pb-[calc(3.25rem+env(safe-area-inset-bottom))] xl:pb-0",
          pathname === "/" ? "overflow-y-auto xl:overflow-hidden" : "overflow-y-auto",
        )}
      >
        {children}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-6 border-t border-border bg-bg/95 pb-[env(safe-area-inset-bottom)] xl:hidden">
        {NAV.map((n) => {
          const on = n.to === "/" ? pathname === "/" : pathname.startsWith(n.to);
          const Icon = n.icon;
          return (
            <Link
              key={n.to}
              to={n.to}
              className={cn(
                "relative flex min-h-12 flex-col items-center justify-center gap-0.5 text-[10px] tracking-wide",
                on ? "text-fg" : "text-muted",
              )}
            >
              {on ? <span className="absolute inset-x-4 top-0 h-px bg-fg" /> : null}
              <Icon className="size-4" />
              {msg(n.key)}
            </Link>
          );
        })}
      </nav>

      {radar ? (
        <RadarPanel
          onClose={() => setRadar(false)}
        />
      ) : null}
      {profile ? (
        <DeskProfile
          onClose={() => setProfile(false)}
          needSign={needSign}
          onArmLive={armLive}
        />
      ) : null}
    </div>
  );
}
