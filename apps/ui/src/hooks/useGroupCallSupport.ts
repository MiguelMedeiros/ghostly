import { useMemo } from "react";
import { useT } from "../contexts/I18nContext";
import { groupCallSupport } from "../desktop/groupCallSupport";
import { errorText } from "../lib/errorText";

/** What a group's call button reads: whether this app can join a group call, and why not, in the app's language. */
export interface ShownGroupCallSupport {
  supported: boolean;
  /** For the button's ⓘ while it is off (the Linux Desktop); null where this app can join. */
  reason: string | null;
}

/**
 * Whether this app can join a group call (`groupCallSupport`). Where it cannot, the button shows off, with the
 * reason in its ⓘ: the Linux Desktop, whose WebView has no WebRTC, is sent to the web app in a browser.
 */
export function useGroupCallSupport(): ShownGroupCallSupport {
  const t = useT();
  return useMemo(() => {
    const { supported, reason } = groupCallSupport();
    return { supported, reason: reason === null ? null : errorText(reason, t) };
  }, [t]);
}
