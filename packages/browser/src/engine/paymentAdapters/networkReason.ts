import { engineText } from "@ghostly/core";

/**
 * A request's failure as a person says it, when the browser's own words say nothing: a request that timed out or was
 * given up ("Fetch is aborted" in Safari, "signal timed out" in Chromium) did not answer in time; one that never left
 * ("Failed to fetch", "Load failed") could not reach it. `host` names what was asked, when known. Anything else is
 * `null`: its own words are kept.
 */
export function networkReason(error: unknown, host?: string): string | null {
  const name = error instanceof Error ? error.name : "";
  const text = error instanceof Error ? error.message : String(error);
  if (name === "AbortError" || name === "TimeoutError" || /^(fetch is aborted|signal timed out|signal is aborted without reason|the (user|operation) (aborted a request|was aborted)\.?|this operation was aborted|the operation timed out\.?)$/i.test(text.trim()))
    return host ? engineText("hostTimedOut", { host }) : engineText("networkTimedOut");
  if (/^(failed to fetch|load failed|fetch failed|networkerror when attempting to fetch resource\.?|network request failed)$/i.test(text.trim()))
    return host ? engineText("hostUnreachable", { host }) : engineText("networkUnreachable");
  return null;
}

/** A request URL's host, for a reason that names it; the URL itself when it does not parse. */
export function rpcHost(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}
