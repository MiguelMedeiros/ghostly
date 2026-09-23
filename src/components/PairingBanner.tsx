import { useOutsideDismiss } from "../hooks/useDismiss";
import { Link } from "react-router-dom";
import type { PairedTransport } from "@ghostly/core";
import { useId, useRef, useState, useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const snapshot = () => engine.state;
const name = (transport?: PairedTransport) => transport === "iroh/1" ? "Iroh" : transport === "hyperdht/1" ? "HyperDHT" : "WebRTC";
const focus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** A compact header control; all delivery choices live inside its popover. */
export function PairingBanner({ peerKey }: { peerKey: string }) {
  const state = useSyncExternalStore(subscribe, snapshot);
  const link = state?.links.find(l => l.peerPubKeyZ32 === peerKey), pair = link?.pairing;
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [comparing, setComparing] = useState(false);
  const root = useRef<HTMLDetailsElement>(null), trigger = useRef<HTMLElement>(null);
  const id = useId(), online = state?.settings.online ?? true;
  const dht = link?.deliveryMode === "dht", textDht = link?.textDelivery === "dht", ready = online && pair?.status === "ready" && link?.dataLink === "open" && !!pair.transport;
  const connectionFailure = error || pair?.transitionError || (pair?.status === "error" ? pair.error : "") || ((dht || textDht) ? link?.dhtDelivery?.error : "");
  const discoveryFailure = !ready ? link?.discoveryError : "";
  const failure = connectionFailure || discoveryFailure;
  const available = link?.availableTransports ?? [], preferred = link?.preferredTransport ?? "webrtc/1";
  const pinned = !!link?.peerParticipationKey, canCompare = !!pair?.code && !!pair.peerKey && (pair.status === "ready" || pair.status === "waiting");
  const awaitingJoin = !pinned && !pair?.peerKey && link?.dataLink === "idle";
  const label = !online ? "Offline" : connectionFailure ? "Connection issue" : discoveryFailure ? (discoveryFailure.startsWith("Could not publish discovery:") && !discoveryFailure.includes("Could not read discovery:") ? "Publication unavailable" : "Discovery unavailable") : dht ? "DHT only" : textDht ? "DHT · offline text" : pair?.transitionTarget ? `Switching · ${name(pair.transitionTarget)}` : ready ? `Connected · ${name(pair?.transport)}` : pair?.status === "confirm" ? "Confirm peer" : awaitingJoin ? "No contact yet" : !link?.peerOnline && link?.dataLink === "idle" ? "Waiting for contact" : "Connecting…";
  const close = () => { if (root.current?.open) { root.current.open = false; trigger.current?.focus(); } };
  useOutsideDismiss(root, menuOpen, close);
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "Could not update delivery."); }
    finally { setBusy(false); }
  }
  // `toggle` is queued, and React can take a while to handle it: the click and Escape act at once instead.
  return <details ref={root} onToggle={e => setMenuOpen(e.currentTarget.open)} onKeyDown={e => { if (e.key === "Escape" && root.current?.open) { e.stopPropagation(); close(); } }} className="relative shrink-0" data-testid="connection-menu">
    <summary ref={trigger} onClick={() => setMenuOpen(!root.current?.open)} data-testid="connection-options" aria-label={`Connection options: ${label}`} title={failure || label}
      className={`flex h-9 max-w-40 cursor-pointer list-none items-center gap-1.5 rounded-lg px-2 text-[11px] hover:bg-surface-hover [&::-webkit-details-marker]:hidden ${focus} ${failure ? "text-danger" : ready && !dht ? "text-accent" : "text-text-secondary"}`}>
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {failure ? <><path d="m12 3 10 18H2Z"/><path d="M12 9v5m0 3h.01"/></> : dht || textDht ? <><path d="m3 7 9-4 9 4-9 4Z"/><path d="m3 12 9 4 9-4M3 17l9 4 9-4"/></> : ready ? <><circle cx="6" cy="12" r="3"/><circle cx="18" cy="12" r="3"/><path d="M9 12h6"/></> : <><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></>}
      </svg>
      <span className="max-sm:sr-only truncate" aria-live="polite">{dht || textDht || failure || !ready || pair?.transitionTarget ? label : name(pair?.transport)}</span>
    </summary>
    <div role="dialog" aria-label="Connection options" className="absolute right-0 top-full max-md:fixed max-md:inset-x-2 max-md:top-[calc(3.5rem_+_env(safe-area-inset-top))] max-md:w-auto z-40 mt-2 w-[min(20rem,calc(100vw-1rem))] max-h-[70dvh] overflow-y-auto rounded-xl border border-border bg-panel-header p-4 text-xs leading-5 text-text-muted shadow-xl">
      <div className="flex items-center gap-2 font-medium text-text-primary" aria-live="polite">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">{failure ? <><path d="m12 3 10 18H2Z M12 9v5m0 3h.01"/></> : dht || textDht ? <path d="m3 7 9-4 9 4-9 4Z M3 12l9 4 9-4 M3 17l9 4 9-4"/> : <><circle cx="6" cy="12" r="3"/><circle cx="18" cy="12" r="3"/><path d="M9 12h6"/></>}</svg>
        <span>{label}</span>
      </div>
      {failure && <p role="alert" className="mt-2 break-words text-danger">{failure}</p>}
      {discoveryFailure && <p className="mt-2 text-[11px]" data-testid="discovery-help">{awaitingJoin && "No contact yet. "}Discovery will retry automatically. You can still share this invite or choose a delivery mode. If this persists, check your internet connection or <Link className={`text-accent underline ${focus}`} to="/settings">review relay settings</Link>. DHT-only also needs discovery.</p>}
      {!dht && ready && preferred !== pair?.transport && <p className="mt-1 text-[11px]">Preferred: {name(preferred)}</p>}
      <label className="connection-switch-row mt-3 flex min-h-11 items-center justify-between gap-3 rounded-lg bg-surface-hover px-2.5">
        <span className="flex items-center gap-2 text-text-primary"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m3 7 9-4 9 4-9 4Z M3 12l9 4 9-4 M3 17l9 4 9-4"/></svg>DHT only</span>
        <span className="connection-switch"><input type="checkbox" role="switch" aria-label="DHT-only delivery" aria-checked={dht} checked={dht} disabled={busy || !online || !link}
          onChange={e => link && void run(() => engine.call("setDeliveryMode", { linkId: link.id, mode: e.target.checked ? "dht" : "stream" }))} /><span className="connection-switch-track" aria-hidden="true" /></span>
      </label>
      <fieldset disabled={busy || !online || dht} className="mt-3">
        <legend className="mb-1 text-[11px]">{dht ? "Turn off DHT-only to choose a connection" : "Connection"}</legend>
        <div className="flex gap-1">
          {(["webrtc/1", "iroh/1", "hyperdht/1"] as const).map(t => <label key={t} title={link?.transportErrors?.[t] || (!available.includes(t) ? "Not available in this client" : name(t))}
            className={`relative flex min-h-9 flex-1 items-center justify-center gap-1 rounded-lg border px-1 ${preferred === t ? "border-accent/40 text-text-primary" : "border-border"} ${dht || !available.includes(t) ? "opacity-50" : "cursor-pointer hover:bg-surface-hover"}`}>
            <input className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0" type="radio" name={`${id}-transport`} aria-label={name(t)} checked={preferred === t} disabled={!available.includes(t)}
              onClick={() => { if (preferred === t && pair?.transport !== t && link) void run(() => engine.call("setTransportPreference", {linkId:link.id,preferred:t,fallback:link.transportFallback??true})); }}
              onChange={() => link && void run(() => engine.call("setTransportPreference", {linkId:link.id,preferred:t,fallback:link.transportFallback??true}))} />
            <span className="pointer-events-none flex items-center gap-1 rounded peer-focus-visible:ring-2 peer-focus-visible:ring-accent"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">{t === "webrtc/1" ? <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/></> : t === "iroh/1" ? <><circle cx="5" cy="12" r="3"/><circle cx="19" cy="12" r="3"/><path d="M8 12h8"/></> : <><circle cx="12" cy="4" r="2"/><circle cx="4" cy="19" r="2"/><circle cx="20" cy="19" r="2"/><path d="m11 6-6 11m8-11 6 11M6 19h12"/></>}</svg>{name(t)}</span>
          </label>)}
        </div>
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
  </details>;
}
