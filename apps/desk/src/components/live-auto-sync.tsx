import { useEffect } from "react";
import { pumpLiveAuto } from "@/lib/live-auto";

export function LiveAutoSync() {
  useEffect(() => {
    let stop = false;
    const id = window.setInterval(() => {
      if (!stop) void pumpLiveAuto();
    }, 1600);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, []);
  return null;
}
