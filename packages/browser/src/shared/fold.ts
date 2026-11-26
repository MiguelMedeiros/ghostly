/**
 * Lower case, accents off, full-width and half-width forms as their usual ones: "Ação" reads "acao", "ＰＤＦ" "pdf",
 * "ｶﾞｲﾄﾞ" as "ガイド" does. How every search of the app matches, in the pages and in the engine.
 */
export function foldText(text: string): string {
  return text.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "");
}
