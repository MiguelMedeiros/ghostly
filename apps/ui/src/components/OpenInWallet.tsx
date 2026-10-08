import { useState, type ReactNode } from "react";
import { useI18n } from "../contexts/I18nContext";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { rawError } from "../lib/errorText";
import { type Problem } from "../lib/problemText";
import { Notice } from "./ui/Notice";

/**
 * A `lightning:` or `bitcoin:` link that opens a wallet on this device. A web page lets the browser follow it; the
 * desktop app and the extension hand it to the system themselves (`openPaymentLink`), since their page cannot: in
 * Desktop's WKWebView a link to another scheme goes nowhere. What went wrong shows beside the link.
 */
export function OpenInWallet({ uri, className, title, testId, children }: { uri: string; className?: string; title?: string; testId?: string; children: ReactNode }) {
  const { t } = useI18n();
  const platform = useServicesPlatform();
  const [error, setError] = useState<Problem | null>(null);
  return <>
    <a className={className} href={uri} title={title} data-testid={testId}
      onClick={(event) => {
        const opened = platform?.openPaymentLink(uri);
        if (!opened) return;
        event.preventDefault();
        setError(null);
        opened.catch((cause: unknown) => setError({ tone: "error", title: t("payments.external.openError"), next: t("payments.external.openErrorNext"), detail: rawError(cause) }));
      }}>
      {children}
    </a>
    {error && <Notice problem={error} testId={testId ? `${testId}-error` : undefined} className="text-xs m-0 basis-full" ink />}
  </>;
}
