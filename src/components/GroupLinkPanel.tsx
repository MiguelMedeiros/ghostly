import { useEffect, useRef, useState } from "react";
import { decodeGroupEntryLink, groupEntryUrl } from "@ghostly/core";
import { engine } from "@ghostly/browser/platform/engine";
import type { GroupView } from "@ghostly/browser/shared/types";
import { QRCodeDisplay } from "./QRCode";

/** The web app opens a group's link; the extension and desktop hand out the public app's address, which they also accept pasted. */
const PUBLIC_APP = "https://app.ghostly.tools";
function linkOrigin(): string {
  return /^https?:$/.test(window.location.protocol) ? window.location.origin : PUBLIC_APP;
}

/**
 * The group's link, for the admin (`group-entry/1`): anyone who has it joins without being a
 * contact, while the admin's app is open. It can be replaced (the old one stops working) or turned off.
 */
export function GroupLinkPanel({ group }: { group: GroupView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  const link = group.entryLink ? decodeGroupEntryLink(group.entryLink) : null;
  const url = link ? groupEntryUrl(linkOrigin(), link) : "";
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "That did not work"); } finally { setBusy(false); }
  };
  const copy = async () => {
    setError("");
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true); clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch { setError("Copy did not work. Select the link and copy it."); }
  };
  const full = group.members.length >= 8;
  return <div className="mt-4" data-testid="group-link">
    <h3 className="text-xs font-bold uppercase tracking-wider text-accent">Invite with a link</h3>
    {!link ? <>
      <p className="mt-1 text-sm text-text-muted">Anyone with the link can join, without being your contact or saying who they are. They get in while your app is open.</p>
      <button disabled={busy || full} onClick={() => void run(() => engine.call("enableGroupLink", { groupId: group.id }))} data-testid="group-link-enable"
        className="mt-2 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-panel-header hover:bg-accent-hover disabled:opacity-40">{full ? "The group is full" : "Create link"}</button>
    </> : <>
      <p className="mt-1 text-xs text-text-muted">Whoever opens it joins while your app is open{full ? ": the group is full now, so nobody gets in" : ""}. Share it where you want people to find it.</p>
      <div className="mt-2 flex gap-2">
        <input readOnly value={url} aria-label="Group link" data-testid="group-link-url" onFocus={e => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded-lg bg-input-bg px-2.5 py-1.5 font-mono text-[11px] text-text-secondary focus:outline-none focus:ring-1 focus:ring-accent" />
        <button onClick={() => void copy()} data-testid="group-link-copy" className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-panel-header hover:bg-accent-hover">
          <span role="status">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        <button onClick={() => setShowQr(v => !v)} aria-expanded={showQr} className="rounded px-2 py-1 text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary">{showQr ? "Hide QR" : "Show QR"}</button>
        <button disabled={busy} onClick={() => void run(() => engine.call("enableGroupLink", { groupId: group.id, reset: true }))} data-testid="group-link-reset"
          title="A new link; the current one stops working" className="rounded px-2 py-1 text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-40">New link</button>
        <button disabled={busy} onClick={() => void run(() => engine.call("disableGroupLink", { groupId: group.id }))} data-testid="group-link-disable"
          className="rounded px-2 py-1 text-xs text-danger hover:bg-danger/10 disabled:opacity-40">Turn off</button>
      </div>
      {showQr && <div className="mt-2"><QRCodeDisplay value={url} /></div>}
    </>}
    {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
  </div>;
}
