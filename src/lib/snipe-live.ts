import { isB58 } from "./guard";

export function liveSnipeOk(
  settings: { execLive: boolean; snipeLive: boolean },
  tk: { live?: boolean; mint: string },
): boolean {
  return !!(settings.execLive && settings.snipeLive && tk.live && isB58(tk.mint));
}
