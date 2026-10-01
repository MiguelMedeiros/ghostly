/**
 * Why a check for updates failed, in words a person can act on. The updater's own message (Tauri's on Desktop, a
 * fetch error in a browser) is kept for the ⓘ as it is; this names what it means. Not in `lib/updates.ts`: that
 * module is swapped for the platform's on every client, Desktop included.
 */
export type UpdateFailure = "offline" | "timeout" | "signature" | "notForThisSystem" | "noRelease" | "unreachable" | "unknown";

/** The failure `message` names; `online` is whether the device thinks it has a network at all. */
export function updateFailure(message: string, online = typeof navigator === "undefined" ? true : navigator.onLine): UpdateFailure {
  if (!online) return "offline";
  if (/timed? ?out|timeout/i.test(message)) return "timeout";
  // A signature that is missing, not valid base64, signed for another version or does not verify (minisign).
  if (/signature|signed for version/i.test(message)) return "signature";
  // The release's latest.json has no build for this OS and architecture (Tauri's TargetNotFound and its fallback).
  if (/platforms?\b.*not found|none of the fallback platforms/i.test(message)) return "notForThisSystem";
  // Every endpoint answered, but none with a release: an HTTP error (a release still being published), or JSON that
  // is not one.
  if (/valid release JSON|release not found|missing field|expected value|EOF while parsing|decoding response body/i.test(message)) return "noRelease";
  // No answer at all: DNS, TLS, a refused or dropped connection. `Failed to fetch` / `Load failed` / `NetworkError`
  // are the browsers' words for it.
  if (/error sending request|failed to fetch|load failed|networkerror|network|dns|connect|certificate|tls/i.test(message)) return "unreachable";
  return "unknown";
}
