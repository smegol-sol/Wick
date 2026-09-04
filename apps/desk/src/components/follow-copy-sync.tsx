import { useEffect, useRef } from "react";
import { fetchChainTape } from "@wick/core/solana-wallet";
import { useDesk } from "@/lib/store";

export function FollowCopySync() {
  const follows = useDesk((s) => s.follows);
  const walletPk = useDesk((s) => s.walletPk);
  const ingest = useDesk((s) => s.ingestFollowTape);
  const idx = useRef(0);

  useEffect(() => {
    if (!follows.length) return;
    let stop = false;
    const pull = () => {
      const list = follows.filter((f) => f.pk !== walletPk);
      if (!list.length) return;
      const i = idx.current % list.length;
      idx.current = i + 1;
      const pk = list[i]?.pk;
      if (!pk) return;
      void fetchChainTape(pk).then((prints) => {
        if (stop || prints == null) return;
        ingest(pk, prints);
      });
    };
    pull();
    const id = window.setInterval(pull, 12_000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [follows, walletPk, ingest]);

  return null;
}
