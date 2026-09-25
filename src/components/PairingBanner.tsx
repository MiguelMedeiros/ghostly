import { useOutsideDismiss } from "../hooks/useDismiss";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { Link } from "react-router-dom";
import type { PairedTransport } from "@ghostly/core";
import { useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { dots, focus, transportName, type ConnectionKind } from "../lib/connection";
import { connectionSummary, lasting } from "../lib/transportEvents";
import { TransportIcon } from "./TransportIcon";
import { TransportOptions } from "./TransportMenu";
import { ConnectionHistory } from "./TransportTimeline";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const snapshot = () => engine.state;
const name = transportName;

const icons: Record<ConnectionKind, ReactNode> = {
  connected: <><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></>,
  dht: <><path d="m3 7 9-4 9 4-9 4Z"/><path d="m3 12 9 4 9-4M3 17l9 4 9-4"/></>,
  waiting: <><circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 1.5"/></>,
  failure: <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/></>,
  offline: <><path d="m18.8 12.3 1.7-1.8a5 5 0 0 0-7-7l-1.7 1.7"/><path d="m5.2 11.7-1.7 1.8a5 5 0 0 0 7 7l1.7-1.7"/><path d="M8 2v3M2 8h3m11 11v3m3-6h3"/></>,
};
export function StateIcon({ kind, size, weight }: { kind: ConnectionKind; size: number; weight: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={weight} strokeLinecap="round" strokeLinejoin="round">{icons[kind]}</svg>;
}

/** Held for an away contact (store-and-forward): a tray with something in it. */
const held = <><path d="M3 13h5l1.5 3h5L16 13h5" /><path d="M5 6h14l2 7v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Z" /><path d="M12 3v7m-2.5-2.5L12 10l2.5-2.5" /></>;

/**
 * The connection at a glance, by shape before colour: live, the transport's own mark (WebRTC, Iroh, HyperDHT);
 * otherwise DHT only, held for the contact, on its way, failed or offline.
 */
export function ConnectionIcon({ kind, transport, holding, size, weight }: { kind: ConnectionKind; transport?: PairedTransport; holding?: boolean; size: number; weight: number }) {
  if (kind === "connected" && transport) return <TransportIcon transport={transport} size={size} weight={weight} />;
  if (holding && kind === "waiting") return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={weight} strokeLinecap="round" strokeLinejoin="round" data-transport-icon="hold">{held}</svg>;
  return <StateIcon kind={kind} size={size} weight={weight} />;
}

/** A compact header control; all delivery choices live inside its popover. */
export function PairingBanner({ peerKey }: { peerKey: string }) {
  const state = useSyncExternalStore(subscribe, snapshot);
  const link = state?.links.find(l => l.peerPubKeyZ32 === peerKey), pair = link?.pairing;
  const [menuOpen, setMenuOpen] = useState(false);
  const nav = useAppNavigation();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [comparing, setComparing] = useState(false);
  const root = useRef<HTMLDetailsElement>(null), trigger = useRef<HTMLElement>(null);
  const id = useId(), online = state?.settings.online ?? true;
  const dht = link?.deliveryMode === "dht", textDht = link?.textDelivery === "dht", ready = online && pair?.status === "ready" && link?.dataLink === "open" && !!pair.transport;
  const connectionFailure = error || pair?.transitionError || (pair?.status === "error" ? pair.error : "") || ((dht || textDht) ? link?.dhtDelivery?.error : "");
  const discoveryFailure = !ready ? link?.discoveryError : "";
  const failure = connectionFailure || discoveryFailure;
  const preferred = link?.preferredTransport ?? "webrtc/1";
  const pinned = !!link?.peerParticipationKey, canCompare = !!pair?.code && !!pair.peerKey && (pair.status === "ready" || pair.status === "waiting");
  const awaitingJoin = !pinned && !pair?.peerKey && link?.dataLink === "idle";
  const label = !online ? "Offline" : connectionFailure ? "Connection issue" : discoveryFailure ? (discoveryFailure.startsWith("Could not publish discovery:") && !discoveryFailure.includes("Could not read discovery:") ? "Publication unavailable" : "Discovery unavailable") : dht ? "DHT only" : textDht ? "DHT · offline text" : pair?.transitionTarget ? `Switching · ${name(pair.transitionTarget)}` : ready ? `Connected · ${name(pair?.transport)}${link?.transportRelayed ? " (relayed)" : ""}` : pair?.status === "confirm" ? "Confirm peer" : awaitingJoin ? "No contact yet" : !link?.peerOnline && link?.dataLink === "idle" ? "Waiting for contact" : "Connecting…";
  const kind: ConnectionKind = !online ? "offline" : failure ? "failure" : dht || textDht ? "dht" : ready && !pair?.transitionTarget ? "connected" : "waiting";
  const connecting = kind === "waiting" && (label === "Connecting…" || !!pair?.transitionTarget);
  // Live, or live and moving to another transport: the transport's own mark, and what it is at a glance.
  const liveOn = ready && !dht && !textDht ? pair?.transport : undefined;
  const iconKind: ConnectionKind = liveOn && !failure ? "connected" : kind;
  const holding = !ready && link?.textDelivery === "hold";
  const summary = liveOn ? connectionSummary(link, Date.now()) : undefined;
  const [tip, setTip] = useState(false);
  const close = () => { if (root.current?.open) { root.current.open = false; trigger.current?.focus(); } };
  useOutsideDismiss(root, menuOpen, close);
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "Could not update delivery."); }
    finally { setBusy(false); }
  }
  // The header shows only the icon: the label is in its tooltip, its accessible name and the popover.
  // `toggle` is queued, and React can take a while to handle it: the click and Escape act at once instead.
  return <div className="relative shrink-0">
  <details ref={root} onToggle={e => setMenuOpen(e.currentTarget.open)} onKeyDown={e => {
    if (e.key !== "Escape") return;
    if (root.current?.open) { e.stopPropagation(); close(); } else if (tip) { e.stopPropagation(); setTip(false); }
  }} className="relative" data-testid="connection-menu">
    <summary ref={trigger} onClick={() => { setTip(false); setMenuOpen(!root.current?.open); }} data-testid="connection-options" data-state={kind} data-transport={liveOn ?? (holding ? "hold" : undefined)} data-relayed={liveOn && link?.transportRelayed ? "" : undefined} aria-label={`Connection options: ${label}`} aria-describedby={`${id}-tip`}
      onPointerEnter={e => { if (e.pointerType !== "touch") setTip(true); }} onPointerLeave={() => setTip(false)}
      onFocus={e => { if (e.currentTarget.matches(":focus-visible")) setTip(true); }} onBlur={() => setTip(false)}
      className={`relative flex cursor-pointer list-none items-center justify-center rounded-full p-2 transition-colors max-md:p-2.5 hover:bg-surface-hover [&::-webkit-details-marker]:hidden ${focus} ${kind === "failure" ? "text-danger" : kind === "offline" ? "text-text-muted hover:text-accent" : "text-text-secondary hover:text-accent"}`}>
      <ConnectionIcon kind={iconKind} transport={liveOn} holding={holding} size={18} weight={2} />
      {dots[kind] && <span aria-hidden="true" data-testid="connection-dot" className={`pointer-events-none absolute right-1 top-1 h-2 w-2 rounded-full ring-2 ring-panel-header max-md:right-1.5 max-md:top-1.5 ${dots[kind]} ${connecting ? "motion-safe:animate-pulse" : ""}`} />}
    </summary>
    <div role="dialog" aria-label="Connection options" className="absolute right-0 top-full max-md:fixed max-md:inset-x-2 max-md:top-[calc(3.5rem_+_env(safe-area-inset-top))] max-md:w-auto z-40 mt-2 w-[min(20rem,calc(100vw-1rem))] max-h-[70dvh] overflow-y-auto rounded-xl border border-border bg-panel-header p-4 text-xs leading-5 text-text-muted shadow-xl">
      <div className="flex items-center gap-2 font-medium text-text-primary" data-testid="connection-state">
        <ConnectionIcon kind={iconKind} transport={liveOn} holding={holding} size={16} weight={1.7} />
        <span>{label}</span>
      </div>
      {summary && <dl data-testid="connection-summary" className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
        <dt>Transport</dt><dd className="text-text-primary">{summary.name}</dd>
        {summary.relays && <><dt>Path</dt><dd data-testid="connection-relayed" className="text-text-primary break-words">Relayed{summary.relays.length ? ` via ${summary.relays.join(", ")}` : ""}</dd></>}
        {summary.rttMs !== undefined && <><dt>Round trip</dt><dd className="text-text-primary">{summary.rttMs} ms</dd></>}
        {summary.since !== undefined && <><dt>Live since</dt><dd className="text-text-primary">{new Date(summary.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} ({lasting(Date.now() - summary.since)})</dd></>}
        <dt>Why</dt><dd className="text-text-primary">{summary.why}</dd>
      </dl>}
      {failure && <p role="alert" className="mt-2 break-words text-danger">{failure}</p>}
      {discoveryFailure && <p className="mt-2 text-[11px]" data-testid="discovery-help">{awaitingJoin && "No contact yet. "}Discovery will retry automatically. You can still share this invite or choose a delivery mode. If this persists, check your internet connection or <Link className={`text-accent underline ${focus}`} to="/settings" onClick={(e) => { e.preventDefault(); nav.open("/settings"); }}>review relay settings</Link>. DHT-only also needs discovery.</p>}
      {!dht && ready && preferred !== pair?.transport && <p className="mt-1 text-[11px]">Preferred: {name(preferred)}</p>}
      <label className="connection-switch-row mt-3 flex min-h-11 items-center justify-between gap-3 rounded-lg bg-surface-hover px-2.5">
        <span className="flex items-center gap-2 text-text-primary"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m3 7 9-4 9 4-9 4Z M3 12l9 4 9-4 M3 17l9 4 9-4"/></svg>DHT only</span>
        <span className="connection-switch"><input type="checkbox" role="switch" aria-label="DHT-only delivery" aria-checked={dht} checked={dht} disabled={busy || !online || !link}
          onChange={e => link && void run(() => engine.call("setDeliveryMode", { linkId: link.id, mode: e.target.checked ? "dht" : "stream" }))} /><span className="connection-switch-track" aria-hidden="true" /></span>
      </label>
      <fieldset disabled={busy || !online || dht} className="mt-3">
        <legend className="mb-1 text-[11px]">{dht ? "Turn off DHT-only to choose a connection" : "Connection"}</legend>
        {link && <TransportOptions link={link} disabled={busy || !online} />}
        <label className="connection-switch-row mt-2 flex min-h-11 items-center justify-between gap-2 rounded-lg px-2.5"><span className="text-text-primary">Fallback</span>
          <span className="connection-switch"><input type="checkbox" role="switch" aria-label="Fallback" aria-checked={link?.transportFallback??true} checked={link?.transportFallback??true} disabled={!link}
            onChange={e => link && void run(() => engine.call("setTransportPreference", {linkId:link.id,preferred,fallback:e.target.checked}))} /><span className="connection-switch-track" aria-hidden="true" /></span>
        </label>
      </fieldset>
      {!dht && Object.entries(link?.transportErrors ?? {}).map(([t,reason]) => <p key={t} className="mt-1 text-[11px]">{name(t as PairedTransport)}: {reason}</p>)}
      {(pinned || pair?.keyMismatch) && <div className="mt-2 border-t border-border pt-2" data-testid="pair-trust">
        {pair?.keyMismatch ? <p role="alert" className="text-danger">This key does not match the saved contact. No data was accepted; the saved key has not been replaced.</p> : <>
          <div className="flex min-h-9 items-center justify-between gap-2">
            <span data-testid={link?.peerVerified ? "pair-verified" : undefined} className={`flex items-center gap-1.5 ${link?.peerVerified ? "text-accent" : "text-text-secondary"}`}>
              <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/>{link?.peerVerified && <path d="m8 12 3 3 5-6"/>}</svg>
              {link?.peerVerified ? "Codes verified" : "Key saved · not verified"}
            </span>
            {!link?.peerVerified && canCompare && !comparing && <button data-testid="pair-verify" aria-label="Verify this contact" className={`min-h-9 rounded-md px-2 text-accent hover:bg-surface-hover ${focus}`} onClick={()=>setComparing(true)}>Verify</button>}
          </div>
          {comparing && canCompare && !link?.peerVerified && <div className="rounded-lg bg-surface-hover p-3">
            <code data-testid="pair-code" className="block select-all break-words text-sm tracking-widest text-text-primary">{pair?.code}</code>
            <p className="mt-1 text-[11px]">Compare this code with your contact somewhere you trust.</p>
            <button data-testid="pair-verify-confirm" disabled={busy} className={`mt-2 min-h-9 rounded-lg bg-accent px-3 text-panel-header ${focus}`}
              onClick={() => link && pair?.code && void run(async () => {await engine.call("confirmPair", {linkId:link.id,code:pair.code!});setComparing(false);})}>The codes match</button>
          </div>}
        </>}
      </div>}
      {!!link?.transportHistory?.length && <ConnectionHistory events={link.transportHistory} contact={link.peerNick || "Your contact"} />}
      <div className="mt-1 flex items-start justify-between gap-2 border-t border-border pt-1">
        <details className="min-w-0 flex-1 text-[11px]" data-testid="connection-details">
          <summary className={`w-fit cursor-pointer rounded-md py-2 pr-2 text-text-secondary ${focus}`}>Details</summary>
          <div className="space-y-2 pb-2">
            <p>Fallback uses another live method only when both contacts allow it. Offline text can use encrypted DHT delivery separately.</p>
            {pair?.transitionTarget && <p>Preparing {name(pair.transitionTarget)}; current channel: {name(pair.transport)}.</p>}
            {!dht && !textDht && link?.dhtDelivery?.error && <p>Offline text: {link.dhtDelivery.error}</p>}
            {pinned && !pair?.keyMismatch && <p>{link?.peerVerified ? "You compared codes with this contact. The key is pinned and unchanged." : "Authenticated and pinned on first use. You have not compared codes with your contact yet."}</p>}
      {(dht || textDht) && <div className="mt-2 text-[11px]" data-testid="dht-delivery-details">
        <p>Encrypted text, no direct connection. Up to {link?.dhtDelivery?.maxTextBytes ?? 256} UTF-8 bytes; one text awaiting a receipt. Valid for 5 minutes, with up to 8 publish attempts.</p>
        <p className="mt-1">Availability is not guaranteed. Published is not received. Files, sats, calls and web services require a live method.</p>
        {!link?.dhtDelivery?.authenticated && <p className="mt-1">Waiting for an authenticated DHT-capable contact. Older clients need an update.</p>}
        {link?.dhtDelivery?.pendingUntil && <p className="mt-1">Receipt pending until {new Date(link.dhtDelivery.pendingUntil).toLocaleTimeString()}.</p>}
      </div>}
          </div>
        </details>
        {!dht && !ready && !awaitingJoin && online && link && <button className={`min-h-9 shrink-0 rounded-md px-2 text-accent hover:bg-surface-hover disabled:opacity-40 ${focus}`} disabled={busy}
          onClick={() => void run(() => engine.call("connect", {linkId:link.id}))}>Reconnect</button>}
      </div>
    </div>
  </details>
  <span role="tooltip" id={`${id}-tip`} data-testid="connection-tooltip" className={`pointer-events-none absolute right-0 top-full z-50 mt-1.5 w-max max-w-[min(16rem,55vw)] rounded-md border border-border bg-surface-alt px-2 py-1 text-[11px] leading-4 text-text-primary shadow-lg motion-safe:transition-opacity ${tip && !menuOpen ? "opacity-100" : "invisible opacity-0"}`}>
    {label}{summary && !failure && <span data-testid="connection-tooltip-detail" className="mt-0.5 block text-text-secondary">{summary.detail}</span>}
    {failure && failure !== label && <span className="mt-0.5 block break-words text-danger">{failure}</span>}
  </span>
  <span className="sr-only" aria-live="polite">{label}</span>
  </div>;
}
