import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { engine } from "@ghostly/browser/platform/engine";
import type { AppStoreSummary, BuiltInAppOffer, InstalledAppView } from "@ghostly/browser/engine/apps";
import type { AppListing } from "@ghostly/core";
import { Block, Page, PageAction, Section } from "../components/layout";
import { Button, Notice } from "../components/wallet/ui";
import { Toast } from "../components/ui/Toast";
import { useToast } from "../hooks/useToast";
import { useFocusBack } from "../hooks/useFocusBack";
import { useI18n, type Translate } from "../contexts/I18nContext";
import { draftDirection } from "../lib/documentLanguage";
import { AppIcon, Fingerprint } from "../components/apps/AppIcon";
import { AppInstallDialog, InstalledAppDialog } from "../components/apps/AppInstallDialog";
import { AddAppDialog } from "../components/apps/AddAppDialog";
import { AppChatPicker } from "../components/apps/AppChatPicker";
import { useAppsState } from "../lib/apps/flag";
import { refreshInstalledApps, useBuiltInApps, useInstalledApps, useInstalledAppsFailure } from "../lib/apps/installed";
import { openApp, type OpenAppOptions } from "../lib/apps/open";
import { appErrorText, appErrorView } from "../lib/apps/errors";
import { date } from "../lib/identities";
import { listText } from "../lib/listText";

/*
 * Apps (WISP 1200 § Discovery, § Stores, § Updates), a page beside the chat list as Wallets and Identities are: the
 * mini-apps installed in this profile, the stores the person added and what each lists, and Add for a pasted app or
 * store link. Opening it is when the update check runs (the engine asks nothing while no app is installed); a store
 * is read when the person adds it or refreshes it. Shown only where Apps is available (`useAppsAvailable`).
 */

/** What a line under an installed app says: what needs the person first, else its tagline. */
function appHint(app: InstalledAppView, t: Translate): { lead?: string; text: string; tone: "muted" | "warning" | "danger" } {
  if (app.run.status === "revoked" || app.run.status === "removed") return { text: t("apps.app.stopped"), tone: "danger" };
  if (app.run.status === "needs-files") return { text: t("apps.app.needsFiles"), tone: "warning" };
  if (app.pending) return { text: t("apps.app.updateAsks"), tone: "warning" };
  // The version this client's own list pins is no stranger's (WISP 1200 § Built-in apps).
  // What the row is there to say comes first: on a phone the one line is cut at its end, and a tagline is long.
  if (app.unknownPublisher && !app.builtIn) return { lead: t("apps.install.unknownPublisher"), text: app.tagline, tone: "muted" };
  return { text: app.tagline, tone: "muted" };
}

/**
 * A row's one line under its title: Ghostly's own words (`lead`), then the app's tagline. Each reads in its own direction
 * and only the tagline is cut: in Arabic an English tagline in the same run took "Ghostly" and its start off the line.
 */
function HintLine({ lead, text, testId, className }: { lead?: string; text: string; testId: string; className: string }) {
  if (!lead) return <span dir="auto" data-testid={testId} className={`text-match-parent block text-xs truncate ${className}`}>{text}</span>;
  return (
    <span data-testid={testId} className={`flex min-w-0 text-xs ${className}`}>
      <span className="shrink-0 whitespace-pre">{`${lead} · `}</span>
      <span dir="auto" className="min-w-0 truncate">{text}</span>
    </span>
  );
}

function InstalledRow({ app, onDetails, onOpen }: { app: InstalledAppView; onDetails: () => void; onOpen: () => void }) {
  const { t } = useI18n();
  const hint = appHint(app, t);
  const color = { muted: "text-text-muted", warning: "text-test-money-ink", danger: "text-danger-ink" }[hint.tone];
  // Named with all it shows, in its order, then "details": "Chess 1.2.0 Stopped: details". A voice saying what is on
  // screen finds it (Label in Name), and a screen reader hears the line under the title (Stopped, an update that asks).
  const shown = [app.title, app.version, hint.lead && `${hint.lead} ·`, hint.text].filter(Boolean).join(" ");
  return (
    // Open goes under the name when both don't fit (a large text size on a phone), as in a built-in app's row.
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3" data-testid="installed-app" data-ref={app.ref}>
      <button type="button" onClick={onDetails} className="flex items-center gap-3 min-w-0 flex-[1_1_12rem] text-start cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        aria-label={t("apps.page.details", { title: shown })}>
        <AppIcon installed={app} />
        <span className="min-w-0">
          {/* A long title is cut alone: the version stays whole after it. The row goes the page's way, from the icon;
              only the title reads in its own direction. */}
          <span className="flex items-baseline gap-1 text-sm text-text-primary">
            <span dir="auto" className="truncate min-w-0">{app.title}</span>{" "}
            <span className="shrink-0 whitespace-nowrap text-text-muted text-xs">{app.version}</span>
          </span>
          {/* A space between the lines in the text, as in the name: the version's last digit and the line's first word apart. */}
          {" "}
          <HintLine testId="installed-app-hint" className={color} lead={hint.lead} text={hint.text} />
        </span>
      </button>
      {app.run.status === "ok" && <Button data-testid="installed-app-open" className="ms-auto" aria-label={t("apps.builtIn.openNamed", { title: app.title })} onClick={onOpen}>{t("apps.page.open")}</Button>}
    </div>
  );
}

/**
 * An app that comes with Ghostly and was never opened here (WISP 1200 § Built-in apps): nothing of it is installed yet.
 * Open is the install screen with what it asks; Remove takes it off the list for good (it stays in the store).
 */
function BuiltInRow({ app, busy, onOpen, onRemove }: { app: BuiltInAppOffer; busy: boolean; onOpen: () => void; onRemove: () => void }) {
  const { t } = useI18n();
  // Remove asks first, as a store's Remove does: it is the one removal that cannot be undone here (the copy the build
  // carries is not offered again). The question takes the place of the buttons, the focus goes to its Cancel, and
  // Cancel or Escape gives it back to Remove.
  const [asking, setAsking] = useState(false);
  const questionId = useId();
  const keep = useRef<HTMLButtonElement>(null), remove = useRef<HTMLButtonElement>(null), asked = useRef(false);
  useEffect(() => {
    if (!asking && !asked.current) return;
    asked.current = true;
    (asking ? keep : remove).current?.focus({ preventScroll: true });
  }, [asking]);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3" data-testid="built-in-app" data-ref={app.ref}>
      <div className="flex items-center gap-3 min-w-0 flex-[1_1_12rem]">
        <AppIcon />
        <span className="min-w-0">
          <span dir="auto" className="text-match-parent block text-sm text-text-primary truncate">{app.title}</span>
          <HintLine testId="built-in-app-hint" className="text-text-muted" lead={t("apps.builtIn.hint")} text={app.tagline} />
        </span>
      </div>
      {!asking && (
        <div className="flex items-center gap-2 ms-auto">
          <Button ref={remove} data-testid="built-in-app-remove" disabled={busy} aria-label={t("apps.builtIn.removeNamed", { title: app.title })} onClick={() => setAsking(true)}>{t("apps.builtIn.remove")}</Button>
          <Button variant="primary" data-testid="built-in-app-open" disabled={busy} aria-label={t("apps.builtIn.openNamed", { title: app.title })} onClick={onOpen}>{t("apps.page.open")}</Button>
        </div>
      )}
      {asking && (
        <div role="group" aria-labelledby={questionId} data-testid="built-in-app-remove-question" className="basis-full space-y-2"
          onKeyDown={(e) => { if (e.key === "Escape" && !busy) { e.stopPropagation(); setAsking(false); } }}>
          <p id={questionId} dir="auto" className="text-sm text-text-primary [overflow-wrap:anywhere]">{t("apps.builtIn.removeTitle", { title: app.title })}</p>
          <p className="text-xs text-text-secondary">{t("apps.builtIn.removeText")}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button ref={keep} disabled={busy} onClick={() => setAsking(false)}>{t("common.cancel")}</Button>
            <Button variant="danger" data-testid="built-in-app-remove-confirm" loading={busy} onClick={onRemove}>{t("apps.builtIn.remove")}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** How many listings a store's block shows at a time: a page a phone draws in a frame or two. */
const LISTING_PAGE = 50;

/** A store that lists this many apps or fewer shows them without being asked, beside other stores too. */
const LISTING_FEW = 6;

function StoreBlock({ store, alone, installed, onInstall, onChanged, onRemoved, onError }: {
  store: AppStoreSummary;
  /** The only store of the page. */
  alone: boolean;
  installed: readonly InstalledAppView[];
  onInstall: (listing: AppListing) => void;
  onChanged: () => void;
  /** Removed: its block, and the Remove that had the focus, are about to go. */
  onRemoved: () => void;
  onError: (e: unknown) => void;
}) {
  const { t } = useI18n();
  // Its apps show from the start when it is the only store or lists a few: nothing told a person on a phone that the
  // name opens them. Once the person closed or opened it, that stays.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? (store.apps.length > 0 && (alone || store.apps.length <= LISTING_FEW));
  const [busy, setBusy] = useState(false);
  // Which button started the work in progress: that one shows it is going (Refresh, Remove).
  const [pending, setPending] = useState<"refresh" | "remove" | null>(null);
  // Remove asks first, as Uninstall does: the question takes the place of the buttons, the focus goes to its Cancel
  // (Enter again does not remove), and Cancel gives it back to Remove, never to the page.
  const [asking, setAsking] = useState(false);
  const questionId = useId();
  const keep = useRef<HTMLButtonElement>(null), remove = useRef<HTMLButtonElement>(null), asked = useRef(false);
  useEffect(() => {
    if (!asking && !asked.current) return;
    asked.current = true;
    (asking ? keep : remove).current?.focus({ preventScroll: true });
  }, [asking]);
  const focusBack = useFocusBack(busy);
  const work = async (call: () => Promise<unknown>, done?: () => void, which: "refresh" | "remove" | null = null) => {
    focusBack();
    setBusy(true); setPending(which);
    try { await call(); done?.(); onChanged(); } catch (e) { onError(e); } finally { setBusy(false); setPending(null); }
  };
  // A store may list up to 4096 apps: one page of them at a time, and a search over them all.
  const [limit, setLimit] = useState(LISTING_PAGE);
  const [filter, setFilter] = useState("");
  // The search box shows only past one page: a store read again with fewer listings takes the search away with it.
  const searchable = store.apps.length > LISTING_PAGE;
  if (!searchable && filter) setFilter("");
  // Show more goes under the listings it adds, and away after the last ones: the focus goes to the first listing it
  // added (its Install, or the row when it has none), so Tab goes on from there and not from the top of the page.
  const [added, setAdded] = useState<number | null>(null);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (added === null) return;
    const row = list.current?.querySelectorAll<HTMLElement>("[data-testid=app-listing]")[added];
    (row?.querySelector<HTMLElement>("button") ?? row)?.focus({ preventScroll: true });
  }, [added]);
  const have = useMemo(() => new Map(installed.map((a) => [a.ref, a])), [installed]);
  const removals = useMemo(() => new Map(store.removed.map((r) => [`${r.ref} ${r.digest}`, r])), [store.removed]);
  const matching = useMemo(() => {
    const words = filter.trim().toLocaleLowerCase();
    return words ? store.apps.filter((l) => `${l.title}\n${l.tagline}`.toLocaleLowerCase().includes(words)) : store.apps;
  }, [store.apps, filter]);
  // The installed apps it vouches for: removed, it no longer brings their updates or takedowns.
  const vouched = useMemo(() => store.apps.flatMap((l) => have.get(l.ref)?.title ?? []), [store.apps, have]);
  const read = store.fetchedAt !== undefined || store.apps.length > 0;
  // What its block shows as its name: its link until it is read.
  const storeName = store.name ?? store.url;
  const kind = store.kind === "indexed" ? t("apps.store.indexed") : store.kind === "curated" ? t("apps.store.curated") : null;
  const toggle = () => {
    setChosen(!open);
    setLimit(LISTING_PAGE);
    setAdded(null);
    setFilter("");
  };
  return (
    <div data-testid="app-store" data-key={store.key}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <button type="button" aria-expanded={open} onClick={toggle} disabled={!read}
          className="flex-[1_1_12rem] min-w-0 text-start cursor-pointer disabled:cursor-default rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <span className="flex items-center gap-1.5">
            <span dir="auto" className="min-w-0 text-sm text-text-primary truncate">{storeName}</span>
            {read && (
              <svg aria-hidden="true" data-testid="app-store-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                className={`shrink-0 text-text-muted transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}><path d="m6 9 6 6 6-6" /></svg>
            )}
          </span>
          <span className="flex flex-wrap items-center gap-x-2 text-xs text-text-muted">
            {kind && <span>{kind}</span>}
            {read && <span>{t("apps.store.count", { count: store.apps.length })}</span>}
            <Fingerprint value={store.fingerprint} />
          </span>
          {!read && <span className="block text-xs text-text-muted">{t("apps.store.notRead")}</span>}
          {store.expired && store.fetchedAt !== undefined && <span data-testid="app-store-stale" className="block text-xs text-test-money-ink">{t("apps.store.stale", { date: date(store.expires ?? 0, t.language) })}</span>}
          {store.problem && <span data-testid="app-store-problem" className="block text-xs text-danger">{t("apps.store.problem")}</span>}
        </button>
        {!asking && (
          <div className="flex flex-wrap items-center gap-2 ms-auto">
            {/* A store read again or removed can stop an installed app (a removal) or change who lists it: both lists again.
                Each named with its store: every page has two stores once one is added, and two bare Removes. */}
            <Button data-testid="app-store-refresh" disabled={busy} loading={pending === "refresh"} aria-label={t(read ? "apps.store.refreshNamed" : "apps.store.readNamed", { name: storeName })}
              onClick={() => void work(() => engine.call("appStoreRefresh", { key: store.key }), undefined, "refresh")}>{read ? t("apps.store.refresh") : t("apps.store.read")}</Button>
            <Button ref={remove} variant="danger" data-testid="app-store-remove" disabled={busy} aria-label={t("apps.store.removeNamed", { name: storeName })} onClick={() => setAsking(true)}>{t("apps.store.remove")}</Button>
          </div>
        )}
        {asking && (
          <div role="group" aria-labelledby={questionId} data-testid="app-store-remove-question" className="basis-full space-y-2"
            onKeyDown={(e) => { if (e.key === "Escape" && !busy) { e.stopPropagation(); setAsking(false); } }}>
            <p id={questionId} dir="auto" className="text-sm text-text-primary [overflow-wrap:anywhere]">{t("apps.store.removeTitle", { name: storeName })}</p>
            <p className="text-xs text-text-secondary">
              {vouched.length ? t(vouched.length === 1 ? "apps.store.removeAppsOne" : "apps.store.removeApps", { titles: listText(vouched, t) }) : t("apps.store.removeNone")}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button ref={keep} disabled={busy} onClick={() => setAsking(false)}>{t("common.cancel")}</Button>
              <Button variant="danger" data-testid="app-store-remove-confirm" disabled={busy} loading={pending === "remove"}
                onClick={() => void work(() => engine.call("appStoreRemove", { key: store.key }), onRemoved, "remove")}>{t("apps.store.remove")}</Button>
            </div>
          </div>
        )}
      </div>
      {open && searchable && (
        <div className="border-t border-border px-4 py-2">
          <input type="search" data-testid="app-store-filter" value={filter} dir={draftDirection(filter)} onChange={(e) => { setFilter(e.target.value); setLimit(LISTING_PAGE); setAdded(null); }}
            placeholder={t("apps.store.filter")} aria-label={t("apps.store.filter")}
            className="w-full rounded-lg border-none bg-search-bg px-2.5 py-1.5 text-sm text-text-primary placeholder-text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
        </div>
      )}
      {open && (
        <ul ref={list} className="border-t border-border divide-y divide-border bg-surface-alt/40" data-testid="app-store-listing">
          {store.apps.length === 0 && <li className="px-4 py-3 text-xs text-text-muted">{t("apps.store.empty")}</li>}
          {store.apps.length > 0 && matching.length === 0 && <li className="px-4 py-3 text-xs text-text-muted">{t("apps.store.noMatch")}</li>}
          {matching.slice(0, limit).map((listing, i) => {
            const app = have.get(listing.ref);
            const removed = removals.get(`${listing.ref} ${listing.digest}`);
            return (
              <li key={listing.ref} tabIndex={i === added ? -1 : undefined} data-testid="app-listing" data-ref={listing.ref}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent">
                {/* Install (or Installed) goes under the name when both don't fit, rather than leaving it a letter. */}
                <span className="flex items-center gap-3 min-w-0 flex-[1_1_12rem]">
                  <AppIcon size={32} installed={app} />
                  <span className="min-w-0 flex-1">
                    <span dir="auto" className="text-match-parent block text-sm text-text-primary truncate">{listing.title}</span>
                    <span dir="auto" className="text-match-parent block text-xs text-text-muted truncate">{removed ? t("apps.install.removed", { store: store.name ?? "", reason: removed.reason }) : listing.tagline}</span>
                  </span>
                </span>
                {app ? <span className="ms-auto text-xs text-text-muted">{t("apps.store.installed")}</span>
                  : !removed && <Button data-testid="app-listing-install" className="ms-auto" aria-label={t("apps.install.installNamed", { title: listing.title })} onClick={() => onInstall(listing)}>{t("apps.install.install")}</Button>}
              </li>
            );
          })}
          {matching.length > limit && (
            <li>
              <button type="button" data-testid="app-store-more" onClick={() => { setAdded(limit); setLimit(limit + LISTING_PAGE); }}
                className="w-full cursor-pointer px-4 py-2.5 text-xs font-medium text-accent hover:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent">
                {t("apps.store.showMore", { count: matching.length - limit })}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** A list that could not be read (storage: a private window, a full disk): said so, with Try again, never "none yet". */
function ReadFailed({ error, testId, onRetry }: { error: unknown; testId: string; onRetry: () => void }) {
  const { t } = useI18n();
  const view = appErrorView(error, t);
  return (
    <Block testId={testId}>
      <Notice tone="error" testId={`${testId}-line`} details={view.info}>{view.text}</Notice>
      <Button onClick={onRetry}>{t("apps.page.tryAgain")}</Button>
    </Block>
  );
}

export function Apps() {
  const state = useAppsState();
  const available = state === "on";
  const { t } = useI18n();
  const installed = useInstalledApps(available);
  const builtIns = useBuiltInApps(available);
  const installedFailure = useInstalledAppsFailure(available);
  const [stores, setStores] = useState<AppStoreSummary[] | null>(null);
  // Why the last read of the stores failed: the stores are still there, unread, not gone.
  const [storesFailure, setStoresFailure] = useState<unknown>(null);
  const [adding, setAdding] = useState(false);
  const [details, setDetails] = useState<string | null>(null);
  const [installing, setInstalling] = useState<{ store: string; listing: AppListing } | null>(null);
  // A built-in app opened for the first time: its install screen, then it opens.
  const [first, setFirst] = useState<BuiltInAppOffer | null>(null);
  const [removing, setRemoving] = useState(false);
  const [picking, setPicking] = useState<{ app: InstalledAppView; options?: OpenAppOptions } | null>(null);
  // Installed from a listing or a pasted link: what had the focus is gone, so it goes to the app's row (its Open), not the page.
  // A built-in app opened for the first time asks which chat next: the focus stays in that question until it is closed.
  const [justInstalled, setJustInstalled] = useState<string | null>(null);
  useEffect(() => {
    if (!justInstalled || installing || first || picking) return;
    const row = document.querySelector(`[data-testid=installed-app][data-ref="${CSS.escape(justInstalled)}"]`);
    const target = row?.querySelector<HTMLElement>("[data-testid=installed-app-open]") ?? row?.querySelector<HTMLElement>("button");
    if (!target) return;
    target.focus({ preventScroll: true });
    setJustInstalled(null);
  }, [justInstalled, installing, first, picking, installed]);
  // An app uninstalled or a store removed: the control that had the focus went with its row, so the focus goes to Add
  // rather than being lost on the page. Only once the row is gone and its screen closed, and only if nothing has it.
  const [gone, setGone] = useState<{ app: string } | { store: string } | null>(null);
  useEffect(() => {
    if (!gone || details) return;
    if ("app" in gone ? installed?.some((a) => a.ref === gone.app) || builtIns.some((a) => a.ref === gone.app) : stores?.some((s) => s.key === gone.store)) return;
    setGone(null);
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    document.querySelector<HTMLElement>("[data-testid=apps-add]")?.focus({ preventScroll: true });
  }, [gone, details, installed, builtIns, stores]);
  const notice = useToast();
  const { show } = notice;
  const fail = useCallback((e: unknown) => show(appErrorText(e, t)), [show, t]);

  const reloadStores = useCallback(() => engine.call("appStoreList").then(
    (list) => { setStores(list); setStoresFailure(null); },
    (e: unknown) => { setStores((s) => s ?? []); setStoresFailure(e); }), []);
  useEffect(() => {
    if (!available) return;
    void reloadStores();
    // The update check, as the page opens (WISP 1200 § Updates): nothing goes out while no app is installed. The engine
    // tells every page that it ran (`apps-checked`), and the installed apps are read again for that, not here a second time.
    void engine.call("appCheckUpdates").then(() => reloadStores(), () => {});
  }, [available, reloadStores]);

  if (state === "checking") return null;
  if (!available) return <Navigate to="/" replace />;
  // An app that runs in a chat asks which one; a full-screen app opens here, alone.
  const open = (app: InstalledAppView, options?: OpenAppOptions) => {
    if (app.view === "full") void openApp(app.ref, null, options).catch(fail);
    else setPicking({ app, ...(options && { options }) });
  };
  const shown = details ? installed?.find((a) => a.ref === details) : undefined;
  // Removed, never opened: nothing to export, and the store still has it. It is not offered again.
  const removeBuiltIn = async (app: BuiltInAppOffer) => {
    setRemoving(true);
    try { await engine.call("appUninstall", { ref: app.ref }); setGone({ app: app.ref }); await refreshInstalledApps(); } catch (e) { fail(e); } finally { setRemoving(false); }
  };
  return (
    <Page title={t("apps.title")} width="md" testId="apps-page" overlay={<Toast toast={notice.toast} onDismiss={notice.dismiss} place="page" />}
      trailing={<PageAction label={t("apps.page.add")} title={t("apps.page.addHint")} testId="apps-add" onClick={() => setAdding(true)} />}>
      <p className="text-sm text-text-secondary">{t("apps.page.intro")}</p>
      <Section title={t("apps.page.installed")} testId="apps-installed">
        {installedFailure != null && <ReadFailed error={installedFailure} testId="apps-installed-error" onRetry={() => void refreshInstalledApps()} />}
        {installed === null ? <Block><Notice>{t("apps.page.loading")}</Notice></Block>
          : installed.length === 0 && builtIns.length === 0 ? installedFailure == null && <Block testId="apps-none"><Notice>{t("apps.page.none")}</Notice></Block>
            : <>
              {installed.map((app) => <InstalledRow key={app.ref} app={app} onDetails={() => setDetails(app.ref)} onOpen={() => open(app)} />)}
              {builtIns.map((app) => <BuiltInRow key={app.ref} app={app} busy={removing} onOpen={() => setFirst(app)} onRemove={() => void removeBuiltIn(app)} />)}
            </>}
      </Section>
      <Section title={t("apps.page.stores")} testId="apps-stores">
        {storesFailure != null && <ReadFailed error={storesFailure} testId="apps-stores-error" onRetry={() => void reloadStores()} />}
        {stores === null ? <Block><Notice>{t("apps.page.loading")}</Notice></Block>
          : stores.length === 0 ? storesFailure == null && <Block testId="apps-no-stores"><Notice>{t("apps.page.noStores")}</Notice></Block>
            : stores.map((store) => <StoreBlock key={store.key} store={store} alone={stores.length === 1} installed={installed ?? []} onError={fail} onRemoved={() => setGone({ store: store.key })}
              onChanged={() => void Promise.all([reloadStores(), refreshInstalledApps()])} onInstall={(listing) => setInstalling({ store: store.key, listing })} />)}
      </Section>
      {adding && <AddAppDialog onClose={() => setAdding(false)} onStoreAdded={() => void reloadStores()} onInstalled={(app) => setJustInstalled(app.ref)} />}
      {shown && <InstalledAppDialog app={shown} onClose={() => setDetails(null)} onOpen={open} onUninstalled={() => setGone({ app: shown.ref })} />}
      {picking && <AppChatPicker app={picking.app} options={picking.options} onClose={() => setPicking(null)} />}
      {first && (
        <AppInstallDialog source={{ builtIn: first.ref }} title={first.title} openAfter onClose={() => setFirst(null)}
          onInstalled={(app) => { setJustInstalled(app.ref); open(app); }} />
      )}
      {installing && (
        <AppInstallDialog source={{ store: installing.store, ref: installing.listing.ref }} title={installing.listing.title} onClose={() => setInstalling(null)}
          onInstalled={(app) => setJustInstalled(app.ref)} />
      )}
    </Page>
  );
}
