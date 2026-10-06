import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { engine } from "@ghostly/browser/platform/engine";
import type { AppStoreSummary, InstalledAppView } from "@ghostly/browser/engine/apps";
import type { AppListing } from "@ghostly/core";
import { Block, Page, PageAction, Section } from "../components/layout";
import { Button, Notice } from "../components/wallet/ui";
import { Toast } from "../components/ui/Toast";
import { useToast } from "../hooks/useToast";
import { useI18n, type Translate } from "../contexts/I18nContext";
import { AppIcon, Fingerprint } from "../components/apps/AppIcon";
import { AppInstallDialog, InstalledAppDialog } from "../components/apps/AppInstallDialog";
import { AddAppDialog } from "../components/apps/AddAppDialog";
import { useAppsState } from "../lib/apps/flag";
import { refreshInstalledApps, useInstalledApps } from "../lib/apps/installed";
import { openApp } from "../lib/apps/open";
import { appErrorText } from "../lib/apps/errors";
import { date } from "../lib/identities";

/*
 * Apps (WISP 1200 § Discovery, § Stores, § Updates), a page beside the chat list as Wallets and Identities are: the
 * mini-apps installed in this profile, the stores the person added and what each lists, and Add for a pasted app or
 * store link. Opening it is when the update check runs (the engine asks nothing while no app is installed); a store
 * is read when the person adds it or refreshes it. Shown only where Apps is available (`useAppsAvailable`).
 */

/** What a line under an installed app says: what needs the person first, else its tagline. */
function appHint(app: InstalledAppView, t: Translate): { text: string; tone: "muted" | "warning" | "danger" } {
  if (app.run.status === "revoked" || app.run.status === "removed") return { text: t("apps.app.stopped"), tone: "danger" };
  if (app.run.status === "needs-files") return { text: t("apps.app.needsFiles"), tone: "warning" };
  if (app.pending) return { text: t("apps.app.updateAsks"), tone: "warning" };
  if (app.unknownPublisher) return { text: `${app.tagline} · ${t("apps.install.unknownPublisher")}`, tone: "muted" };
  return { text: app.tagline, tone: "muted" };
}

function InstalledRow({ app, onDetails, onOpen }: { app: InstalledAppView; onDetails: () => void; onOpen: () => void }) {
  const { t } = useI18n();
  const hint = appHint(app, t);
  const color = { muted: "text-text-muted", warning: "text-yellow-500", danger: "text-danger" }[hint.tone];
  return (
    <div className="flex items-center gap-3 px-4 py-3" data-testid="installed-app" data-ref={app.ref}>
      <button type="button" onClick={onDetails} className="flex items-center gap-3 min-w-0 flex-1 text-start cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label={t("apps.page.details", { title: app.title })}>
        <AppIcon installed={app} />
        <span className="min-w-0">
          <span className="block text-sm text-text-primary truncate">{app.title} <span className="text-text-muted text-xs">{app.version}</span></span>
          <span data-testid="installed-app-hint" className={`block text-xs truncate ${color}`}>{hint.text}</span>
        </span>
      </button>
      {app.run.status === "ok" && <Button data-testid="installed-app-open" onClick={onOpen}>{t("apps.page.open")}</Button>}
    </div>
  );
}

function StoreBlock({ store, installed, onInstall, onChanged, onError }: {
  store: AppStoreSummary;
  installed: readonly InstalledAppView[];
  onInstall: (listing: AppListing) => void;
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const work = async (call: () => Promise<unknown>) => {
    setBusy(true);
    try { await call(); onChanged(); } catch (e) { onError(e); } finally { setBusy(false); }
  };
  const read = store.fetchedAt !== undefined || store.apps.length > 0;
  const kind = store.kind === "indexed" ? t("apps.store.indexed") : store.kind === "curated" ? t("apps.store.curated") : null;
  return (
    <div data-testid="app-store" data-key={store.key}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} disabled={!read}
          className="flex-[1_1_12rem] min-w-0 text-start cursor-pointer disabled:cursor-default rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <span className="block text-sm text-text-primary truncate">{store.name ?? store.url}</span>
          <span className="flex flex-wrap items-center gap-x-2 text-xs text-text-muted">
            {kind && <span>{kind}</span>}
            {read && <span>{t(store.apps.length === 1 ? "apps.store.countOne" : "apps.store.count", { count: store.apps.length })}</span>}
            <Fingerprint value={store.fingerprint} />
          </span>
          {!read && <span className="block text-xs text-text-muted">{t("apps.store.notRead")}</span>}
          {store.expired && store.fetchedAt !== undefined && <span data-testid="app-store-stale" className="block text-xs text-yellow-500">{t("apps.store.stale", { date: date(store.expires ?? 0) })}</span>}
          {store.problem && <span data-testid="app-store-problem" className="block text-xs text-danger">{t("apps.store.problem")}</span>}
        </button>
        <div className="flex items-center gap-2">
          <Button data-testid="app-store-refresh" disabled={busy} onClick={() => void work(() => engine.call("appStoreRefresh", { key: store.key }))}>{read ? t("apps.store.refresh") : t("apps.store.read")}</Button>
          <Button variant="danger" data-testid="app-store-remove" disabled={busy} onClick={() => void work(() => engine.call("appStoreRemove", { key: store.key }))}>{t("apps.store.remove")}</Button>
        </div>
      </div>
      {open && (
        <ul className="border-t border-border divide-y divide-border bg-surface-alt/40" data-testid="app-store-listing">
          {store.apps.length === 0 && <li className="px-4 py-3 text-xs text-text-muted">{t("apps.store.empty")}</li>}
          {store.apps.map((listing) => {
            const have = installed.find((a) => a.ref === listing.ref);
            const removed = store.removed.find((r) => r.ref === listing.ref && r.digest === listing.digest);
            return (
              <li key={listing.ref} className="flex items-center gap-3 px-4 py-3" data-testid="app-listing" data-ref={listing.ref}>
                <AppIcon size={32} installed={have} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-text-primary truncate">{listing.title}</span>
                  <span className="block text-xs text-text-muted truncate">{removed ? t("apps.install.removed", { store: store.name ?? "", reason: removed.reason }) : listing.tagline}</span>
                </span>
                {have ? <span className="text-xs text-text-muted">{t("apps.store.installed")}</span>
                  : !removed && <Button data-testid="app-listing-install" onClick={() => onInstall(listing)}>{t("apps.install.install")}</Button>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function Apps() {
  const state = useAppsState();
  const available = state === "on";
  const { t } = useI18n();
  const installed = useInstalledApps(available);
  const [stores, setStores] = useState<AppStoreSummary[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [details, setDetails] = useState<string | null>(null);
  const [installing, setInstalling] = useState<{ store: string; listing: AppListing } | null>(null);
  const notice = useToast();
  const { show } = notice;
  const fail = useCallback((e: unknown) => show(appErrorText(e, t)), [show, t]);

  const reloadStores = useCallback(() => engine.call("appStoreList").then(setStores, () => setStores([])), []);
  useEffect(() => {
    if (!available) return;
    void reloadStores();
    // The update check, as the page opens (WISP 1200 § Updates): nothing goes out while no app is installed.
    void engine.call("appCheckUpdates").then(() => Promise.all([refreshInstalledApps(), reloadStores()]), () => {});
  }, [available, reloadStores]);

  if (state === "checking") return null;
  if (!available) return <Navigate to="/" replace />;
  const open = (app: InstalledAppView) => void openApp(app.ref, null).catch(fail);
  const shown = details ? installed?.find((a) => a.ref === details) : undefined;
  return (
    <Page title={t("apps.title")} width="md" testId="apps-page" overlay={<Toast toast={notice.toast} onDismiss={notice.dismiss} place="page" />}
      trailing={<PageAction label={t("apps.page.add")} title={t("apps.page.addHint")} testId="apps-add" onClick={() => setAdding(true)} />}>
      <p className="text-sm text-text-secondary">{t("apps.page.intro")}</p>
      <Section title={t("apps.page.installed")} testId="apps-installed">
        {installed === null ? <Block><Notice>{t("apps.page.loading")}</Notice></Block>
          : installed.length === 0 ? <Block testId="apps-none"><Notice>{t("apps.page.none")}</Notice></Block>
            : installed.map((app) => <InstalledRow key={app.ref} app={app} onDetails={() => setDetails(app.ref)} onOpen={() => open(app)} />)}
      </Section>
      <Section title={t("apps.page.stores")} testId="apps-stores">
        {stores === null ? <Block><Notice>{t("apps.page.loading")}</Notice></Block>
          : stores.length === 0 ? <Block testId="apps-no-stores"><Notice>{t("apps.page.noStores")}</Notice></Block>
            : stores.map((store) => <StoreBlock key={store.key} store={store} installed={installed ?? []} onError={fail}
              onChanged={() => void reloadStores()} onInstall={(listing) => setInstalling({ store: store.key, listing })} />)}
      </Section>
      {adding && <AddAppDialog onClose={() => setAdding(false)} onStoreAdded={() => void reloadStores()} />}
      {shown && <InstalledAppDialog app={shown} onClose={() => setDetails(null)} onOpen={open} />}
      {installing && (
        <AppInstallDialog source={{ store: installing.store, ref: installing.listing.ref }} title={installing.listing.title} onClose={() => setInstalling(null)} />
      )}
    </Page>
  );
}
