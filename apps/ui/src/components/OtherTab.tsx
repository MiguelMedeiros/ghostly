import type { Translate, TranslationKey } from "../locales/translate";

/**
 * What the tab waits with: nothing of its own, a share that went to the other tab, a link it is handing to the other
 * tab (and opens itself if that one closes first), or a link the other tab took.
 */
export type OtherTabState = "plain" | "shared" | "link" | "linkTaken";

const WORDS: Record<OtherTabState, [TranslationKey, TranslationKey]> = {
  plain: ["boot.otherTab", "boot.otherTabHint"],
  shared: ["boot.shared", "boot.sharedHint"],
  link: ["boot.otherTab", "boot.linkHint"],
  linkTaken: ["boot.linkTaken", "boot.linkTakenHint"],
};

/**
 * "Ghostly is already open in another tab": what a second tab of the same profile shows while the first holds the
 * profile (or, opened for a share or a link, that it went to that tab). Drawn by the web entry before any provider
 * exists, so it is handed its translator, in the profile's language as the app would be.
 */
export function OtherTab({ state, t }: { state: OtherTabState; t: Translate }) {
  const [said, hint] = WORDS[state];
  return (
    <div data-testid="other-tab" data-state={state} style={{ height: "100vh", display: "grid", placeItems: "center", background: "#0b141a", color: "#8696a0", font: "15px system-ui", textAlign: "center", padding: 24 }}>
      <div>
        <div style={{ fontSize: 48 }} aria-hidden="true">👻</div>
        <p>{t(said)}</p>
        <p style={{ fontSize: 13 }}>{t(hint)}</p>
      </div>
    </div>
  );
}
