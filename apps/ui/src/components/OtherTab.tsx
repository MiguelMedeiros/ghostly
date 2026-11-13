import type { Translate, TranslationKey } from "../locales/translate";

/**
 * What the tab waits with: nothing of its own, a share on its way to the other tab, a share that went there, a share
 * the worker no longer held, a link it is handing to the other tab (and opens itself if that one closes first), or a
 * link the other tab took.
 */
export type OtherTabState = "plain" | "sharing" | "shared" | "shareNone" | "link" | "linkTaken";

const WORDS: Record<OtherTabState, [TranslationKey, TranslationKey]> = {
  plain: ["boot.otherTab", "boot.otherTabHint"],
  sharing: ["boot.sharing", "boot.otherTabHint"],
  shared: ["boot.shared", "boot.sharedHint"],
  shareNone: ["pwa.shareNone", "boot.otherTabHint"],
  link: ["boot.otherTab", "boot.linkHint"],
  linkTaken: ["boot.linkTaken", "boot.linkTakenHint"],
};

/**
 * "Ghostly is already open in another tab": what a second tab of the same profile shows while the first holds the
 * profile (or, opened for a share or a link, that it went to that tab). Drawn by the web entry before any provider
 * exists, so it is handed its translator, in the profile's language as the app would be. Redrawn in place as the share
 * or link goes over, its words are a polite status, so a screen reader hears whether the tab can be closed.
 */
export function OtherTab({ state, t }: { state: OtherTabState; t: Translate }) {
  const [said, hint] = WORDS[state];
  return (
    <div data-testid="other-tab" data-state={state} style={{ height: "100vh", display: "grid", placeItems: "center", background: "#0b141a", color: "#8696a0", font: "15px system-ui", textAlign: "center", padding: 24 }}>
      <div>
        <div style={{ fontSize: 48 }} aria-hidden="true">👻</div>
        <div role="status" aria-live="polite" aria-atomic="true" data-testid="other-tab-said">
          <p>{t(said)}</p>
          <p style={{ fontSize: 13 }}>{t(hint)}</p>
        </div>
      </div>
    </div>
  );
}
