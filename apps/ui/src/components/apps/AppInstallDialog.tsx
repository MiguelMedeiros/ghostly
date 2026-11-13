import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { engine } from "@ghostly/browser/platform/engine";
import type { AppListedBy, AppPreview, AppRunStatus, AppSource, InstalledAppView } from "@ghostly/browser/engine/apps";
import { useBackdropDismiss, useDialogFocus } from "../../hooks/useDismiss";
import { useFocusBack } from "../../hooks/useFocusBack";
import { useI18n, type Translate, type TranslationKey } from "../../contexts/I18nContext";
import { Button } from "../wallet/ui";
import { InfoButton } from "../layout";
import { AppIcon, Fingerprint } from "./AppIcon";
import { appErrorCode, appErrorText, appErrorView, appUpdateErrorView, type AppErrorView } from "../../lib/apps/errors";
import { refreshInstalledApps } from "../../lib/apps/installed";
import { saveAppData } from "../../lib/apps/exportData";
import { webKitAppLeak } from "../../lib/apps/flag";
import { forgetLinkedFiles, type OpenAppOptions } from "../../lib/apps/open";

/*
 * The install screen (WISP 1200 § Permissions, § Apps sent in a chat, § Takedowns): what the checked bundle says,
 * before anything is stored. The publisher (its fingerprint, and "Unknown publisher" unless a curated store of the
 * person's lists it), the stores, who sent it, what it may do, and the line every install screen says about the
 * network. Nothing installs or runs before Install; a removed or revoked version cannot be installed; an update that
 * adds a permission shows only what is new. The same screen shows an installed app: its update, its state, Uninstall.
 */

/**
 * What each permission is called at install, and the longer story behind its ⓘ where there is one. By name, so a
 * permission this build does not know yet still shows (as its name) rather than being hidden.
 */
const PERMISSIONS: Record<string, { label: TranslationKey; info?: TranslationKey }> = {
  chat: { label: "apps.install.perm.chat" },
  files: { label: "apps.install.perm.files", info: "apps.install.perm.filesInfo" },
  internet: { label: "apps.install.perm.internet", info: "apps.install.perm.internetInfo" },
  name: { label: "apps.install.perm.name" },
};

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/** Where the app stands with the person's stores: "In <store>", "Found by <index>", "Not in any of your stores". */
function storeLines(listedBy: readonly AppListedBy[], t: Translate, builtIn?: BuiltIn): string[] {
  const curated = listedBy.filter((s) => s.kind === "curated");
  if (curated.length) return curated.map((s) => t("apps.install.inStore", { name: s.name }));
  const found = listedBy.map((s) => t("apps.install.foundBy", { name: s.name }));
  if (builtIn) return builtIn === "installed" ? [...found, t("apps.builtIn.hint")] : found;
  return [...found, t("apps.install.notListed")];
}

/**
 * The version this client's own list pins (WISP 1200 § Built-in apps): the client vouches for it, so it carries no
 * stranger's warning. `carried`: the install screen, which says "Comes with Ghostly" on its privacy line already.
 */
type BuiltIn = "carried" | "installed";

/** Why it cannot run, if it cannot: revoked by its publisher, removed by a store, its files gone. */
function runLine(run: AppRunStatus, t: Translate): ReactNode {
  if (run.status === "revoked") return t("apps.install.revoked");
  // A store's own words, one line each, in their own direction (an Arabic reason in an English app), as on the listing.
  if (run.status === "removed") return run.by.length > 0 && run.by.map((b) => <span key={b.store} dir="auto" className="text-match-parent block">{t("apps.install.removed", { store: b.name, reason: b.reason })}</span>);
  if (run.status === "needs-files") return t("apps.app.needsFiles");
  return null;
}

// A store's takedown reason (200 characters, which may hold no space: a link) and a store's or contact's name break
// anywhere: unbroken, a reason pushed the screen 933 px sideways on a phone, its start off the left side in Arabic.
function Line({ children, tone = "muted", testId }: { children: ReactNode; tone?: "muted" | "danger" | "warning"; testId?: string }) {
  const color = { muted: "text-text-secondary", danger: "text-danger-ink", warning: "text-test-money-ink" }[tone];
  return <p data-testid={testId} className={`text-xs whitespace-pre-line [overflow-wrap:anywhere] ${color}`}>{children}</p>;
}

/** The publisher and the stores, as a person checks them. */
function Publisher({ fingerprint, unknown: unlisted, listedBy, sentBy, builtIn }: { fingerprint: string; unknown: boolean; listedBy: readonly AppListedBy[]; sentBy?: string; builtIn?: BuiltIn }) {
  const { t } = useI18n();
  const unknown = unlisted && !builtIn;
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="bg-surface rounded-xl px-4 py-3 space-y-1" data-testid="app-publisher">
      <div className="flex items-center gap-2">
        <span className={`text-sm ${unknown ? "text-test-money-ink" : "text-text-primary"}`} data-testid="app-publisher-name">
          {unknown ? t("apps.install.unknownPublisher") : t("apps.install.publisher")}
        </span>
        {unknown && <InfoButton open={open} onToggle={() => setOpen(!open)} controls={id} />}
        <span className="ms-auto"><Fingerprint value={fingerprint} /></span>
      </div>
      {unknown && open && <p id={id} className="text-xs text-text-secondary">{t("apps.install.unknownPublisherInfo")}</p>}
      {storeLines(listedBy, t, builtIn).map((line) => <Line key={line} testId="app-store-line">{line}</Line>)}
      {sentBy && <Line testId="app-sent-by">{t("apps.install.sentBy", { name: sentBy })}</Line>}
    </div>
  );
}

/** One short line, and the longer story behind an ⓘ beside it. */
function InfoLine({ children, info, testId, className = "text-xs text-text-secondary" }: { children: ReactNode; info?: ReactNode; testId?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div data-testid={testId}>
      <div className={`flex items-start gap-1.5 ${className}`}>
        <span className="min-w-0">{children}</span>
        {info && <InfoButton open={open} onToggle={() => setOpen(!open)} controls={id} testId={testId && `${testId}-info`} className="-my-0.5" />}
      </div>
      {info && open && <p id={id} data-testid={testId && `${testId}-text`} className="text-xs text-text-secondary leading-relaxed mt-1.5 ps-3 border-s-2 border-border">{info}</p>}
    </div>
  );
}

/** An error's line, with its ⓘ when it has a longer story (a browser that keeps no app files). */
function ErrorLine({ error, testId }: { error: AppErrorView; testId?: string }) {
  return <div role="alert"><InfoLine testId={testId} info={error.info} className="text-xs text-danger-ink whitespace-pre-line">{error.text}</InfoLine></div>;
}

/** What the app may do: always its own data on this device (not on an update), then each permission it asks for. */
function Permissions({ asks, update }: { asks: readonly string[]; update: boolean }) {
  const { t } = useI18n();
  const lines: { key: string; label: string; info?: string }[] = [
    ...(update ? [] : [{ key: "storage", label: t("apps.install.perm.storage") }]),
    ...asks.map((p) => {
      const known = PERMISSIONS[p];
      return { key: p, label: known ? t(known.label) : p, ...(known?.info && { info: t(known.info) }) };
    }),
  ];
  return (
    <div className="space-y-1.5" data-testid="app-permissions">
      <p className="text-xs font-semibold text-accent uppercase tracking-wide">{update ? t("apps.install.newPermissions") : t("apps.install.permissions")}</p>
      <ul className="space-y-1">
        {lines.map((line) => (
          <li key={line.key} data-permission={line.key} className="flex items-start gap-2 text-sm text-text-primary">
            <span aria-hidden="true" className="mt-[7px] w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
            <InfoLine info={line.info} testId={`app-permission-${line.key}`} className="text-sm text-text-primary">{line.label}</InfoLine>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Who learns the person's address (WISP 1200 § Permissions): one line, the rest behind its ⓘ. On the install screen,
 * the host the bundle comes from; for an app without `internet`, that its publisher may still learn the address. On
 * the web in WebKit (Safari, every browser on iPhone and iPad), one more line: any app can reach other servers there.
 */
function Privacy({ from, internet, carried }: { from?: string; internet: boolean; carried?: boolean }) {
  const { t } = useI18n();
  const offline = internet ? "" : ` ${t("apps.install.ipInfoOffline")}`;
  // Read from this copy of Ghostly (WISP 1200 § Built-in apps): no host saw anything, whatever URL it is published at.
  if (carried) {
    return (
      <div className="space-y-2" data-testid="app-privacy">
        <InfoLine testId="app-carried-line" info={t("apps.builtIn.carriedInfo")}>{t("apps.builtIn.carried")}</InfoLine>
        {webKitAppLeak() && <InfoLine testId="app-webkit-line" info={t("apps.install.webkitInfo")}>{t("apps.install.webkit")}</InfoLine>}
      </div>
    );
  }
  // Lines far enough apart that each ⓘ's tap area (wider than the icon) stays off the other's: 20 px apart, pressing
  // the IP line's ⓘ opened Safari's line.
  return (
    <div className="space-y-2" data-testid="app-privacy">
      {from
        ? <InfoLine testId="app-ip-line" info={`${t("apps.install.ipInfo", { host: hostOf(from) })}${offline}`}>{t("apps.install.ipLine", { host: hostOf(from) })}</InfoLine>
        : !internet && <InfoLine testId="app-ip-line" info={t("apps.install.ipInfoOffline")}>{t("apps.install.ipLineInstalled")}</InfoLine>}
      {from && webKitAppLeak() && <InfoLine testId="app-webkit-line" info={t("apps.install.webkitInfo")}>{t("apps.install.webkit")}</InfoLine>}
    </div>
  );
}

function Shell({ titleId, onClose, children, testId, box }: { titleId: string; onClose: () => void; children: ReactNode; testId: string; box?: RefObject<HTMLDivElement | null> }) {
  const backdrop = useBackdropDismiss(onClose);
  const own = useRef<HTMLDivElement>(null);
  const ref = box ?? own;
  useDialogFocus(ref, onClose);
  // Over the whole window: opened from a card in the chat's timeline, whose scrolling box would hold a fixed layer.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 sm:p-4 animate-fade-in" {...backdrop}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={testId}
        className="focus:outline-none w-full sm:max-w-md bg-panel-header border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl p-5 space-y-4 max-h-[90dvh] overflow-y-auto pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** What "Version {{version}}" gets in place of the version (a private-use character), to put the version there in its own direction. */
const VERSION_SLOT = "";

function Head({ titleId, title, version, tagline, icon, installed }: { titleId: string; title: string; version?: string; tagline?: string; icon?: Uint8Array | null; installed?: InstalledAppView }) {
  const { t } = useI18n();
  const [before = "", after = ""] = version ? t("apps.app.version", { version: VERSION_SLOT }).split(VERSION_SLOT) : [];
  return (
    <div className="flex items-center gap-3">
      <AppIcon size={48} icon={icon} installed={installed} />
      <div className="min-w-0">
        <h2 id={titleId} dir="auto" className="text-match-parent text-lg font-medium text-text-primary break-words">{title}</h2>
        {/* A link, a long word or a version (64 characters, no space) breaks anywhere: unbroken, it pushed the screen
            sideways on a phone, and cut it off in Arabic. The version keeps its own direction: in Arabic, broken
            after "1.0.0-", its "-" was drawn at the left ("-1.0.0"). */}
        {version && <p className="text-xs text-text-muted [overflow-wrap:anywhere]">{before}<bdi dir="ltr">{version}</bdi>{after}</p>}
        {tagline && <p dir="auto" className="text-match-parent text-sm text-text-secondary [overflow-wrap:anywhere]">{tagline}</p>}
      </div>
    </div>
  );
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** An app read again is what the screen showed: the same version, from a publisher shown the same, asking the same. */
function sameScreen(a: AppPreview, b: AppPreview): boolean {
  return a.digest === b.digest && a.install === b.install && a.run.status === b.run.status && a.unknownPublisher === b.unknownPublisher
    && sameSet(a.asks, b.asks) && sameSet(a.manifest.permissions, b.manifest.permissions);
}

/**
 * The install screen for an app to fetch (a pasted URL, a store's listing, a chat card): fetched and checked when it
 * opens, which is when the person pressed Install or chose it, and stored only on Install.
 */
export function AppInstallDialog({ source, fetched, title, sentBy, onClose, onInstalled, openAfter }: {
  source: AppSource;
  /** Already fetched and checked for this screen (a pasted URL read to see whether it is an app). */
  fetched?: AppPreview;
  /** What to call it while it is fetched (a card's or a listing's title). */
  title?: string;
  /** The contact who sent the card: "Sent by Ana". */
  sentBy?: string;
  onClose: () => void;
  onInstalled?: (app: InstalledAppView) => void;
  /** The button says "Install and open" (from a chat card, where installing opens it there). */
  openAfter?: boolean;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const [preview, setPreview] = useState<AppPreview | null>(fetched ?? null);
  const [error, setError] = useState<AppErrorView | null>(null);
  const [busy, setBusy] = useState(false);
  const focusBack = useFocusBack(busy);
  const key = JSON.stringify(source);
  const have = !!fetched;
  // Fetched once per source: a new language while it loads must not fetch it again.
  const tr = useRef(t);
  tr.current = t;
  useEffect(() => {
    if (have) return;
    let live = true;
    setPreview(null); setError(null);
    engine.call("appPreview", JSON.parse(key) as AppSource).then((p) => { if (live) setPreview(p); }, (e: unknown) => { if (live) setError(appErrorView(e, tr.current)); });
    return () => { live = false; };
  }, [key, have]);

  // The app asks for more than this screen lists, and reading it again failed (offline, the host down): what the screen
  // shows is not what Install would be asked to grant, so Install waits until Try again reads it.
  const [stale, setStale] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const retryButton = useRef<HTMLButtonElement>(null), confirmButton = useRef<HTMLButtonElement>(null);
  // Why the screen is read again: what it asks changed, or the engine no longer holds what it fetched (`expired`).
  const rereadFor = useRef<"asks" | "expired">("asks");
  const recheck = async (): Promise<AppPreview | null> => {
    try {
      const again = await engine.call("appPreview", source);
      const was = preview;
      setPreview(again); setStale(false);
      if (rereadFor.current === "asks") setError({ text: t(again.install === "update" ? "apps.errors.permissionsChanged" : "apps.install.asksChanged") });
      // Read again as it was: nothing new to look at, Install takes it. Another version, or other words: look at it first.
      else if (was && sameScreen(was, again)) { setError(null); return again; }
      else setError({ text: t("apps.errors.expired") });
      return null;
    } catch (read) {
      // The read's own failure, said as it is: "look at them again" over the old list had nothing new to look at.
      setStale(true); setError(appErrorView(read, t));
      return null;
    }
  };
  const grant = (shown: AppPreview) =>
    engine.call("appInstall", { stage: shown.stage, digest: shown.digest, grant: [...shown.manifest.permissions], asks: [...shown.asks] });
  const install = async () => {
    if (!preview || stale) return;
    focusBack();
    setBusy(true); setError(null);
    try {
      let app: InstalledAppView;
      try { app = await grant(preview); } catch (e) {
        // What this screen fetched is held 10 minutes, and 4 screens' worth (a phone left here, other screens since): read
        // again, the same version asking the same installs as pressed. Else it showed "check it again" with no way to.
        if (appErrorCode(e) !== "expired") throw e;
        rereadFor.current = "expired";
        const again = await recheck();
        if (!again) return;
        app = await grant(again);
      }
      await refreshInstalledApps();
      onInstalled?.(app);
      onClose();
    } catch (e) {
      // It asks for more than this screen listed (the app uninstalled since it opened, a version that dropped a permission
      // installed by the check): the screen shows what it asks now, and Install grants only that.
      if (appErrorCode(e) === "permissions-changed") { rereadFor.current = "asks"; await recheck(); }
      else setError(appErrorView(e, t));
    } finally { setBusy(false); }
  };
  const retry = async () => {
    setRechecking(true); setError(null);
    try { await recheck(); } finally { setRechecking(false); }
  };
  // Install turned off with the focus on it hands the focus to Try again; Try again gone (read) hands it back to Install.
  const wasStale = useRef(false);
  useEffect(() => {
    const was = wasStale.current;
    wasStale.current = stale;
    if (was === stale) return;
    const active = document.activeElement;
    if (!active || active === document.body || active === confirmButton.current) (stale ? retryButton : confirmButton).current?.focus({ preventScroll: true });
  }, [stale]);
  // While Install runs, the screen stays: closed, the install went on all the same, and opened the app after a Cancel.
  const close = () => { if (!busy) onClose(); };

  const shownTitle = preview?.manifest.title ?? title ?? t("apps.title");
  const blocked = preview && (preview.run.status === "revoked" || preview.run.status === "removed" || preview.install === "rollback" || preview.install === "equivocation" || preview.install === "same");
  const why = preview && (runLine(preview.run, t) ?? (preview.install === "rollback" ? t("apps.install.rollback")
    : preview.install === "equivocation" ? t("apps.install.equivocation")
      : preview.install === "same" ? t("apps.install.same") : null));
  return (
    <Shell titleId={titleId} onClose={close} testId="app-install">
      <Head titleId={titleId} title={shownTitle} version={preview?.manifest.version} tagline={preview?.manifest.tagline} icon={preview?.icon} />
      {!preview && !error && <p className="text-sm text-text-muted" data-testid="app-install-checking">{t("apps.install.fetching")}</p>}
      {preview && (
        <>
          <Publisher fingerprint={preview.fingerprint} unknown={preview.unknownPublisher} listedBy={preview.listedBy} sentBy={sentBy} builtIn={preview.carried && "carried"} />
          {preview.manifest.description && <p dir="auto" className="text-sm text-text-secondary whitespace-pre-line [overflow-wrap:anywhere]">{preview.manifest.description}</p>}
          {!blocked && (preview.install === "new" || preview.asks.length > 0) && <Permissions asks={preview.asks} update={preview.install === "update"} />}
          {why && <Line tone="danger" testId="app-install-blocked">{why}</Line>}
          <Privacy from={preview.from} internet={(preview.manifest.permissions as readonly string[]).includes("internet")} carried={preview.carried} />
        </>
      )}
      {error && <ErrorLine error={error} testId="app-install-error" />}
      {/* Too wide for one line (a phone at a large text size), the buttons wrap: unwrapped, "Install and open" pushed
          Cancel off the screen's start, where nothing scrolls to it. */}
      <div className="flex flex-wrap justify-end gap-2">
        <Button disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
        {preview && !blocked && stale && (
          <Button ref={retryButton} data-testid="app-install-retry" loading={rechecking} onClick={() => void retry()}>{t("apps.page.tryAgain")}</Button>
        )}
        {preview && !blocked && (
          <Button ref={confirmButton} variant="primary" data-testid="app-install-confirm" loading={busy} disabled={stale} onClick={() => void install()}>
            {preview.install === "update" ? t("apps.install.update")
              // A built-in app is already here: the button allows what it asks, it downloads nothing.
              : preview.carried ? t(openAfter ? "apps.builtIn.allowOpen" : "apps.builtIn.allow")
                : openAfter ? t("apps.install.installOpen") : t("apps.install.install")}
          </Button>
        )}
      </div>
    </Shell>
  );
}

/**
 * An installed app's screen, from the Apps page: what it is, what it was granted, its state (a waiting update that asks
 * for more, a version a store removed or its publisher revoked, files to fetch again), Open and Uninstall. A version a
 * store removed stays stopped unless the person presses "Run anyway" here (WISP 1200 § Takedowns); a revoked one has no
 * such button.
 */
export function InstalledAppDialog({ app, onClose, onOpen, onUninstalled }: {
  app: InstalledAppView;
  onClose: () => void;
  onOpen: (app: InstalledAppView, options?: OpenAppOptions) => void;
  /** Uninstalled: the row this screen opened from goes, and the focus it would go back to with it. */
  onUninstalled?: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const [error, setError] = useState<AppErrorView | null>(null);
  const [busy, setBusy] = useState(false);
  // Which button started the work in progress: that one shows it is going.
  const [pending, setPending] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  // The question takes the place of the button that asked it, and the focus went with that button: it goes to the
  // question's Cancel (Enter again does not uninstall), and Cancel gives it back to Uninstall, never to the page.
  const keep = useRef<HTMLButtonElement>(null), uninstall = useRef<HTMLButtonElement>(null), asked = useRef(false);
  useEffect(() => {
    if (!removing && !asked.current) return;
    asked.current = true;
    (removing ? keep : uninstall).current?.focus({ preventScroll: true });
  }, [removing]);
  // The waiting update's section goes once the update lands, and the focus its Update had with it: the screen takes it,
  // so the next Tab starts in the screen, not on the page.
  const box = useRef<HTMLDivElement>(null), waits = !!app.pending, waited = useRef(waits);
  useEffect(() => {
    const was = waited.current;
    waited.current = waits;
    const active = document.activeElement;
    if (was && !waits && (!active || active === document.body)) box.current?.focus({ preventScroll: true });
  }, [waits]);
  // Fetch files goes once the files are back, and the focus it had with it: Open takes its place and the focus, or the
  // screen when the app still cannot run. The files come back while Fetch files is still busy, and Open stays disabled
  // (it takes no focus) until it ends: the focus is owed until then.
  const open = useRef<HTMLButtonElement>(null), lacks = app.run.status === "needs-files", lacked = useRef(lacks), owed = useRef(false);
  useEffect(() => {
    const was = lacked.current;
    lacked.current = lacks;
    if (was && !lacks) owed.current = true;
  }, [lacks]);
  useEffect(() => {
    if (!owed.current || busy) return;
    owed.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) (open.current ?? box.current)?.focus({ preventScroll: true });
  }, [lacks, busy]);
  const focusBack = useFocusBack(busy);
  const act = async (work: () => Promise<unknown>, close = false, which: string | null = null, view = appErrorView) => {
    focusBack();
    setBusy(true); setPending(which); setError(null);
    try { await work(); await refreshInstalledApps(); if (close) onClose(); } catch (e) { setError(view(e, t)); void refreshInstalledApps(); } finally { setBusy(false); setPending(null); }
  };
  // No link it came from answered with its files (offline, the host down, each holding another version): the engine
  // says so only by its run status, which was still `needs-files`. Said on the screen, or it looked as before.
  const fetchFiles = async () => {
    const run = await engine.call("appFetchFiles", { ref: app.ref });
    if (run.status === "needs-files") throw new Error(navigator.onLine === false ? "offline: You are offline" : "files-not-found: No link holds this version's files");
  };
  // While Uninstall (or an Update) runs, the screen stays, as the install screen's: a Cancel then showed the app as
  // still here, and it was deleted a moment later. Escape on the question is its Cancel, as on the other Remove questions.
  const close = () => { if (!busy) onClose(); };
  const keepIt = () => { if (!busy) setRemoving(false); };
  const why = runLine(app.run, t);
  const canRun = app.run.status === "ok";
  if (removing) {
    return (
      <Shell titleId={titleId} onClose={keepIt} testId="app-uninstall">
        <h2 id={titleId} className="text-lg font-medium text-text-primary [overflow-wrap:anywhere]">{t("apps.app.uninstallTitle", { title: app.title })}</h2>
        <p className="text-sm text-text-secondary">{t("apps.app.uninstallText")}</p>
        {error && <ErrorLine error={error} />}
        <div className="flex flex-wrap justify-end gap-2">
          <Button ref={keep} disabled={busy} onClick={keepIt}>{t("common.cancel")}</Button>
          <Button data-testid="app-export" disabled={busy} loading={pending === "export"} onClick={() => void act(async () => saveAppData(app.ref, await engine.call("appDataExportText", { ref: app.ref })), false, "export")}>{t("apps.app.export")}</Button>
          <Button variant="danger" data-testid="app-uninstall-confirm" disabled={busy} loading={pending === "uninstall"} onClick={() => void act(async () => { await engine.call("appUninstall", { ref: app.ref }); await forgetLinkedFiles(app.ref); onUninstalled?.(); }, true, "uninstall")}>{t("apps.app.uninstall")}</Button>
        </div>
      </Shell>
    );
  }
  return (
    <Shell titleId={titleId} onClose={close} testId="app-details" box={box}>
      <Head titleId={titleId} title={app.title} version={app.version} tagline={app.tagline} installed={app} />
      <Publisher fingerprint={app.fingerprint} unknown={app.unknownPublisher} listedBy={app.listedBy} builtIn={app.builtIn && "installed"} />
      {app.description && <p dir="auto" className="text-sm text-text-secondary whitespace-pre-line [overflow-wrap:anywhere]">{app.description}</p>}
      {why && <Line tone={app.run.status === "needs-files" ? "warning" : "danger"} testId="app-run-line">{why}</Line>}
      {/* The version's internal `sequence` is never shown: the person knows it by the version in the header. */}
      {app.equivocation && <Line tone="warning" testId="app-equivocation">{t("apps.install.equivocation")}</Line>}
      {/* What it may do now stays while an update waits: that update's "also asks to" adds to this list. */}
      <Permissions asks={app.permissions} update={false} />
      {app.pending && (
        <div className="bg-surface rounded-xl px-4 py-3 space-y-3" data-testid="app-update">
          <p className="text-sm text-text-primary">{t("apps.app.updateWaits", { version: app.pending.version })}</p>
          {/* An update that no longer adds a permission to the version installed meanwhile has nothing to list. */}
          {app.pending.added.length > 0 && <Permissions asks={app.pending.added} update />}
          {/* Update grants only the update listed here: another one found since is refused, and the list read again shows it. */}
          <div className="flex justify-end">
            <Button variant="primary" data-testid="app-update-accept" disabled={busy} loading={pending === "update"} onClick={() => void act(() => engine.call("appUpdateAccept", { ref: app.ref, sequence: app.pending!.sequence, added: [...app.pending!.added] }), false, "update", appUpdateErrorView)}>{t("apps.install.update")}</Button>
          </div>
        </div>
      )}
      <Privacy internet={(app.permissions as readonly string[]).includes("internet")} />
      {error && <ErrorLine error={error} testId="app-details-error" />}
      <div className="flex flex-wrap justify-end gap-2">
        {/* While an Update (or Fetch files) runs, nothing here leaves the screen, as Escape doesn't: opening the app mid-update
            ran it while its files were replaced, and the update's error then had no screen to show on. */}
        <Button ref={uninstall} variant="danger" data-testid="app-uninstall-open" disabled={busy} onClick={() => setRemoving(true)}>{t("apps.app.uninstall")}</Button>
        {app.run.status === "needs-files" && <Button data-testid="app-fetch-files" disabled={busy} loading={pending === "files"} onClick={() => void act(fetchFiles, false, "files")}>{t("apps.app.fetchFiles")}</Button>}
        {app.run.status === "removed" && <Button data-testid="app-run-anyway" disabled={busy} onClick={() => { onOpen(app, { runAnyway: true }); onClose(); }}>{t("apps.app.runAnyway")}</Button>}
        {!canRun && app.run.status !== "needs-files" && <Button data-testid="app-keep-stopped" disabled={busy} onClick={onClose}>{t("apps.app.keepStopped")}</Button>}
        {canRun && <Button ref={open} variant="primary" data-testid="app-open" disabled={busy} onClick={() => { onOpen(app); onClose(); }}>{t("apps.page.open")}</Button>}
      </div>
    </Shell>
  );
}
