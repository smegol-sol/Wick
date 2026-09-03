import { useEffect, type ReactNode } from "react";
import type { Token } from "@/lib/market";
import { useDesk } from "@/lib/store";
import { FollowCopySync } from "./follow-copy-sync";
import { LiveAutoSync } from "./live-auto-sync";

async function pullLive(): Promise<Token[]> {
  try {
    const res = await fetch("/api/pulse");
    if (!res.ok) return [];
    const data = (await res.json()) as { tokens?: Token[] };
    return data.tokens?.length ? data.tokens : [];
  } catch {
    return [];
  }
}

export function MarketProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    let stop = false;
    let tickTimer = 0;
    let liveTimer = 0;
    let started = false;
    let inflight = false;

    const pull = () => {
      if (stop || inflight || !useDesk.getState().settings.liveOn) return;
      inflight = true;
      void pullLive()
        .then((rows) => {
          if (!stop && rows.length) useDesk.getState().ingestLive(rows);
        })
        .finally(() => {
          inflight = false;
        });
    };

    const start = () => {
      if (stop || started) return;
      started = true;
      useDesk.setState({ hydrated: true });
      tickTimer = window.setInterval(() => useDesk.getState().tick(), 900);
      pull();
      liveTimer = window.setInterval(pull, 7_000);
    };

    const unsub = useDesk.persist.onFinishHydration(start);
    void Promise.resolve(useDesk.persist.rehydrate()).finally(() => {
      if (!started) start();
    });

    return () => {
      stop = true;
      unsub();
      window.clearInterval(tickTimer);
      window.clearInterval(liveTimer);
    };
  }, []);
  return (
    <>
      <LiveAutoSync />
      <FollowCopySync />
      {children}
    </>
  );
}
