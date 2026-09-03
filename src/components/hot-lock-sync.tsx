import { useEffect } from "react";
import { idleLockDue, touchHot } from "@/lib/hot-wallet";
import { useDesk } from "@/lib/store";

export function HotLockSync() {
  const unlocked = useDesk((s) => s.hotUnlocked);

  useEffect(() => {
    if (!unlocked) return;
    let hiddenSince = document.hidden ? Date.now() : 0;
    const bump = () => touchHot();
    const onVis = () => {
      hiddenSince = document.hidden ? Date.now() : 0;
      if (!document.hidden) touchHot();
    };
    const id = window.setInterval(() => {
      if (!idleLockDue(hiddenSince)) return;
      useDesk.getState().lockHotSession();
    }, 4_000);
    window.addEventListener("pointerdown", bump);
    window.addEventListener("keydown", bump);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("pointerdown", bump);
      window.removeEventListener("keydown", bump);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [unlocked]);

  return null;
}
