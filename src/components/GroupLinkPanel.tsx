import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { QRCodeSVG } from "qrcode.react";
import { engine } from "@ghostly/browser/platform/engine";
import type { GroupView } from "@ghostly/browser/shared/types";
import { useBackdropDismiss } from "../hooks/useDismiss";
import { copyText, shareLink } from "../lib/shareLink";
import { groupLinkUrl } from "../lib/groups";

const MAX_MEMBERS = 8;

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [said, setSaid] = useState<"" | "copied" | "shared">("");
  const [showQr, setShowQr] = useState(large);
  const saidTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shareButton = useRef<HTMLButtonElement>(null);
  useEffect(() => () => clearTimeout(saidTimer.current), []);
  const url = groupLinkUrl(group);
  const full = group.members.length >= MAX_MEMBERS;
  const flash = (what: "copied" | "shared") => {
    setSaid(what); clearTimeout(saidTimer.current);
    saidTimer.current = setTimeout(() => setSaid(""), 2500);
  };
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "That did not work"); } finally { setBusy(false); }
  };
  const copy = async () => {
    setError("");
    try { await copyText(url); flash("copied"); } catch { setError("Copy did not work. Select the link and copy it."); }
  };
  const share = async () => {
    setError("");
    try {
      const outcome = await shareLink(url, group.name ? `Join ${group.name} on Ghostly` : "Join a group on Ghostly", shareButton.current);
      if (outcome !== "cancelled") flash(outcome);
    } catch { setError("Sharing did not work. Copy the link instead."); }
  };
  const note = full
    ? `The group is full (${MAX_MEMBERS} of ${MAX_MEMBERS}): nobody gets in through the link until someone leaves.`
    : `Anyone who opens this link joins, without being your contact or saying who they are. They get in while your app is open, up to ${MAX_MEMBERS} members.`;

  if (!url) return <div className={large ? "text-center" : "mt-4"} data-testid="group-link" data-state="off">
    {!large && <h3 className="text-xs font-bold uppercase tracking-wider text-accent">Group link</h3>}
    <p className="mt-1 text-sm text-text-muted">The link is off: nobody can join with it. Turn it on to let anyone who has it in, without being your contact.</p>
    <button disabled={busy || full} onClick={() => void run(() => engine.call("enableGroupLink", { groupId: group.id }))} data-testid="group-link-enable"
      className="mt-2 min-h-9 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-panel-header hover:bg-accent-hover disabled:opacity-40">{full ? "The group is full" : "Turn on the link"}</button>
    {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
  </div>;

  const field = <input readOnly value={url} aria-label="Group link" data-testid="group-link-url" onFocus={e => e.currentTarget.select()}
    className={`min-w-0 flex-1 rounded-lg bg-input-bg px-3 font-mono text-text-secondary focus:outline-none focus:ring-1 focus:ring-accent ${large ? "py-2.5 text-xs" : "py-1.5 text-[11px]"}`} />;
  const copyButton = <button onClick={() => void copy()} data-testid="group-link-copy"
    className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-semibold ${large ? "min-h-11 flex-1 bg-surface-alt px-4 text-sm text-text-primary hover:bg-surface-hover" : "bg-surface-alt px-2.5 py-1.5 text-xs text-text-primary hover:bg-surface-hover"}`}>
    <CopyIcon /><span>{said === "copied" ? "Copied" : "Copy"}</span>
  </button>;
  const shareButtonEl = <button ref={shareButton} onClick={() => void share()} data-testid="group-link-share"
    className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-accent font-semibold text-panel-header hover:bg-accent-hover ${large ? "min-h-11 flex-1 px-4 text-sm" : "px-2.5 py-1.5 text-xs"}`}>
    <ShareIcon /><span>{said === "shared" ? "Shared" : "Share"}</span>
  </button>;
  const adminControls = group.isAdmin && <div className={`flex flex-wrap gap-1 ${large ? "justify-center" : ""}`}>
    {!large && <button onClick={() => setShowQr(v => !v)} aria-expanded={showQr} data-testid="group-link-qr-toggle" className="rounded px-2 py-1 text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary">{showQr ? "Hide QR" : "Show QR"}</button>}
    <button disabled={busy} onClick={() => void run(() => engine.call("enableGroupLink", { groupId: group.id, reset: true }))} data-testid="group-link-reset"
      title="A new link; the current one stops working" className="rounded px-2 py-1 text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-40">New link</button>
    <button disabled={busy} onClick={() => void run(() => engine.call("disableGroupLink", { groupId: group.id }))} data-testid="group-link-disable"
      title="Nobody can join with the link until it is on again" className="rounded px-2 py-1 text-xs text-danger hover:bg-danger/10 disabled:opacity-40">Turn off</button>
  </div>;
  const qr = <div data-testid="group-link-qr" className={`mx-auto w-fit max-w-full rounded-2xl bg-white p-3 [&_svg]:h-auto [&_svg]:max-w-full ${large ? "" : "mt-2"}`}>
    <QRCodeSVG value={url} size={large ? 248 : 184} marginSize={1} title="Group link QR code" bgColor="#ffffff" fgColor="#0b0f1a" level="M" />
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
    <h3 className="text-xs font-bold uppercase tracking-wider text-accent">Group link</h3>
    <div className="mt-2 flex">{field}</div>
    <div className="mt-2 flex flex-wrap items-center gap-1.5">{shareButtonEl}{copyButton}{adminControls}</div>
    <p data-testid="group-link-note" className={`mt-2 text-xs ${full ? "text-amber-500" : "text-text-muted"}`}>{note}</p>
    {showQr && qr}
    {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
  </div>;
}

/**
 * The group's link as the main thing on screen: after creating a group (`created`), and from the
 * header's Share link.
 */
export function GroupShareDialog({ group, created = false, onClose }: { group: GroupView; created?: boolean; onClose(): void }) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const backdrop = useBackdropDismiss(onClose);
  useEffect(() => {
    const element = dialog.current!; element.showModal();
    // Share first, not the address field (which would select itself and scroll to its end).
    element.querySelector<HTMLButtonElement>('[data-testid="group-link-share"]')?.focus();
    return () => element.close();
  }, []);
  return createPortal(<dialog ref={dialog} {...backdrop} onCancel={e => { e.preventDefault(); onClose(); }} aria-labelledby={`${id}-title`} data-testid="group-share-dialog"
    className="m-auto w-[calc(100%_-_2rem)] max-w-sm max-h-[92dvh] overflow-y-auto rounded-2xl border border-border bg-sidebar-bg p-5 text-text-primary shadow-2xl backdrop:bg-black/60">
    <div className="mb-4 text-center">
      <h2 id={`${id}-title`} className="text-lg font-semibold">{created ? `${group.name || "Your group"} is ready` : `Share ${group.name || "the group"}`}</h2>
      <p className="mt-1 text-sm text-text-muted">{created ? "Share its link to bring people in: whoever opens it joins." : "Whoever opens this link joins the group."}</p>
    </div>
    <GroupLinkPanel group={group} large />
    <button onClick={onClose} data-testid="group-share-done" className="mt-4 min-h-11 w-full rounded-lg px-4 text-sm text-text-secondary hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent">
      {created ? "Go to the group" : "Done"}
    </button>
  </dialog>, document.body);
}
