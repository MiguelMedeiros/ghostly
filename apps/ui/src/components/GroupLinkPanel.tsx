import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { QRCodeSVG } from "qrcode.react";
import { engine } from "@ghostly/browser/platform/engine";
import type { GroupView } from "@ghostly/browser/shared/types";
import { useBackdropDismiss } from "../hooks/useDismiss";
import { copyText, shareLink } from "../lib/shareLink";
import { groupLinkUrl } from "../lib/groups";
import { COMMUNITY_LIMITS, MAX_GROUP_MEMBERS } from "@ghostly/core";
import { GroupAvatar } from "./GroupAvatar";
import { useI18n } from "../contexts/I18nContext";
import { errorText } from "../lib/errorText";

function ShareIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 16V3m0 0L7 8m5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" /></svg>;
}
function CopyIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3" /></svg>;
}

/**
 * A group's link (`group-entry/1`) with everything to hand it out: the QR, the address, Copy and
 * Share, and what the link does. `large` is the screen a new group ends on and the header's Share
 * link; the compact one heads the members panel. The admin replaces it (the old one stops working)
 * or turns it off.
 */
export function GroupLinkPanel({ group, large = false }: { group: GroupView; large?: boolean }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [said, setSaid] = useState<"" | "copied" | "shared">("");
  const [showQr, setShowQr] = useState(large);
  const saidTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shareButton = useRef<HTMLButtonElement>(null);
  useEffect(() => () => clearTimeout(saidTimer.current), []);
  const url = groupLinkUrl(group);
  const community = group.profile === "community";
  const cap = community ? COMMUNITY_LIMITS.members : MAX_GROUP_MEMBERS;
  const full = group.members.length >= cap;
  const flash = (what: "copied" | "shared") => {
    setSaid(what); clearTimeout(saidTimer.current);
    saidTimer.current = setTimeout(() => setSaid(""), 2500);
  };
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? errorText(e, t) : t("group.error.generic")); } finally { setBusy(false); }
  };
  const copy = async () => {
    setError("");
    try { await copyText(url); flash("copied"); } catch { setError(t("group.link.copyFailed")); }
  };
  const share = async () => {
    setError("");
    try {
      const outcome = await shareLink(url, group.name ? t("group.link.shareTitle", { name: group.name }) : t("group.link.shareTitleUnnamed"), shareButton.current);
      if (outcome !== "cancelled") flash(outcome);
    } catch { setError(t("group.link.shareFailed")); }
  };
  const note = full ? t("group.link.full", { count: cap }) : community ? t("group.link.noteCommunity", { count: cap }) : t("group.link.note", { count: cap });

  if (!url) return <div className={large ? "text-center" : "mt-4"} data-testid="group-link" data-state="off">
    {!large && <h3 className="text-xs font-bold uppercase tracking-wider text-accent">{t("group.link.title")}</h3>}
    <p className="mt-1 text-sm text-text-muted">{t("group.link.off")}</p>
    <button disabled={busy || full} onClick={() => void run(() => engine.call("enableGroupLink", { groupId: group.id }))} data-testid="group-link-enable"
      className="mt-2 min-h-9 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-panel-header hover:bg-accent-hover disabled:opacity-40">{full ? t("group.link.fullShort") : t("group.link.enable")}</button>
    {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
  </div>;

  const field = <input readOnly value={url} aria-label={t("group.link.title")} data-testid="group-link-url" onFocus={e => e.currentTarget.select()}
    className={`min-w-0 flex-1 rounded-lg bg-input-bg px-3 font-mono text-text-secondary focus:outline-none focus:ring-1 focus:ring-accent ${large ? "py-2.5 text-xs" : "py-1.5 text-[11px]"}`} />;
  const copyButton = <button onClick={() => void copy()} data-testid="group-link-copy"
    className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-semibold ${large ? "min-h-11 flex-1 bg-surface-alt px-4 text-sm text-text-primary hover:bg-surface-hover" : "bg-surface-alt px-2.5 py-1.5 text-xs text-text-primary hover:bg-surface-hover"}`}>
    <CopyIcon /><span>{said === "copied" ? t("group.link.copied") : t("common.copy")}</span>
  </button>;
  const shareButtonEl = <button ref={shareButton} onClick={() => void share()} data-testid="group-link-share"
    className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-accent font-semibold text-panel-header hover:bg-accent-hover ${large ? "min-h-11 flex-1 px-4 text-sm" : "px-2.5 py-1.5 text-xs"}`}>
    <ShareIcon /><span>{said === "shared" ? t("group.link.shared") : t("group.link.share")}</span>
  </button>;
  // For every member who sees the panel, not the admin alone: a community group's member hands its link out too.
  const qrToggle = <button onClick={() => setShowQr(v => !v)} aria-expanded={showQr} data-testid="group-link-qr-toggle" className="rounded px-2 py-1 text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary">{showQr ? t("group.link.hideQr") : t("group.link.showQr")}</button>;
  const adminControls = group.isAdmin && <div className={`flex flex-wrap gap-1 ${large ? "justify-center" : ""}`}>
    <button disabled={busy} onClick={() => void run(() => engine.call("enableGroupLink", { groupId: group.id, reset: true }))} data-testid="group-link-reset"
      title={t("group.link.resetHint")} className="rounded px-2 py-1 text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-40">{t("group.link.reset")}</button>
    <button disabled={busy} onClick={() => void run(() => engine.call("disableGroupLink", { groupId: group.id }))} data-testid="group-link-disable"
      title={t("group.link.disableHint")} className="rounded px-2 py-1 text-xs text-danger hover:bg-danger/10 disabled:opacity-40">{t("group.link.disable")}</button>
  </div>;
  // Large, on a short screen it gives up some of its size (never under 140px) before the dialog has to scroll.
  const qr = <div data-testid="group-link-qr" className={`mx-auto w-fit max-w-full rounded-2xl bg-white p-3 [&_svg]:h-auto [&_svg]:max-w-full ${large ? "[&_svg]:w-[clamp(140px,28dvh,248px)]" : "mt-2"}`}>
    <QRCodeSVG value={url} size={large ? 248 : 184} marginSize={1} title={t("group.link.qrTitle")} bgColor="#ffffff" fgColor="#0b0f1a" level="M" />
  </div>;

  if (large) return <div className="flex flex-col gap-3" data-testid="group-link" data-state="on">
    {qr}
    <div className="flex">{field}</div>
    <div className="flex gap-2">{shareButtonEl}{copyButton}</div>
    <p data-testid="group-link-note" className={`rounded-lg bg-surface-alt/80 p-3 text-xs leading-relaxed ${full ? "text-amber-500" : "text-text-secondary"}`}>{note}</p>
    {adminControls}
    {error && <p role="alert" className="text-center text-xs text-danger">{error}</p>}
  </div>;

  return <div className="mt-4 rounded-xl border border-border bg-surface-alt/40 p-3" data-testid="group-link" data-state="on">
    <h3 className="text-xs font-bold uppercase tracking-wider text-accent">{t("group.link.title")}</h3>
    <div className="mt-2 flex">{field}</div>
    <div className="mt-2 flex flex-wrap items-center gap-1.5">{shareButtonEl}{copyButton}{qrToggle}{adminControls}</div>
    <p data-testid="group-link-note" className={`mt-2 text-xs ${full ? "text-amber-500" : "text-text-muted"}`}>{note}</p>
    {showQr && qr}
    {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
  </div>;
}

/**
 * The group's link as the main thing on screen: after creating a group (`created`), and from the
 * header's Share link. Closed, it gives the focus back to what opened it, or to `returnFocus` when nothing did (a
 * new group opens on it by itself) or that is gone.
 */
export function GroupShareDialog({ group, created = false, onClose, returnFocus }: { group: GroupView; created?: boolean; onClose(): void; returnFocus?: RefObject<HTMLElement | null> }) {
  const { t } = useI18n();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const backdrop = useBackdropDismiss(onClose);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null, opener = returnFocus?.current;
    const element = dialog.current!; element.showModal();
    // Share first, not the address field (which would select itself and scroll to its end).
    element.querySelector<HTMLButtonElement>('[data-testid="group-link-share"]')?.focus();
    return () => {
      element.close();
      const back = before && before !== document.body && before.isConnected ? before : opener;
      back?.focus();
    };
  }, [returnFocus]);
  return createPortal(<dialog ref={dialog} {...backdrop} onCancel={e => { e.preventDefault(); onClose(); }} aria-labelledby={`${id}-title`} data-testid="group-share-dialog"
    className="m-auto w-[calc(100%_-_2rem)] max-w-sm max-h-[92dvh] overflow-y-auto rounded-2xl border border-border bg-sidebar-bg p-5 text-text-primary shadow-2xl backdrop:bg-black/60">
    <div className="mb-4 text-center">
      <GroupAvatar picture={group.picture} size={64} testId="group-share-avatar" className="mx-auto mb-3 bg-accent/15" />
      <h2 id={`${id}-title`} className="text-lg font-semibold">{created ? (group.name ? t("group.share.ready", { name: group.name }) : t("group.share.readyUnnamed")) : (group.name ? t("group.share.title", { name: group.name }) : t("group.share.titleUnnamed"))}</h2>
      <p className="mt-1 text-sm text-text-muted">{created ? t("group.share.createdHint") : t("group.share.hint")}</p>
    </div>
    <GroupLinkPanel group={group} large />
    {/* The way out stays in view at the dialog's foot while the rest scrolls: on a phone it was under the fold. */}
    <div className="sticky -bottom-5 -mx-5 -mb-5 mt-4 bg-sidebar-bg px-5 pb-5 pt-2">
      <button onClick={onClose} data-testid="group-share-done" className="min-h-11 w-full rounded-lg px-4 text-sm text-text-secondary hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent">
        {created ? t("group.share.open") : t("group.share.done")}
      </button>
    </div>
  </dialog>, document.body);
}
