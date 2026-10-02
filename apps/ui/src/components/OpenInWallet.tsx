import { useState, type ReactNode } from "react";
import { useI18n } from "../contexts/I18nContext";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { errorText } from "../lib/errorText";

/**
 * A `lightning:` or `bitcoin:` link that opens a wallet on this device. A web page lets the browser follow it; the
 * desktop app and the extension hand it to the system themselves (`openPaymentLink`), since their page cannot: in
 * Desktop's WKWebView a link to another scheme goes nowhere. What went wrong shows beside the link.
 */
export function OpenInWallet({ uri, className, title, testId, children }: { uri: string; className?: string; title?: string; testId?: string; children: ReactNode }) {
  const { t } = useI18n();
  const platform = useServicesPlatform();
  const [error, setError] = useState("");
  return <>
    <a className={className} href={uri} title={title} data-testid={testId}
      onClick={(event) => {
        const opened = platform?.openPaymentLink(uri);
        if (!opened) return;
        event.preventDefault();
        setError("");
        opened.catch((cause: unknown) => setError(t("payments.external.openError", { error: errorText(cause, t) })));
      }}>
      {children}
    </a>
    {error && <p role="alert" className="text-danger-ink text-xs m-0 basis-full" data-testid={testId ? `${testId}-error` : undefined}>{error}</p>}
  </>;
}
