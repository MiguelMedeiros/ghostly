import { useI18n } from "../contexts/I18nContext";
import { useIsMobile } from "../hooks/useIsMobile";
import { useOnline } from "../hooks/useOnline";

/**
 * Above the chat list while the device has no network: the chats are all here (they live on this device), and
 * nothing goes out until it is back. The web app opens this way from its cache, with no server to reach.
 * `inChat`: under an open chat's header, on a phone only, where the list is on another screen; wider, the list (or the
 * notices over the page, when it is a rail) shows it beside the chat. The sentence wraps rather than being cut before
 * its point: the list is 420 px wide on a desktop.
 */
export function OfflineBanner({ inChat = false }: { inChat?: boolean }) {
  const { t } = useI18n();
  const online = useOnline();
  const phone = useIsMobile();
  if (online || (inChat && !phone)) return null;
  return (
    <div role="status" data-testid={inChat ? "chat-offline-banner" : "offline-banner"} className="shrink-0 border-b border-border bg-surface px-4 py-2 flex items-start gap-2.5">
      <span aria-hidden="true" className="mt-1 h-2 w-2 shrink-0 rounded-full bg-text-muted" />
      <p className="m-0 min-w-0 text-xs text-text-secondary">
        <span className="font-semibold text-text-primary">{t("pwa.offline")}</span>
        <span className="text-text-muted"> · {t("pwa.offlineHint")}</span>
      </p>
    </div>
  );
}
