/** The host name a fetched URL goes to ("" when it is no absolute URL): what a fake `fetch` tells services apart by. */
export function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}
