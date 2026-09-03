import { isB58 } from "./guard";

/** Auto snipes only fire when the user armed live sniping explicitly. */
export function liveSnipeOk(settings: { snipeLive: boolean }, tk: { mint: string }): boolean {
  return !!(settings.snipeLive && isB58(tk.mint));
}
