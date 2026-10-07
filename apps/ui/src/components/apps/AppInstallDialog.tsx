import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { engine } from "@ghostly/browser/platform/engine";
import type { AppListedBy, AppPreview, AppRunStatus, AppSource, InstalledAppView } from "@ghostly/browser/engine/apps";
import { useBackdropDismiss, useDialogFocus } from "../../hooks/useDismiss";
import { useI18n, type Translate, type TranslationKey } from "../../contexts/I18nContext";
import { Button } from "../wallet/ui";
import { InfoButton } from "../layout";
import { AppIcon, Fingerprint } from "./AppIcon";
import { appErrorText } from "../../lib/apps/errors";
import { refreshInstalledApps } from "../../lib/apps/installed";
import { saveAppData } from "../../lib/apps/exportData";
import { webKitAppLeak } from "../../lib/apps/flag";

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
  internet: { label: "apps.install.perm.internet", info: "apps.install.perm.internetInfo" },
  name: { label: "apps.install.perm.name" },
};

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/** Where the app stands with the person's stores: "In <store>", "Found by <index>", "Not in any of your stores". */
function storeLines(listedBy: readonly AppListedBy[], t: Translate): string[] {
  const curated = listedBy.filter((s) => s.kind === "curated");
  if (curated.length) return curated.map((s) => t("apps.install.inStore", { name: s.name }));
  return [...listedBy.map((s) => t("apps.install.foundBy", { name: s.name })), t("apps.install.notListed")];
}

/** Why it cannot run, if it cannot: revoked by its publisher, removed by a store, its files gone. */
function runLine(run: AppRunStatus, t: Translate): string | null {
  if (run.status === "revoked") return t("apps.install.revoked");
  if (run.status === "removed") return run.by.map((b) => t("apps.install.removed", { store: b.name, reason: b.reason })).join("\n");
  if (run.status === "needs-files") return t("apps.app.needsFiles");
  return null;
}

function Line({ children, tone = "muted", testId }: { children: ReactNode; tone?: "muted" | "danger" | "warning"; testId?: string }) {
  const color = { muted: "text-text-secondary", danger: "text-danger", warning: "text-test-money-ink" }[tone];
  return <p data-testid={testId} className={`text-xs whitespace-pre-line ${color}`}>{children}</p>;
}

/** The publisher and the stores, as a person checks them. */
function Publisher({ fingerprint, unknown, listedBy, sentBy }: { fingerprint: string; unknown: boolean; listedBy: readonly AppListedBy[]; sentBy?: string }) {
  const { t } = useI18n();
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
      {storeLines(listedBy, t).map((line) => <Line key={line} testId="app-store-line">{line}</Line>)}
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
function Privacy({ from, internet }: { from?: string; internet: boolean }) {
  const { t } = useI18n();
  const offline = internet ? "" : ` ${t("apps.install.ipInfoOffline")}`;
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

function Shell({ titleId, onClose, children, testId }: { titleId: string; onClose: () => void; children: ReactNode; testId: string }) {
  const backdrop = useBackdropDismiss(onClose);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, onClose);
  // Over the whole window: opened from a card in the chat's timeline, whose scrolling box would hold a fixed layer.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 sm:p-4 animate-fade-in" {...backdrop}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={testId}
        className="focus:outline-none w-full sm:max-w-md bg-panel-header border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl p-5 space-y-4 max-h-[90dvh] overflow-y-auto pb-safe">
        {children}
      </div>
    </div>,
    document.body,
  );
}

function Head({ titleId, title, version, tagline, icon, installed }: { titleId: string; title: string; version?: string; tagline?: string; icon?: Uint8Array | null; installed?: InstalledAppView }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-3">
      <AppIcon size={48} icon={icon} installed={installed} />
      <div className="min-w-0">
        <h2 id={titleId} className="text-lg font-medium text-text-primary truncate">{title}</h2>
        {version && <p className="text-xs text-text-muted">{t("apps.app.version", { version })}</p>}
        {tagline && <p className="text-sm text-text-secondary">{tagline}</p>}
      </div>
    </div>
  );
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = JSON.stringify(source);
  const have = !!fetched;
  // Fetched once per source: a new language while it loads must not fetch it again.
  const tr = useRef(t);
  tr.current = t;
  useEffect(() => {
    if (have) return;
    let live = true;
    setPreview(null); setError(null);
    engine.call("appPreview", JSON.parse(key) as AppSource).then((p) => { if (live) setPreview(p); }, (e: unknown) => { if (live) setError(appErrorText(e, tr.current)); });
    return () => { live = false; };
  }, [key, have]);

  const install = async () => {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      const app = await engine.call("appInstall", { digest: preview.digest, grant: [...preview.manifest.permissions] });
      await refreshInstalledApps();
      onInstalled?.(app);
      onClose();
    } catch (e) { setError(appErrorText(e, t)); } finally { setBusy(false); }
  };

  const shownTitle = preview?.manifest.title ?? title ?? t("apps.title");
  const blocked = preview && (preview.run.status === "revoked" || preview.run.status === "removed" || preview.install === "rollback" || preview.install === "equivocation" || preview.install === "same");
  const why = preview && (runLine(preview.run, t) ?? (preview.install === "rollback" ? t("apps.install.rollback")
    : preview.install === "equivocation" ? t("apps.install.equivocation", { sequence: String(preview.manifest.sequence) })
      : preview.install === "same" ? t("apps.install.same") : null));
  return (
    <Shell titleId={titleId} onClose={onClose} testId="app-install">
      <Head titleId={titleId} title={shownTitle} version={preview?.manifest.version} tagline={preview?.manifest.tagline} icon={preview?.icon} />
      {!preview && !error && <p className="text-sm text-text-muted" data-testid="app-install-checking">{t("apps.install.fetching")}</p>}
      {preview && (
        <>
          <Publisher fingerprint={preview.fingerprint} unknown={preview.unknownPublisher} listedBy={preview.listedBy} sentBy={sentBy} />
          {preview.manifest.description && <p className="text-sm text-text-secondary whitespace-pre-line">{preview.manifest.description}</p>}
          {!blocked && (preview.install === "new" || preview.asks.length > 0) && <Permissions asks={preview.asks} update={preview.install === "update"} />}
          {why && <Line tone="danger" testId="app-install-blocked">{why}</Line>}
          <Privacy from={preview.from} internet={(preview.manifest.permissions as readonly string[]).includes("internet")} />
        </>
      )}
      {error && <Line tone="danger" testId="app-install-error">{error}</Line>}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        {preview && !blocked && (
          <Button variant="primary" data-testid="app-install-confirm" disabled={busy} onClick={() => void install()}>
            {preview.install === "update" ? t("apps.install.update") : openAfter ? t("apps.install.installOpen") : t("apps.install.install")}
          </Button>
        )}
      </div>
    </Shell>
  );
}

/**
 * An installed app's screen, from the Apps page: what it is, what it was granted, its state (a waiting update that asks
 * for more, a version a store removed or its publisher revoked, files to fetch again), Open and Uninstall.
 */
export function InstalledAppDialog({ app, onClose, onOpen }: { app: InstalledAppView; onClose: () => void; onOpen: (app: InstalledAppView) => void }) {
  const { t } = useI18n();
  const titleId = useId();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const act = async (work: () => Promise<unknown>, close = false) => {
    setBusy(true); setError(null);
    try { await work(); await refreshInstalledApps(); if (close) onClose(); } catch (e) { setError(appErrorText(e, t)); } finally { setBusy(false); }
  };
  const why = runLine(app.run, t);
  const canRun = app.run.status === "ok";
  if (removing) {
    return (
      <Shell titleId={titleId} onClose={onClose} testId="app-uninstall">
        <h2 id={titleId} className="text-lg font-medium text-text-primary">{t("apps.app.uninstallTitle", { title: app.title })}</h2>
        <p className="text-sm text-text-secondary">{t("apps.app.uninstallText")}</p>
        {error && <Line tone="danger">{error}</Line>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={() => setRemoving(false)}>{t("common.cancel")}</Button>
          <Button data-testid="app-export" disabled={busy} onClick={() => void act(async () => saveAppData(app.ref, await engine.call("appDataExport", { ref: app.ref })))}>{t("apps.app.export")}</Button>
          <Button variant="danger" data-testid="app-uninstall-confirm" disabled={busy} onClick={() => void act(() => engine.call("appUninstall", { ref: app.ref }), true)}>{t("apps.app.uninstall")}</Button>
        </div>
      </Shell>
    );
  }
  return (
    <Shell titleId={titleId} onClose={onClose} testId="app-details">
      <Head titleId={titleId} title={app.title} version={app.version} tagline={app.tagline} installed={app} />
      <Publisher fingerprint={app.fingerprint} unknown={app.unknownPublisher} listedBy={app.listedBy} />
      {app.description && <p className="text-sm text-text-secondary whitespace-pre-line">{app.description}</p>}
      {why && <Line tone={app.run.status === "needs-files" ? "warning" : "danger"} testId="app-run-line">{why}</Line>}
      {app.equivocation && <Line tone="warning" testId="app-equivocation">{t("apps.install.equivocation", { sequence: String(app.equivocation.sequence) })}</Line>}
      {app.pending && (
        <div className="bg-surface rounded-xl px-4 py-3 space-y-3" data-testid="app-update">
          <p className="text-sm text-text-primary">{t("apps.app.updateWaits", { version: app.pending.version })}</p>
          <Permissions asks={app.pending.added} update />
          <div className="flex justify-end">
            <Button variant="primary" data-testid="app-update-accept" disabled={busy} onClick={() => void act(() => engine.call("appUpdateAccept", { ref: app.ref }))}>{t("apps.install.update")}</Button>
          </div>
        </div>
      )}
      {!app.pending && <Permissions asks={app.permissions} update={false} />}
      <Privacy internet={(app.permissions as readonly string[]).includes("internet")} />
      {error && <Line tone="danger" testId="app-details-error">{error}</Line>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="danger" data-testid="app-uninstall-open" onClick={() => setRemoving(true)}>{app.run.status === "ok" ? t("apps.app.uninstall") : t("apps.app.remove")}</Button>
        {app.run.status === "needs-files" && <Button data-testid="app-fetch-files" disabled={busy} onClick={() => void act(() => engine.call("appFetchFiles", { ref: app.ref }))}>{t("apps.app.fetchFiles")}</Button>}
        {!canRun && app.run.status !== "needs-files" && <Button onClick={onClose}>{t("apps.app.keepStopped")}</Button>}
        {canRun && <Button variant="primary" data-testid="app-open" onClick={() => { onOpen(app); onClose(); }}>{t("apps.page.open")}</Button>}
      </div>
    </Shell>
  );
}
