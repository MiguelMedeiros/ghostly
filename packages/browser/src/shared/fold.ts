/** Lower case, accents off: "Ação" reads "acao". How every search of the app matches, in the pages and in the engine. */
export function foldText(text: string): string {
  return text.normalize("NFD").toLowerCase().replace(/\p{M}/gu, "");
}
