import { useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { useI18n } from "../contexts/I18nContext";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const reconnectingNow = () => engine.reconnecting;

/**
 * Above the chat list while this page lost the Ghostly peer and its tries to reach it again fail (an extension tab
 * whose peer restarted, `EngineClient.reconnecting`): nothing new arrives here until one succeeds, and the page keeps
 * trying by itself. Goes once it is connected again.
 */
export function ReconnectingBanner() {
  const { t } = useI18n();
  const reconnecting = useSyncExternalStore(subscribe, reconnectingNow);
  if (!reconnecting) return null;
  return (
    <div role="status" data-testid="reconnecting-banner" className="shrink-0 border-b border-border bg-surface px-4 py-2 flex items-start gap-2.5">
      <span aria-hidden="true" className="mt-1 h-2 w-2 shrink-0 rounded-full bg-text-muted" />
      <p className="m-0 min-w-0 text-xs text-text-secondary">
        <span className="font-semibold text-text-primary">{t("pwa.reconnecting")}</span>
        <span className="text-text-muted"> · {t("pwa.reconnectingHint")}</span>
      </p>
    </div>
  );
}
