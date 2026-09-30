import { useEffect, useState } from "react";
import { Button, Notice } from "../ui";
import type { ProviderFormProps } from "./forms";
import { useI18n } from "../../../contexts/I18nContext";

/** Whether a WebLN wallet has put `window.webln` in this page (some do so a moment after it loads). */
function useWeblnPresent() {
  const present = () => typeof (window as { webln?: { enable?: unknown } }).webln?.enable === "function";
  const [found, setFound] = useState(present);
  useEffect(() => {
    if (found) return;
    const check = () => { if (present()) setFound(true); };
    const poll = setInterval(check, 500);
    window.addEventListener("webln:ready", check);
    return () => { clearInterval(poll); window.removeEventListener("webln:ready", check); };
  }, [found]);
  return found;
}

/**
 * The browser wallet (WebLN) has nothing to type and no secret to keep: one button, and the wallet asks
 * the person to approve the connection in its own window.
 */
export function WeblnForm({ descriptor, busy, onSubmit }: ProviderFormProps) {
  const { t } = useI18n();
  const found = useWeblnPresent();
  return (
    <div className="space-y-3" data-testid={`provider-form-${descriptor.id}`}>
      {found ? (
        <Notice testId="webln-found">{t("wallet.source.webln.found")}</Notice>
      ) : (
        <Notice tone="warning" testId="webln-missing">{t("wallet.source.webln.missing")}</Notice>
      )}
      <Button variant="primary" className="w-full" disabled={busy} onClick={() => onSubmit({})} data-testid="provider-save">{busy ? t("wallet.source.webln.waiting") : t("wallet.source.webln.connect")}</Button>
      <Notice>{t("wallet.source.webln.note")}</Notice>
    </div>
  );
}
