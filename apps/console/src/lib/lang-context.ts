import { createContext, useContext } from "react";
import type { Lang, Msg } from "./i18n";

export type LangCtx = { lang: Lang; t: (key: Msg) => string; toggle: () => void };

export const LangContext = createContext<LangCtx | null>(null);

export function useLang(): LangCtx {
  const v = useContext(LangContext);
  if (!v) throw new Error("useLang outside LangProvider");
  return v;
}
