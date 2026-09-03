import { useEffect, type ReactNode } from "react";
import type { Token } from "@/lib/market";
import { useDesk } from "@/lib/store";
import { FollowCopySync } from "./follow-copy-sync";
import { LiveAutoSync } from "./live-auto-sync";

type PulsePayload = { tokens?: Token[]; solUsd?: number | null };

async function pullLive(): Promise<PulsePayload | null> {
  try {
    const res = await fetch("/api/pulse");
    if (!res.ok) return null;
    return (await res.json()) as PulsePayload;
  } catch {
    return null;
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
      if (stop || inflight) return;
      inflight = true;
      void pullLive()
        .then((data) => {
          if (stop || !data) return;
          useDesk
            .getState()
            .ingestLive(data.tokens ?? [], typeof data.solUsd === "number" ? data.solUsd : null);
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
