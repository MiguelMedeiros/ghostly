import { useOutsideDismiss } from "../hooks/useDismiss";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { useCopyKey } from "../hooks/useCopyKey";
import { Link } from "react-router-dom";
import type { PairedTransport } from "@ghostly/core";
import { useId, useRef, useState, useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { focus, transportName, type ConnectionKind } from "../lib/connection";
import { connectionSummary, lasting, transportWaitText } from "../lib/transportEvents";
import { publicKeyLabel } from "../lib/publicKeyLabel";
import { ConnectionIcon } from "./ConnectionIcon";
import { TransportOptions } from "./TransportOptions";
import { ConnectionHistory } from "./TransportTimeline";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const snapshot = () => engine.state;
const name = transportName;

/** The status dot's colour, by the contact's status (`contactStatus`): connected, a problem, or anything else. */
const dotTone = (status: string, polling: boolean) => /^Connected/.test(status) ? `bg-green-500 ${polling ? "contact-fetch-pulse" : ""}`
  : /issue|unavailable|mismatch/.test(status) ? "bg-danger" : "bg-text-muted";

/**
 * The chat's one connection control, under its name: the contact's status dot and key, then what carries the chat
 * (the transport in use and its round trip) or its state ("Waiting for contact", "DHT only · chosen by you"). While a
 * first pairing is on its way the pairing indicator beside it tells that story (`compact`). One panel holds the rest:
 * what is in use and what is chosen, which are not always the same, the choice itself (Automatic, a transport or DHT
 * only) and Fallback, what the chat waits for, contact verification, both keys, and the connection history.
 * A chat made with a v0.4 code (`paired` false) has no choices: its status and the keys.
 */
export function ChatConnection({ peerKey, paired = true, myKey, status, polling = false, compact = false }: {
  peerKey: string;
  paired?: boolean;
  /** This side's key in the chat. */
  myKey?: string;
  /** The contact's status (`contactStatus`): the dot's colour and name. Without it, the connection's own label. */
  status?: string;
  /** A DHT read on its way: a connected dot pulses once. */
  polling?: boolean;
  compact?: boolean;
}) {
  const state = useSyncExternalStore(subscribe, snapshot);
  const link = paired ? state?.links.find(l => l.peerPubKeyZ32 === peerKey) : undefined, pair = link?.pairing;
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
  const automatic = link?.transportAutomatic ?? link?.preferredTransport === undefined;
  const local = link?.availableTransports ?? [];
  const pinned = !!link?.peerParticipationKey, canCompare = !!pair?.code && !!pair.peerKey && (pair.status === "ready" || pair.status === "waiting");
  const awaitingJoin = !pinned && !pair?.peerKey && link?.dataLink === "idle";
  const contact = link?.peerNick || "Your contact";
  // A chosen transport not reached yet (WISP 100): waited for, never a connection issue. `waitOff`: nothing else may
  // carry the chat meanwhile (Fallback off), so it is on the DHT; otherwise it stays live where it is.
  const wait = !dht ? link?.transportWait : undefined, waitOff = !!wait && !wait.live;
  const waitText = wait ? transportWaitText(wait, contact) : undefined;
  const label = !paired ? status ?? "Connecting" : !online ? "Offline" : connectionFailure ? "Connection issue" : discoveryFailure ? (discoveryFailure.startsWith("Could not publish discovery:") && !discoveryFailure.includes("Could not read discovery:") ? "Publication unavailable" : "Discovery unavailable") : dht ? "DHT only · chosen by you" : textDht && link?.dhtDelivery?.peerMode === "dht" ? "DHT only · chosen by your contact" : waitOff && pair?.transitionTarget ? `Switching · ${name(pair.transitionTarget)}` : waitOff ? `${textDht ? "On DHT · waiting" : "Waiting"} for ${name(wait.transport)}` : textDht ? "On DHT · retrying live" : pair?.transitionTarget ? `Switching · ${name(pair.transitionTarget)}` : ready ? `Connected · ${name(pair?.transport)}${link?.transportRelayed ? " (relayed)" : ""}` : pair?.status === "confirm" ? "Confirm peer" : awaitingJoin ? "No contact yet" : !link?.peerOnline && link?.dataLink === "idle" ? "Waiting for contact" : "Connecting…";
  const kind: ConnectionKind = !paired ? (/^Connected/.test(label) ? "connected" : /issue|unavailable|mismatch/.test(label) ? "failure" : label === "Offline" ? "offline" : "waiting")
    : !online ? "offline" : failure ? "failure" : waitOff && (pair?.transitionTarget || !textDht) ? "waiting" : dht || textDht ? "dht" : ready && !pair?.transitionTarget ? "connected" : "waiting";
  const connecting = kind === "waiting" && (label === "Connecting…" || !!pair?.transitionTarget);
  // Live, or live and moving to another transport: the transport's own mark, and what it is at a glance.
  const liveOn = ready && !dht && !textDht ? pair?.transport : undefined;
  const iconKind: ConnectionKind = liveOn && !failure ? "connected" : kind;
  const holding = !ready && link?.textDelivery === "hold";
  const summary = liveOn ? connectionSummary(link, Date.now()) : undefined;
  const moving = liveOn ? pair?.transitionTarget : undefined;
  // Beside the key: what carries the chat now and its round trip, or the state.
  const shown = paired && !compact;
  const now = liveOn && !failure && !moving ? `${name(liveOn)}${link?.transportRelayed ? " · relayed" : ""}` : label;
  const rtt = liveOn && !failure && !moving ? link?.transportRttMs : undefined;
  const dot = status ?? label;
  // What is in use and what is chosen, said apart: a chat set to WebRTC may be live over Iroh (Fallback on). The round
  // trip has its own line below.
  const inUse = !online ? "Nothing · this device is offline"
    : liveOn ? `${name(liveOn)}${link?.transportRelayed ? " · relayed" : ""}${moving ? ` · moving to ${name(moving)}` : ""}`
    : dht || textDht ? "The DHT, for short texts · nothing live"
    : holding ? `Nothing live · messages wait for ${contact}` : "Nothing live";
  const chosen = dht ? "DHT only"
    : local.length <= 1 ? `${name(local[0])} · the only one this app runs`
    : automatic ? "Automatic"
    : `${name(preferred)} · ${liveOn === preferred ? "in use" : wait?.transport === preferred ? "waiting for it" : "not in use"}`;
  const [tip, setTip] = useState(false);
  const close = () => { if (root.current?.open) { root.current.open = false; trigger.current?.focus(); } };
  useOutsideDismiss(root, menuOpen, close);
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "Could not update delivery."); }
    finally { setBusy(false); }
  }
  // `toggle` is queued, and React can take a while to handle it: the click and Escape act at once instead.
  // The negative margin lines the dot up with the name above; on the summary, it would cut its own text by as much.
  return <div className="relative -ms-1 min-w-0">
  <details ref={root} onToggle={e => setMenuOpen(e.currentTarget.open)} onKeyDown={e => {
    if (e.key !== "Escape") return;
    if (root.current?.open) { e.stopPropagation(); close(); } else if (tip) { e.stopPropagation(); setTip(false); }
  }} className="min-w-0" data-testid="connection-menu">
    <summary ref={trigger} onClick={() => { setTip(false); setMenuOpen(!root.current?.open); }} data-testid="connection-options" data-state={kind} data-transport={liveOn ?? (holding ? "hold" : undefined)} data-relayed={liveOn && link?.transportRelayed ? "" : undefined} aria-label={`Connection options: ${label}`} aria-describedby={`${id}-tip`}
      onPointerEnter={e => { if (e.pointerType !== "touch") setTip(true); }} onPointerLeave={() => setTip(false)}
      onFocus={e => { if (e.currentTarget.matches(":focus-visible")) setTip(true); }} onBlur={() => setTip(false)}
      className={`flex min-h-7 min-w-0 max-w-full cursor-pointer list-none items-center gap-1.5 rounded-md px-1 text-xs leading-none transition-colors hover:bg-surface-hover max-md:min-h-8 [&::-webkit-details-marker]:hidden ${focus}`}>
      <span role="img" aria-label={dot} data-testid="contact-status"
        className={`h-2 w-2 shrink-0 rounded-full ${dotTone(dot, polling)} ${connecting && !/^Connected/.test(dot) ? "motion-safe:animate-pulse" : ""}`} />
      <span data-testid="connection-key" className={`whitespace-nowrap font-mono text-text-muted/60 max-md:text-[10px] ${shown || compact ? "max-md:hidden" : ""}`}>{publicKeyLabel(peerKey)}</span>
      {shown && <>
        <span aria-hidden="true" className="text-text-muted/40 max-md:hidden">·</span>
        <span data-testid="connection-now" className={`flex min-w-0 items-center gap-1 ${kind === "failure" ? "text-danger" : "text-text-secondary"}`}>
          <ConnectionIcon kind={iconKind} transport={liveOn} holding={holding} size={13} weight={1.8} />
          <span className={`truncate ${moving ? "motion-safe:animate-pulse" : ""}`}>{now}</span>
          {rtt !== undefined && <span className="shrink-0 whitespace-nowrap text-text-muted">· {rtt} ms</span>}
        </span>
      </>}
      {/* On a phone beside the pairing indicator, the dot alone: the indicator's tooltip needs the width. */}
      <svg aria-hidden="true" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 text-text-muted ${compact ? "max-md:hidden" : ""}`}><path d="m6 9 6 6 6-6" /></svg>
    </summary>
    <div role="dialog" aria-label="Connection options" className="absolute start-0 top-full max-md:fixed max-md:inset-x-2 max-md:top-[calc(3.5rem_+_env(safe-area-inset-top))] max-md:w-auto z-40 mt-2 w-[min(22rem,calc(100vw-1rem))] max-h-[70dvh] overflow-y-auto rounded-xl border border-border bg-panel-header p-4 text-xs leading-5 text-text-muted shadow-xl">
      <div className="flex items-center gap-2 font-medium text-text-primary" data-testid="connection-state">
        <ConnectionIcon kind={iconKind} transport={liveOn} holding={holding} size={16} weight={1.7} />
        <span>{label}</span>
      </div>
      {paired && <dl data-testid="connection-in-use-chosen" className="mt-2 grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-0.5 text-[11px]">
        <dt>In use</dt><dd data-testid="connection-in-use" className="min-w-0 break-words text-text-primary">{inUse}</dd>
        <dt>Chosen</dt><dd data-testid="connection-chosen" className="min-w-0 break-words text-text-primary">{chosen}</dd>
      </dl>}
      {summary && <dl data-testid="connection-summary" className="mt-0.5 grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-0.5 text-[11px]">
        {summary.relays && <><dt>Path</dt><dd data-testid="connection-relayed" className="min-w-0 text-text-primary break-words">Relayed{summary.relays.length ? ` via ${summary.relays.join(", ")}` : ""}</dd></>}
        {summary.rttMs !== undefined && <><dt>Round trip</dt><dd className="text-text-primary">{summary.rttMs} ms</dd></>}
        {summary.since !== undefined && <><dt>Live since</dt><dd className="text-text-primary">{new Date(summary.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} ({lasting(Date.now() - summary.since)})</dd></>}
        <dt>Why</dt><dd className="min-w-0 break-words text-text-primary">{summary.why}</dd>
      </dl>}
      {failure && <p role="alert" className="mt-2 break-words text-danger">{failure}</p>}
      {wait && waitText && <div data-testid="connection-waiting" data-reason={wait.reason} data-transport={wait.transport} className="mt-2 rounded-lg bg-surface-hover px-2.5 py-2 text-[11px] leading-4">
        <p className="font-medium text-text-primary">{waitText.label}</p>
        <p className="mt-0.5 break-words" data-testid="connection-waiting-why">{waitText.why}</p>
        <p className="mt-0.5">{waitText.meanwhile}</p>
        {waitText.automatic && link && <button type="button" data-testid="connection-waiting-automatic" disabled={busy || !online}
          className={`mt-1.5 min-h-9 rounded-md px-2 text-accent hover:bg-surface disabled:opacity-40 ${focus}`}
          onClick={() => void run(() => engine.call("setChatTransport", { linkId: link.id, transport: "auto" }))}>Use Automatic</button>}
      </div>}
      {discoveryFailure && <p className="mt-2 text-[11px]" data-testid="discovery-help">{awaitingJoin && "No contact yet. "}Discovery will retry automatically. You can still share this invite or choose a delivery mode. If this persists, check your internet connection or <Link className={`text-accent underline ${focus}`} to="/settings" onClick={(e) => { e.preventDefault(); nav.open("/settings"); }}>review relay settings</Link>. DHT-only also needs discovery.</p>}
      {paired && <fieldset disabled={busy || !online || !link} className="mt-3">
        <legend className="mb-1 text-[11px]">Connection</legend>
        {link && <TransportOptions link={link} disabled={busy || !online}
          onChoose={choice => void run(() => engine.call("setChatTransport", { linkId: link.id, transport: choice }))} />}
        <label className="connection-switch-row mt-2 flex min-h-11 items-center justify-between gap-2 rounded-lg px-2.5"><span className="text-text-primary">Fallback</span>
          <span className="connection-switch"><input type="checkbox" role="switch" aria-label="Fallback" aria-checked={link?.transportFallback??true} checked={link?.transportFallback??true} disabled={!link || dht}
            onChange={e => link && void run(() => engine.call("setTransportPreference", {linkId:link.id,preferred,fallback:e.target.checked}))} /><span className="connection-switch-track" aria-hidden="true" /></span>
        </label>
      </fieldset>}
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
      <dl data-testid="connection-keys" className="mt-2 space-y-1 border-t border-border pt-2 text-[11px]">
        {(myKey || link?.myPubKeyZ32) && <KeyRow label="You" value={(myKey || link?.myPubKeyZ32)!} testId="connection-key-you" />}
        <KeyRow label="Contact" value={peerKey} testId="connection-key-contact" />
      </dl>
      {!!link?.transportHistory?.length && <ConnectionHistory events={link.transportHistory} contact={contact} />}
      {paired && <div className="mt-1 flex items-start justify-between gap-2 border-t border-border pt-1">
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
      </div>}
    </div>
  </details>
  <span role="tooltip" id={`${id}-tip`} data-testid="connection-tooltip" className={`pointer-events-none absolute start-0 top-full z-50 mt-1.5 w-max max-w-[min(16rem,55vw)] rounded-md border border-border bg-surface-alt px-2 py-1 text-[11px] leading-4 text-text-primary shadow-lg motion-safe:transition-opacity ${tip && !menuOpen ? "opacity-100" : "invisible opacity-0"}`}>
    {label}{summary && !failure && <span data-testid="connection-tooltip-detail" className="mt-0.5 block text-text-secondary">{summary.detail}</span>}
    {failure && failure !== label && <span className="mt-0.5 block break-words text-danger">{failure}</span>}
  </span>
  <span className="sr-only" aria-live="polite">{label}</span>
  </div>;
}

/** A key in full, copied by a click, as the chat's Tech Info has it. */
function KeyRow({ label, value, testId }: { label: string; value: string; testId: string }) {
  const { copied, copy } = useCopyKey(value);
  return (
    <div className="grid grid-cols-[5.5rem_1fr] gap-x-3">
      <dt>{label}</dt>
      <dd className="min-w-0">
        <button type="button" data-testid={testId} onClick={copy} title="Click to copy" aria-label={`${label}: ${value}. Copy`}
          className={`break-all rounded bg-transparent p-0 text-start font-mono transition-colors hover:text-accent ${copied ? "text-accent" : "text-text-secondary"} ${focus}`}>
          {copied ? "Copied!" : value}
        </button>
      </dd>
    </div>
  );
}
