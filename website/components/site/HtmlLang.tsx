"use client";

import { useEffect } from "react";

/** One root layout serves every locale; this keeps <html lang> right after load. */
export function HtmlLang({ lang }: { lang: string }) {
  useEffect(() => {
    const previous = document.documentElement.lang;
    document.documentElement.lang = lang;
    return () => {
      document.documentElement.lang = previous;
    };
  }, [lang]);
  return null;
}
