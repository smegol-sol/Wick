import { useCallback, useMemo, useState, type ReactNode } from "react";
import { type Lang, readLang, t as translate, writeLang } from "./i18n";
import { LangContext, type LangCtx } from "./lang-context";

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => {
    const l = readLang();
    writeLang(l);
    return l;
  });
  const toggle = useCallback(() => {
    setLang((cur) => {
      const next: Lang = cur === "ar" ? "en" : "ar";
      writeLang(next);
      return next;
    });
  }, []);
  const value = useMemo<LangCtx>(
    () => ({ lang, t: (key) => translate(lang, key), toggle }),
    [lang, toggle],
  );
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}
