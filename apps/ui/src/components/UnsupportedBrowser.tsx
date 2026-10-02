import { useState } from "react";
import type { Essential } from "../lib/bootCheck";
import type { Translate, TranslationKey } from "../locales/translate";

const MISSING: Record<Essential, TranslationKey> = {
  storage: "boot.missingStorage",
  indexedDB: "boot.missingIndexedDB",
  crypto: "boot.missingCrypto",
  locks: "boot.missingLocks",
};

/**
 * "Ghostly can't run in this browser": what it lacks of what the app cannot do without (lib/bootCheck), and what
 * to try. Drawn by the web entry instead of the app, before any provider exists: it is handed its translator, and
 * its styles are its own (the app's stylesheet may be what the browser cannot read).
 */
export function UnsupportedBrowser({ missing, details, t }: { missing: readonly Essential[]; details: string; t: Translate }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(details);
      setCopied(true);
    } catch {
      // No clipboard here: the field below is selected, to copy by hand.
      const field = document.querySelector<HTMLTextAreaElement>('[data-testid="unsupported-details"]');
      field?.focus();
      field?.select();
    }
  };
  const button = { margin: "12px 6px 0", padding: "9px 16px", borderRadius: 8, border: "1px solid #3b4a54", background: "#202c33", color: "#e9edef", font: "inherit", fontWeight: 600, cursor: "pointer" } as const;
  return (
    <div role="alert" data-testid="unsupported-browser"
      style={{ minHeight: "100vh", display: "grid", placeItems: "center", boxSizing: "border-box", padding: 24, background: "#0b141a", color: "#e9edef", font: "15px/1.45 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", textAlign: "center" }}>
      <div style={{ maxWidth: 420, width: "100%" }}>
        <div style={{ fontSize: 48 }} aria-hidden="true">👻</div>
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: "12px 0 8px" }}>{t("boot.title")}</h1>
        <ul style={{ listStyle: "none", margin: "0 0 8px", padding: 0, color: "#aebac1" }}>
          {missing.map((what) => <li key={what} data-testid={`unsupported-${what}`} style={{ margin: "0 0 6px" }}>{t(MISSING[what])}</li>)}
        </ul>
        <p style={{ margin: "0 0 8px" }}>{t(missing.every((what) => what === "crypto") ? "boot.trySecure" : "boot.tryOther")}</p>
        <button type="button" style={button} onClick={() => location.reload()}>{t("boot.reload")}</button>
        <button type="button" style={button} data-testid="unsupported-copy" onClick={() => void copy()}>{t(copied ? "boot.copied" : "boot.copy")}</button>
        <textarea readOnly rows={6} data-testid="unsupported-details" aria-label={t("boot.copy")} value={details}
          style={{ display: "block", width: "100%", boxSizing: "border-box", marginTop: 16, padding: 8, borderRadius: 8, border: "1px solid #3b4a54", background: "#111b21", color: "#aebac1", font: "11px/1.4 ui-monospace, Menlo, Consolas, monospace", textAlign: "left", direction: "ltr", resize: "vertical" }} />
      </div>
    </div>
  );
}
