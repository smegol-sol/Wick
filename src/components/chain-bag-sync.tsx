import { useEffect } from "react";
import { fetchChainBag, fetchChainTape } from "@/lib/solana-wallet";
import { useDesk } from "@/lib/store";

export function ChainBagSync() {
  const pk = useDesk((s) => s.walletPk);
  const watchPk = useDesk((s) => s.watchPk);
  const nonce = useDesk((s) => s.bagNonce);
  const setChainBag = useDesk((s) => s.setChainBag);
  const setChainTape = useDesk((s) => s.setChainTape);
  const setWatchBag = useDesk((s) => s.setWatchBag);
  const setWatchTape = useDesk((s) => s.setWatchTape);

  useEffect(() => {
    if (!pk) return;
    let stop = false;
    const pull = () => {
      void fetchChainBag(pk).then((bag) => {
        if (stop) return;
        if (bag) setChainBag(bag.sol, bag.holdings, bag.tokensOk);
        else setChainBag(null, [], false);
      });
      void fetchChainTape(pk).then((prints) => {
        if (stop || prints == null) return;
        setChainTape(prints);
      });
    };
    pull();
    const id = window.setInterval(pull, 20_000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [pk, nonce, setChainBag, setChainTape]);

  useEffect(() => {
    if (!watchPk || watchPk === pk) return;
    let stop = false;
    const pull = () => {
      void fetchChainBag(watchPk).then((bag) => {
        if (stop) return;
        if (bag) setWatchBag(bag.sol, bag.holdings);
        else setWatchBag(null, []);
      });
      void fetchChainTape(watchPk).then((prints) => {
        if (stop || prints == null) return;
        setWatchTape(prints);
      });
    };
    pull();
    const id = window.setInterval(pull, 20_000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [watchPk, pk, nonce, setWatchBag, setWatchTape]);

  return null;
}
