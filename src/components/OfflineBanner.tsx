import { useI18n } from "../contexts/I18nContext";
import { useOnline } from "../hooks/useOnline";

/**
 * Above the chat list while the device has no network: the chats are all here (they live on this device), and
 * nothing goes out until it is back. The web app opens this way from its cache, with no server to reach.
 */
export function OfflineBanner() {
  const { t } = useI18n();
  const online = useOnline();
  if (online) return null;
  return (
    <div role="status" data-testid="offline-banner" className="shrink-0 border-b border-border bg-surface px-4 py-2 flex items-center gap-2.5">
      <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-text-muted" />
      <p className="m-0 min-w-0 text-xs text-text-secondary truncate">
        <span className="font-semibold text-text-primary">{t("pwa.offline")}</span>
        <span className="text-text-muted"> · {t("pwa.offlineHint")}</span>
      </p>
    </div>
  );
}
