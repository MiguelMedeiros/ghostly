import { useEffect, useId, useRef, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { AppPreview, AppStorePreview, InstalledAppView } from "@ghostly/browser/engine/apps";
import { useBackdropDismiss, useDialogFocus } from "../../hooks/useDismiss";
import { useFocusBack } from "../../hooks/useFocusBack";
import { useI18n } from "../../contexts/I18nContext";
import { Button, Notice, input } from "../wallet/ui";
import { AppInstallDialog } from "./AppInstallDialog";
import { Fingerprint } from "./AppIcon";
import { appErrorCode, appErrorView, appStoreErrorView, type AppErrorView } from "../../lib/apps/errors";
import { date } from "../../lib/identities";

/*
 * Add, on the Apps page (WISP 1200 § Paste a URL): a link to an app or a store. A GitHub repository or a file on it, a
 * raw file or a jsDelivr file at a commit; any other host is refused before a request. A link to `ghostly-store.json` (or a `.json`)
 * is read as a store; anything else as an app first, then as a store when it holds no app. Nothing is installed or
 * added before the person confirms on the next screen.
 */

/**
 * The start of a link written without its scheme, as a repository is usually said (`github.com/owner/repo`), or with
 * `http://`: a host the engine reads, and nothing else. It is read as its `https://` link, so nothing is asked over http.
 */
const LOOSE_SCHEME = /^(?:http:\/\/)?(?=(?:(?:www\.)?github\.com|raw\.githubusercontent\.com|cdn\.jsdelivr\.net)(?:[/?#]|$))/i;

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

export function AddAppDialog({ onClose, onStoreAdded, onInstalled }: { onClose: () => void; onStoreAdded: () => void; onInstalled?: (app: InstalledAppView) => void }) {
  const { t } = useI18n();
  const titleId = useId();
  const fieldId = useId();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const focusBack = useFocusBack(busy);
  const [error, setError] = useState<AppErrorView | null>(null);
  const [app, setApp] = useState<{ url: string; preview: AppPreview } | null>(null);
  const [store, setStore] = useState<AppStorePreview | null>(null);
  // While Add store runs, Add stays, as the install screen's: closed, the store was added all the same. A Check may be
  // left: it adds nothing.
  const adding = busy && !!store;
  const close = () => { if (!adding) onClose(); };
  const backdrop = useBackdropDismiss(close);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, close);
  // Which check is the field's: a link edited while Check runs drops the answer for the link it no longer holds.
  const asked = useRef(0);
  // The store's question takes the place of Check: the focus Check had would fall to the page, so it goes to the
  // question's Cancel (the safe choice). Enter in the field keeps the focus there.
  const storeCancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (store && !busy && (!active || active === document.body)) storeCancel.current?.focus({ preventScroll: true });
  }, [store, busy]);

  const check = async () => {
    const typed = url.trim();
    if (!typed || adding) return;
    // The engine takes nothing but `https:` (`appPasteUrl`): any other text goes to it as typed, and it refuses it in the dialog's words.
    const link = typed.replace(LOOSE_SCHEME, "https://");
    const mine = ++asked.current;
    const current = () => mine === asked.current;
    focusBack();
    setBusy(true); setError(null); setStore(null);
    try {
      if (!/\.json(?:[?#].*)?$/i.test(link)) {
        try {
          const preview = await engine.call("appPreview", { url: link });
          if (current()) setApp({ url: link, preview });
          return;
        } catch (e) {
          if (!current()) return;
          // No app there (a 404, or not a bundle): it may be a store. A link to a host off the list stops here.
          if (/\.ghostlyapp(?:[?#].*)?$/i.test(link) || ["host", "github-link", "private-link"].includes(appErrorCode(e) ?? "")) { setError(appErrorView(e, t)); return; }
        }
      }
      // Read as a store from here: one refused is a link that holds no valid store, not an app refused.
      const found = await engine.call("appStorePreview", { url: link });
      if (current()) setStore(found);
      // The preview marked the held store (two lists under one number): the Apps page reads its stores again to show it.
      if (found.held?.equivocation) onStoreAdded();
    } catch (e) { if (current()) setError(appStoreErrorView(e, t)); } finally { if (current()) setBusy(false); }
  };

  const edit = (value: string) => {
    asked.current++;
    setUrl(value); setStore(null); setError(null); setBusy(false);
  };

  const addStore = async () => {
    if (!store) return;
    focusBack();
    setBusy(true); setError(null);
    try { await engine.call("appStoreAdd", { url: store.url, key: store.key }); onStoreAdded(); onClose(); }
    catch (e) { setError(appStoreErrorView(e, t)); } finally { setBusy(false); }
  };

  // A store the person has already (by its key): Add takes only a newer index of it, so only that is offered. Another
  // index under the held sequence is not the one held: the store signed two lists (the engine marked it on the store).
  // A store the person removed takes back no list older than the last one taken from it: Add would refuse this one.
  const held = store?.held;
  const heldLine = !store ? null
    : store.refused ? t("apps.add.storeRemovedOlder")
    : !held ? null
    : held.sequence === undefined || store.sequence > held.sequence ? t("apps.add.storeNewer")
    : store.sequence < held.sequence ? t("apps.add.storeOlder")
    : held.equivocation ? t("apps.add.storeEquivocation") : t("apps.add.storeHeld");
  const offered = !!store && !store.refused && (!held || held.sequence === undefined || store.sequence > held.sequence);

  if (app) return <AppInstallDialog source={{ url: app.url }} fetched={app.preview} onClose={onClose} onInstalled={onInstalled} />;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 sm:p-4 animate-fade-in" {...backdrop}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="apps-add-dialog"
        className="sheet sheet-padded focus:outline-none w-full sm:max-w-md bg-panel-header border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl p-5 space-y-4 max-h-[90dvh] overflow-y-auto">
        <h2 id={titleId} className="text-lg font-medium text-text-primary">{t("apps.add.title")}</h2>
        {/* noValidate: a link the field's type refuses is answered below in the app's words, not by the browser's own bubble. */}
        <form className="space-y-2" noValidate onSubmit={(e) => { e.preventDefault(); void check(); }}>
          <label htmlFor={fieldId} className="text-sm text-text-primary">{t("apps.add.label")}</label>
          {/* Fixed while Add store runs: an edit (or Enter, which checks again) dropped the store's question and its busy
              state, and Cancel then closed Add while the store was added all the same. */}
          <input id={fieldId} data-testid="apps-add-url" autoFocus className={input} type="url" inputMode="url" autoComplete="off" spellCheck={false} dir="ltr"
            readOnly={adding} placeholder="https://github.com/owner/repo" value={url} onChange={(e) => edit(e.target.value)} />
          <Notice>{t("apps.add.hint")}</Notice>
          {error && <Notice tone="error" testId="apps-add-error" details={error.info}>{error.text}</Notice>}
          {!store && (
            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <Button onClick={onClose}>{t("common.cancel")}</Button>
              <Button type="submit" variant="primary" data-testid="apps-add-check" disabled={!url.trim()} loading={busy}>{busy ? t("apps.add.checking") : t("apps.add.check")}</Button>
            </div>
          )}
        </form>
        {store && (
          <div className="space-y-3" data-testid="apps-add-store">
            <div className="bg-surface rounded-xl px-4 py-3 space-y-1">
              <p dir="auto" className="text-sm text-text-primary [overflow-wrap:anywhere]">{store.name}</p>
              <p className="flex flex-wrap items-center gap-x-2 text-xs text-text-muted">
                <span>{store.kind === "indexed" ? t("apps.store.indexed") : t("apps.store.curated")}</span>
                <span>{t("apps.store.count", { count: store.apps })}</span>
                <Fingerprint value={store.fingerprint} />
              </p>
              {store.description && <p dir="auto" className="text-xs text-text-secondary whitespace-pre-line [overflow-wrap:anywhere]">{store.description}</p>}
              {store.expired && <p className="text-xs text-test-money-ink">{t("apps.store.stale", { date: date(store.expires, t.language) })}</p>}
            </div>
            {heldLine && <Notice testId="apps-add-store-held" tone={held?.equivocation ? "warning" : undefined}>{heldLine}</Notice>}
            {/* A store held is still read from its own link: this one is not where it is read from. */}
            {offered && !held && <Notice>{t("apps.add.storeReads", { host: hostOf(store.url) })}</Notice>}
            {/* Wraps rather than push Cancel off the screen (a phone at a large text size), as the install screen's. */}
            <div className="flex flex-wrap justify-end gap-2">
              <Button ref={storeCancel} disabled={adding} onClick={onClose}>{offered ? t("common.cancel") : t("common.close")}</Button>
              {offered && <Button variant="primary" data-testid="apps-add-store-confirm" loading={busy} onClick={() => void addStore()}>{held ? t("apps.add.updateStore") : t("apps.add.addStore")}</Button>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
