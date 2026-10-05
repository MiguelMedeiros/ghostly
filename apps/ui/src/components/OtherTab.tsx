import type { Translate } from "../locales/translate";

/**
 * "Ghostly is already open in another tab": what a second tab of the same profile shows while the first holds the
 * profile (or, opened for a share, that the share went to that tab). Drawn by the web entry before any provider
 * exists, so it is handed its translator, in the profile's language as the app would be.
 */
export function OtherTab({ sharing, t }: { sharing: boolean; t: Translate }) {
  return (
    <div data-testid="other-tab" style={{ height: "100vh", display: "grid", placeItems: "center", background: "#0b141a", color: "#8696a0", font: "15px system-ui", textAlign: "center", padding: 24 }}>
      <div>
        <div style={{ fontSize: 48 }} aria-hidden="true">👻</div>
        <p>{t(sharing ? "boot.shared" : "boot.otherTab")}</p>
        <p style={{ fontSize: 13 }}>{t(sharing ? "boot.sharedHint" : "boot.otherTabHint")}</p>
      </div>
    </div>
  );
}
