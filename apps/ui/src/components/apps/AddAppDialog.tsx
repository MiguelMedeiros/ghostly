import { useId, useRef, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { AppPreview, AppStorePreview } from "@ghostly/browser/engine/apps";
import { useBackdropDismiss, useDialogFocus } from "../../hooks/useDismiss";
import { useI18n } from "../../contexts/I18nContext";
import { Button, Notice, input } from "../wallet/ui";
import { AppInstallDialog } from "./AppInstallDialog";
import { Fingerprint } from "./AppIcon";
import { appErrorCode, appErrorText } from "../../lib/apps/errors";
import { date } from "../../lib/identities";

/*
 * Add, on the Apps page (WISP 1200 § Paste a URL): a link to an app or a store. A GitHub repository, a raw file or a
 * jsDelivr file at a commit; any other host is refused before a request. A link to `ghostly-store.json` (or a `.json`)
 * is read as a store; anything else as an app first, then as a store when it holds no app. Nothing is installed or
 * added before the person confirms on the next screen.
 */

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

export function AddAppDialog({ onClose, onStoreAdded }: { onClose: () => void; onStoreAdded: () => void }) {
  const { t } = useI18n();
  const titleId = useId();
  const fieldId = useId();
  const backdrop = useBackdropDismiss(onClose);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, onClose);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [app, setApp] = useState<{ url: string; preview: AppPreview } | null>(null);
  const [store, setStore] = useState<AppStorePreview | null>(null);

  const check = async () => {
    const link = url.trim();
    if (!link) return;
    setBusy(true); setError(null); setStore(null);
    try {
      if (!/\.json(?:[?#].*)?$/i.test(link)) {
        try {
          setApp({ url: link, preview: await engine.call("appPreview", { url: link }) });
          return;
        } catch (e) {
          // No app there (a 404, or not a bundle): it may be a store. A link to a host off the list stops here.
          if (/\.ghostlyapp(?:[?#].*)?$/i.test(link) || appErrorCode(e) === "host") throw e;
        }
      }
      setStore(await engine.call("appStorePreview", { url: link }));
    } catch (e) { setError(appErrorText(e, t)); } finally { setBusy(false); }
  };

  const addStore = async () => {
    if (!store) return;
    setBusy(true); setError(null);
    try { await engine.call("appStoreAdd", { url: store.url, key: store.key }); onStoreAdded(); onClose(); }
    catch (e) { setError(appErrorText(e, t)); } finally { setBusy(false); }
  };

  if (app) return <AppInstallDialog source={{ url: app.url }} fetched={app.preview} onClose={onClose} />;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 sm:p-4 animate-fade-in" {...backdrop}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="apps-add-dialog"
        className="focus:outline-none w-full sm:max-w-md bg-panel-header border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl p-5 space-y-4 max-h-[90dvh] overflow-y-auto pb-safe">
        <h2 id={titleId} className="text-lg font-medium text-text-primary">{t("apps.add.title")}</h2>
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void check(); }}>
          <label htmlFor={fieldId} className="text-sm text-text-primary">{t("apps.add.label")}</label>
          <input id={fieldId} data-testid="apps-add-url" className={input} type="url" inputMode="url" autoComplete="off" spellCheck={false} dir="ltr"
            placeholder="https://github.com/owner/repo" value={url} onChange={(e) => { setUrl(e.target.value); setStore(null); setError(null); }} />
          <Notice>{t("apps.add.hint")}</Notice>
          {error && <Notice tone="error" testId="apps-add-error">{error}</Notice>}
          {!store && (
            <div className="flex justify-end gap-2 pt-2">
              <Button onClick={onClose}>{t("common.cancel")}</Button>
              <Button type="submit" variant="primary" data-testid="apps-add-check" disabled={busy || !url.trim()}>{busy ? t("apps.add.checking") : t("apps.add.check")}</Button>
            </div>
          )}
        </form>
        {store && (
          <div className="space-y-3" data-testid="apps-add-store">
            <div className="bg-surface rounded-xl px-4 py-3 space-y-1">
              <p className="text-sm text-text-primary">{store.name}</p>
              <p className="flex flex-wrap items-center gap-x-2 text-xs text-text-muted">
                <span>{store.kind === "indexed" ? t("apps.store.indexed") : t("apps.store.curated")}</span>
                <span>{t(store.apps === 1 ? "apps.store.countOne" : "apps.store.count", { count: store.apps })}</span>
                <Fingerprint value={store.fingerprint} />
              </p>
              {store.description && <p className="text-xs text-text-secondary whitespace-pre-line">{store.description}</p>}
              {store.expired && <p className="text-xs text-test-money-ink">{t("apps.store.stale", { date: date(store.expires) })}</p>}
            </div>
            <Notice>{t("apps.add.storeReads", { host: hostOf(store.url) })}</Notice>
            <div className="flex justify-end gap-2">
              <Button onClick={onClose}>{t("common.cancel")}</Button>
              <Button variant="primary" data-testid="apps-add-store-confirm" disabled={busy} onClick={() => void addStore()}>{t("apps.add.addStore")}</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
