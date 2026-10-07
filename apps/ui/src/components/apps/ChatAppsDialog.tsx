import { useRef, useState } from "react";
import type { InstalledAppView } from "@ghostly/browser/engine/apps";
import { useBackdropDismiss, useDialogFocus } from "../../hooks/useDismiss";
import { useI18n } from "../../contexts/I18nContext";
import { useAppNavigation } from "../../hooks/useAppNavigation";
import { Button } from "../wallet/ui";
import { AppIcon } from "./AppIcon";
import { sendAppCard, useInstalledApps } from "../../lib/apps/installed";
import { openApp } from "../../lib/apps/open";
import { appErrorText } from "../../lib/apps/errors";

/*
 * The composer's + → Apps in a 1:1 chat (WISP 1200 § In a chat): the installed apps, one to open with this contact.
 * Opening one sends the "opened" app card (WISP 405 § An app), made from the app as installed, so the contact sees
 * "Ana opened Chess" and can install the same app; then the app opens in this chat. Nothing is advertised before.
 */
export function ChatAppsDialog({ linkId, name, waiting, onClose }: { linkId: string; name: string; waiting?: string | null; onClose: () => void }) {
  const { t } = useI18n();
  const nav = useAppNavigation();
  const installed = useInstalledApps(true);
  const backdrop = useBackdropDismiss(onClose);
  const ref = useRef<HTMLDivElement>(null);
  // Once an app opened, its panel has the focus: closing this does not take it back.
  const opened = useRef(false);
  useDialogFocus(ref, onClose, () => !opened.current);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = async (app: InstalledAppView) => {
    setBusy(app.ref); setError(null);
    try {
      // Opened first: an app that cannot start here sends no card. Then the contact is told, with what to install.
      await openApp(app.ref, linkId);
      opened.current = true;
      const failed = await sendAppCard(linkId, app, true);
      if (failed) throw new Error(failed);
      onClose();
    } catch (e) { setError(appErrorText(e, t)); } finally { setBusy(null); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 sm:p-4 animate-fade-in" {...backdrop}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="chat-apps-title" data-testid="chat-apps"
        className="focus:outline-none w-full sm:max-w-md bg-panel-header border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl p-5 space-y-4 max-h-[85dvh] overflow-y-auto pb-safe">
        <div>
          <h2 id="chat-apps-title" className="text-lg font-medium text-text-primary">{t("apps.composer.title", { name })}</h2>
          {waiting && <p className="text-xs text-text-secondary mt-1" data-testid="chat-apps-waiting">{waiting}</p>}
        </div>
        <div className="bg-surface rounded-xl divide-y divide-border">
          {installed === null ? <p className="px-4 py-3 text-xs text-text-muted">{t("apps.page.loading")}</p>
            : installed.length === 0 ? <p className="px-4 py-3 text-xs text-text-muted" data-testid="chat-apps-none">{t("apps.composer.none")}</p>
              : installed.map((app) => (
                <div key={app.ref} className="flex items-center gap-3 px-4 py-3" data-testid="chat-app" data-ref={app.ref}>
                  <AppIcon size={36} installed={app} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-text-primary truncate">{app.title}</p>
                    <p className="text-xs text-text-muted truncate">{app.run.status === "ok" ? app.tagline : t("apps.app.stopped")}</p>
                  </div>
                  <Button variant="primary" data-testid="chat-app-open" disabled={app.run.status !== "ok" || busy !== null} onClick={() => void open(app)}>{t("apps.page.open")}</Button>
                </div>
              ))}
          <button type="button" data-testid="chat-apps-browse" onClick={() => { onClose(); nav.open("/apps"); }}
            className="w-full px-4 py-3 text-sm text-text-secondary hover:text-accent hover:bg-surface-alt text-start cursor-pointer rounded-b-xl">
            {t("apps.composer.browse")}
          </button>
        </div>
        {error && <p role="alert" className="text-xs text-danger" data-testid="chat-apps-error">{error}</p>}
        <div className="flex justify-end">
          <Button onClick={onClose}>{t("common.close")}</Button>
        </div>
      </div>
    </div>
  );
}
