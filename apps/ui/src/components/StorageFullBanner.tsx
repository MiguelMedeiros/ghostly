import { useSyncExternalStore } from "react";
import { useI18n } from "../contexts/I18nContext";
import { holdsUnsaved, onUnsavedChange } from "../lib/storage";

/**
 * Above the chat list while the page's storage is full (lib/storage `unsaved`): what came still shows, but this page
 * could not keep its copy, so after a reload it is back only once the engine has spoken. The next step: delete chats or
 * profiles not needed any more, which share that storage.
 */
export function StorageFullBanner() {
  const { t } = useI18n();
  const full = useSyncExternalStore(onUnsavedChange, holdsUnsaved);
  if (!full) return null;
  return (
    <div role="status" data-testid="storage-full-banner" className="shrink-0 border-b border-border bg-surface px-4 py-2 flex items-start gap-2.5">
      <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-yellow-500" />
      <p className="m-0 min-w-0 text-xs text-text-secondary">
        <span className="font-semibold text-text-primary">{t("pwa.storageFull")}</span>
        <span className="text-text-muted"> · {t("pwa.storageFullHint")}</span>
      </p>
    </div>
  );
}
