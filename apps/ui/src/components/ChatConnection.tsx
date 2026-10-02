import { useOutsideDismiss } from "../hooks/useDismiss";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { useCopyKey } from "../hooks/useCopyKey";
import { Link } from "react-router-dom";
import type { PairedTransport } from "@ghostly/core";
import { useId, useRef, useState, useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { dots, focus, transportName, type ConnectionKind } from "../lib/connection";
import { connectionSummary, lasting, liveAttemptText, transportWaitText } from "../lib/transportEvents";
import { clockTime, formatAt } from "../lib/time";
import { ConnectionIcon } from "./ConnectionIcon";
import { PairingGlyph } from "./pairing/PairingGlyph";
import { usePairingWords } from "./pairing/words";
import { useI18n } from "../contexts/I18nContext";
import { statusWords } from "../lib/contactStatus";
import { useNow, type PairingProgressState } from "../hooks/usePairingProgress";
import { PAIRING_STEPS, SLOW_AFTER_MS, failureReason, formatElapsed } from "../lib/pairingProgress";
import { TransportOptions } from "./TransportOptions";
import { ConnectionHistory } from "./TransportTimeline";
import { DiscoveryHealth } from "./DiscoveryHealth";
import { DirectBlockedHint } from "./DirectBlockedHint";
import { errorText } from "../lib/errorText";
import { useWindowAway } from "../lib/windowAway";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const snapshot = () => engine.state;
const name = transportName;

/** What the connection's label says, before it is put in words: the icon's kind is read from it, not from the words. */
type LabelState = "status" | "offline" | "issue" | "publication" | "discovery" | "dhtByYou" | "dhtByContact" | "switching" | "dhtWaiting"
  | "waiting" | "onDht" | "connected" | "confirm" | "pairing" | "noContact" | "waitingContact" | "connecting";


/**
 * The chat's one connection control, beside the call buttons: an icon, by shape before colour (the transport's own
 * mark when live; otherwise DHT only, held for the contact, on its way, failed or offline), its state in the tooltip
 * and the accessible name. Its panel is short: the state and round trip, the choice (Automatic, a transport or DHT
 * only; the checked one is chosen, the one in use is marked, and they are not always the same), and Fallback. The rest
 * is under Details: what the chat waits for, discovery help, how contacts are found (the DHT directly or a relay) and
 * each relay's health, the live path and why, per-transport errors, contact verification, both keys, the connection
 * history and notes. A chat made with a v0.4 code (`paired` false) has no choices: its status (`status`, as
 * `contactStatus` says it) and the keys.
 *
 * It is the header's only connection element: while a first pairing is on its way (`pairing`), the icon is the
 * pairing scene in small, its name says the stage, and the panel says how far it got, with a way to the scene.
 */
export function ChatConnection({ peerKey, paired = true, myKey, status, pairing }: {
  peerKey: string;
  paired?: boolean;
  /** This side's key in the chat. */
  myKey?: string;
  /** The contact's status (`contactStatus`): what a v0.4-code chat's icon and panel say, and `data-status` for any chat. */
  status?: string;
  /** A first pairing not live yet (`usePairingProgress`), and how to bring its scene into view, while there is one. */
  pairing?: { progress: PairingProgressState; onShow?(): void };
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
  const pinned = !!link?.peerParticipationKey, canCompare = !!pair?.code && !!pair.peerKey && (pair.status === "ready" || pair.status === "waiting");
  const awaitingJoin = !pinned && !pair?.peerKey && link?.dataLink === "idle";
  const { t, language } = useI18n();
  const clock = (at: number) => clockTime(at, language);
  const contact = link?.peerNick || t("pairing.contact");
  // A chosen transport not reached yet (WISP 100): waited for, never a connection issue. `waitOff`: nothing else may
  // carry the chat meanwhile (Fallback off), so it is on the DHT; otherwise it stays live where it is.
  const wait = !dht ? link?.transportWait : undefined, waitOff = !!wait && !wait.live;
  const waitText = wait ? transportWaitText(wait, contact, clock, t) : undefined;
  // Why a pinned chat is not live (WISP 100): what the last attempt tried, or that the contact's app dials. Not for DHT only.
  const notLive = paired && pinned && !dht && !ready ? liveAttemptText(link?.liveAttempt, link?.liveDialer, contact, clock, t) : undefined;
  const words = usePairingWords();
  // A first pairing on its way: its stage names the connection until the chat is live, on the DHT or failed.
  const progress = paired ? pairing?.progress : undefined, stage = progress?.stage;
  const pairingOn = !!progress && stage !== "live" && stage !== "on-dht" && stage !== "failed";
  const pairingFailed = stage === "failed";
  const ticking = pairingOn && online;
  // The clock of a pairing's stage ticks for someone looking: not while the window is hidden or behind others.
  const away = useWindowAway();
  const now = useNow(ticking && !away);
  // `now` only ticks; a stage that began after its last tick still reads from the clock.
  const inStage = progress ? Math.max(0, Math.max(now, Date.now()) - progress.since) : 0;
  const stageWords = progress ? words.stage(progress.stage, progress.role, progress.peerSeen) : "";
  const slow = ticking && inStage >= SLOW_AFTER_MS[stage!] ? words.slow(stage!, progress?.peerSeen) : "";
  const pairingReason = pairingFailed ? words.reason(failureReason(progress?.reason)) : "";
  const onDhtWhy = stage === "on-dht" ? words.onDht(progress?.reason) : "";
  const steps = progress ? PAIRING_STEPS[progress.role] : [];
  const step = pairingOn ? steps.indexOf(stage!) + 1 : 0;
  const pairingLabel = t("pairing.indicator", { stage: stageWords });
  const labelState: LabelState = !paired ? "status" : !online ? "offline" : connectionFailure ? "issue"
    : discoveryFailure ? (discoveryFailure.startsWith("Could not publish discovery:") && !discoveryFailure.includes("Could not read discovery:") ? "publication" : "discovery")
    : dht ? "dhtByYou" : textDht && link?.dhtDelivery?.peerMode === "dht" ? "dhtByContact"
    : waitOff && pair?.transitionTarget ? "switching" : waitOff ? (textDht ? "dhtWaiting" : "waiting") : textDht ? "onDht"
    : pair?.transitionTarget ? "switching" : ready ? "connected" : pair?.status === "confirm" ? "confirm"
    : pairingOn || pairingFailed ? "pairing" : stage === "on-dht" ? "onDht" : awaitingJoin ? "noContact"
    : !link?.peerOnline && link?.dataLink === "idle" ? "waitingContact" : "connecting";
  // A v0.4-code chat's status is English (`contactStatus`); its kind is read from that, its words translated.
  const rawStatus = status ?? "Connecting";
  const label = (() => {
    switch (labelState) {
      case "status": return statusWords(rawStatus, t);
      case "offline": return t("connection.state.offline");
      case "issue": return t("connection.state.issue");
      case "publication": return t("connection.state.publicationUnavailable");
      case "discovery": return t("connection.state.discoveryUnavailable");
      case "dhtByYou": return t("connection.state.dhtByYou");
      case "dhtByContact": return t("connection.state.dhtByContact");
      case "switching": return t("connection.state.switching", { transport: name(pair?.transitionTarget) });
      case "dhtWaiting": return t("connection.state.dhtWaitingFor", { transport: name(wait?.transport) });
      case "waiting": return t("connection.waitingFor", { transport: name(wait?.transport) });
      case "onDht": return t("connection.state.onDht");
      case "connected": return t(link?.transportRelayed ? "connection.state.connectedRelayed" : "connection.state.connected", { transport: name(pair?.transport) });
      case "confirm": return t("connection.state.confirmPeer");
      case "pairing": return pairingLabel;
      case "noContact": return t("connection.state.noContact");
      case "waitingContact": return t("connection.state.waitingContact");
      case "connecting": return t("connection.state.connectingDots");
    }
  })();
  const kind: ConnectionKind = !paired ? (/^Connected/.test(rawStatus) ? "connected" : /issue|unavailable|mismatch/.test(rawStatus) ? "failure" : rawStatus === "Offline" ? "offline" : "waiting")
    : !online ? "offline" : failure || (pairingFailed && labelState === "pairing") ? "failure" : waitOff && (pair?.transitionTarget || !textDht) ? "waiting" : dht || textDht || labelState === "onDht" ? "dht" : ready && !pair?.transitionTarget ? "connected" : "waiting";
  const connecting = kind === "waiting" && (labelState === "connecting" || !!pair?.transitionTarget);
  // On the DHT while a live link is tried underneath: the DHT mark, with a dot that breathes.
  const retrying = kind === "dht" && labelState === "onDht" && !(stage === "on-dht" && progress?.reason === "chosen");
  // The pairing scene in small, while its stage is the label: this side, the contact and a packet between them.
  const glyph = pairingOn && labelState === "pairing";
  const elapsed = glyph && ticking ? formatElapsed(inStage) : "";
  const direction = stage === "answering" && progress?.role === "joiner" ? "in" : "out";
  // Live, or live and moving to another transport: the transport's own mark, and what it is at a glance.
  const liveOn = ready && !dht && !textDht ? pair?.transport : undefined;
  const iconKind: ConnectionKind = liveOn && !failure ? "connected" : kind;
  const holding = !ready && link?.textDelivery === "hold";
  const summary = liveOn ? connectionSummary(link, Date.now(), undefined, t) : undefined;
  // The state line's round trip, once live and not moving.
  const rtt = liveOn && !failure && !pair?.transitionTarget ? link?.transportRttMs : undefined;
  const keyOfMine = myKey || link?.myPubKeyZ32;
  const [tip, setTip] = useState(false);
  const close = () => { if (root.current?.open) { root.current.open = false; trigger.current?.focus(); } };
  useOutsideDismiss(root, menuOpen, close);
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? errorText(e, t) : t("connection.panel.updateFailed")); }
    finally { setBusy(false); }
  }
  // The header shows only the icon: the label is in its tooltip, its accessible name and the panel.
  // `toggle` is queued, and React can take a while to handle it: the click and Escape act at once instead.
  return <div className="relative shrink-0">
  <details ref={root} onToggle={e => setMenuOpen(e.currentTarget.open)} onKeyDown={e => {
    if (e.key !== "Escape") return;
    if (root.current?.open) { e.stopPropagation(); close(); } else if (tip) { e.stopPropagation(); setTip(false); }
  }} className="relative" data-testid="connection-menu">
    <summary ref={trigger} onClick={() => { setTip(false); setMenuOpen(!root.current?.open); }} data-testid="connection-options" data-state={kind} data-transport={liveOn ?? (holding ? "hold" : undefined)} data-relayed={liveOn && link?.transportRelayed ? "" : undefined}
      data-pairing={stage} data-status={status} data-busy={glyph || connecting || retrying || undefined} aria-label={t("connection.panel.titleWith", { label })} aria-describedby={`${id}-tip`}
      onPointerEnter={e => { if (e.pointerType !== "touch") setTip(true); }} onPointerLeave={() => setTip(false)}
      onFocus={e => { if (e.currentTarget.matches(":focus-visible")) setTip(true); }} onBlur={() => setTip(false)}
      className={`relative flex cursor-pointer list-none items-center justify-center rounded-full p-2 transition-colors max-md:px-2 max-md:py-2.5 hover:bg-surface-hover [&::-webkit-details-marker]:hidden ${focus} ${kind === "failure" ? "text-danger" : kind === "offline" ? "text-text-muted hover:text-accent" : "text-text-secondary hover:text-accent"}`}>
      {glyph ? <PairingGlyph stage={stage!} direction={direction} size={18} /> : <ConnectionIcon kind={iconKind} transport={liveOn} holding={holding} size={18} weight={2} />}
      {!glyph && (dots[kind] || retrying) && <span aria-hidden="true" data-testid="connection-dot" className={`pointer-events-none absolute end-1 top-1 h-2 w-2 rounded-full ring-2 ring-panel-header max-md:end-1.5 max-md:top-1.5 ${dots[kind] ?? "bg-text-muted"} ${connecting || retrying ? "motion-safe:animate-pulse" : ""}`} />}
    </summary>
    <div role="dialog" aria-label={t("connection.panel.title")} className="absolute end-0 top-full max-md:fixed max-md:inset-x-2 max-md:top-[calc(3.5rem_+_env(safe-area-inset-top))] max-md:w-auto z-40 mt-2 w-[min(20rem,calc(100vw-1rem))] max-h-[70dvh] overflow-y-auto rounded-xl border border-border bg-panel-header p-3 text-xs leading-5 text-text-muted shadow-xl">
      <div className="flex items-center gap-2 px-1 font-medium text-text-primary" data-testid="connection-state">
        {glyph ? <PairingGlyph stage={stage!} direction={direction} size={16} /> : <ConnectionIcon kind={iconKind} transport={liveOn} holding={holding} size={16} weight={1.7} />}
        <span className="min-w-0 break-words">{label}{rtt !== undefined && <span className="font-normal text-text-secondary"> · {t("connection.ms", { ms: rtt })}</span>}{elapsed && <span className="font-normal tabular-nums text-text-secondary"> · {elapsed}</span>}</span>
      </div>
      {progress && (pairingOn || pairingFailed || onDhtWhy) && <div data-testid="connection-pairing" data-stage={stage} className="mt-1 space-y-0.5 px-1">
        {step > 0 && <p data-testid="connection-pairing-step">{t("pairing.stepOf", { n: step, total: steps.length })}{progress.attempt > 1 && ` · ${t("pairing.attempt", { n: progress.attempt })}`}</p>}
        {slow && <p className="text-text-secondary">{slow}</p>}
        {pairingReason && !failure && <p className="break-words text-danger">{pairingReason}</p>}
        {onDhtWhy && <p>{onDhtWhy}</p>}
        {pairing?.onShow && <button type="button" data-testid="connection-show-pairing" className={`-mx-1 min-h-9 rounded-md px-1 text-accent hover:bg-surface-hover ${focus}`}
          onClick={() => { close(); pairing.onShow?.(); }}>{t("pairing.showProgress")}</button>}
      </div>}
      {failure && <p role="alert" className="mt-1.5 break-words px-1 text-danger">{failure}</p>}
      {paired && online && !dht && state?.transport?.directBlocked && <DirectBlockedHint />}
      {paired && <fieldset disabled={busy || !online || !link} className="mt-2">
        <legend className="sr-only">{t("connection.panel.legend")}</legend>
        {link && <TransportOptions link={link} disabled={busy || !online}
          onChoose={choice => void run(() => engine.call("setChatTransport", { linkId: link.id, transport: choice }))} />}
        <label className="connection-switch-row mt-1 flex min-h-11 items-center justify-between gap-2 rounded-lg px-2.5"><span className="text-text-primary">{t("connection.panel.fallback")}</span>
          <span className="connection-switch"><input type="checkbox" role="switch" aria-label={t("connection.panel.fallback")} aria-checked={link?.transportFallback??true} checked={link?.transportFallback??true} disabled={!link || dht}
            onChange={e => link && void run(() => engine.call("setTransportPreference", {linkId:link.id,preferred,fallback:e.target.checked}))} /><span className="connection-switch-track" aria-hidden="true" /></span>
        </label>
      </fieldset>}
      <div className="mt-1 flex items-start justify-between gap-2 border-t border-border pt-1">
        <details className="min-w-0 flex-1 text-[11px]" data-testid="connection-details">
          <summary data-testid="connection-details-summary" className={`w-fit cursor-pointer rounded-md px-1 py-2 text-text-secondary ${focus}`}>{t("connection.panel.details")}</summary>
          <div className="space-y-2 px-1 pb-2">
            {wait && waitText && <div data-testid="connection-waiting" data-reason={wait.reason} data-transport={wait.transport} className="rounded-lg bg-surface-hover px-2.5 py-2 leading-4">
              <p className="font-medium text-text-primary">{waitText.label}</p>
              <p className="mt-0.5 break-words" data-testid="connection-waiting-why">{waitText.why}</p>
              <p className="mt-0.5">{waitText.meanwhile}</p>
              {waitText.automatic && link && <button type="button" data-testid="connection-waiting-automatic" disabled={busy || !online}
                className={`mt-1.5 min-h-9 rounded-md px-2 text-accent hover:bg-surface disabled:opacity-40 ${focus}`}
                onClick={() => void run(() => engine.call("setChatTransport", { linkId: link.id, transport: "auto" }))}>{t("connection.panel.useAutomatic")}</button>}
            </div>}
            {progress && (pairingOn || pairingFailed) && <div data-testid="connection-pairing-details" className="rounded-lg bg-surface-hover px-2.5 py-2 leading-4">
              <p className="font-medium text-text-primary">{stageWords}</p>
              <ol aria-label={t("pairing.steps")} className="mt-1 flex flex-wrap gap-x-2">
                {steps.map((s, i) => <li key={s} data-step={s} aria-current={s === stage ? "step" : undefined}
                  className={s === stage ? "text-text-primary" : i < step - 1 ? "text-accent" : undefined}>{words.step(s)}</li>)}
              </ol>
              {progress.detail && <p className="mt-0.5 break-words">{progress.detail}</p>}
            </div>}
            {notLive && <div data-testid="connection-not-live" data-side={link?.liveAttempt?.side ?? "none"} className="rounded-lg bg-surface-hover px-2.5 py-2 leading-4">
              <p className="font-medium text-text-primary">{notLive.label}</p>
              {notLive.lines.map(line => <p key={line} className="mt-0.5 break-words">{line}</p>)}
            </div>}
            {discoveryFailure && <p data-testid="discovery-help">{awaitingJoin && `${t("connection.panel.noContactYet")} `}{(() => {
              // The link sits where the sentence puts it, in every language.
              const [before, after = ""] = t("connection.panel.discoveryHelp").split("{{link}}");
              return <>{before}<Link className={`text-accent underline ${focus}`} to="/settings/advanced" onClick={(e) => { e.preventDefault(); nav.open("/settings/advanced"); }}>{t("connection.panel.relaySettings")}</Link>{after}</>;
            })()}</p>}
            {summary && <dl data-testid="connection-summary" className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-0.5">
              <dt>{t("connection.detail.transport")}</dt><dd className="min-w-0 text-text-primary">{summary.name}</dd>
              {summary.relays && <><dt>{t("connection.panel.path")}</dt><dd data-testid="connection-relayed" className="min-w-0 text-text-primary break-words">{summary.relays.length ? t("connection.panel.relayedVia", { relays: summary.relays.join(", ") }) : t("connection.panel.relayed")}</dd></>}
              {summary.rttMs !== undefined && <><dt>{t("connection.detail.roundTrip")}</dt><dd className="text-text-primary">{t("connection.ms", { ms: summary.rttMs })}</dd></>}
              {summary.since !== undefined && <><dt>{t("connection.panel.liveSince")}</dt><dd className="text-text-primary">{clock(summary.since)} ({lasting(Date.now() - summary.since, t)})</dd></>}
              <dt>{t("connection.detail.why")}</dt><dd className="min-w-0 break-words text-text-primary">{summary.why}</dd>
            </dl>}
            <DiscoveryHealth status={state?.transport?.discovery} />
            {!dht && Object.entries(link?.transportErrors ?? {}).map(([transport, reason]) => <p key={transport}>{t("connection.line.withReason", { text: name(transport as PairedTransport), reason })}</p>)}
            {(pinned || pair?.keyMismatch) && <div data-testid="pair-trust">
              {pair?.keyMismatch ? <p role="alert" className="text-danger">{t("connection.panel.keyMismatch")}</p> : <>
                <div className="flex min-h-9 items-center justify-between gap-2">
                  <span data-testid={link?.peerVerified ? "pair-verified" : undefined} className={`flex items-center gap-1.5 ${link?.peerVerified ? "text-accent" : "text-text-secondary"}`}>
                    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/>{link?.peerVerified && <path d="m8 12 3 3 5-6"/>}</svg>
                    {link?.peerVerified ? t("connection.panel.verified") : t("connection.panel.notVerified")}
                  </span>
                  {!link?.peerVerified && canCompare && !comparing && <button data-testid="pair-verify" aria-label={t("connection.panel.verifyContact")} className={`min-h-9 rounded-md px-2 text-accent hover:bg-surface-hover ${focus}`} onClick={()=>setComparing(true)}>{t("connection.panel.verify")}</button>}
                </div>
                {comparing && canCompare && !link?.peerVerified && <div className="rounded-lg bg-surface-hover p-3">
                  <code data-testid="pair-code" className="block select-all break-words text-sm tracking-widest text-text-primary">{pair?.code}</code>
                  <p className="mt-1">{t("connection.panel.compare")}</p>
                  <button data-testid="pair-verify-confirm" disabled={busy} className={`mt-2 min-h-9 rounded-lg bg-accent px-3 text-panel-header ${focus}`}
                    onClick={() => link && pair?.code && void run(async () => {await engine.call("confirmPair", {linkId:link.id,code:pair.code!});setComparing(false);})}>{t("connection.panel.codesMatch")}</button>
                </div>}
              </>}
            </div>}
            {link?.dhtDelivery?.foreignKeySeenAt && <p data-testid="connection-foreign-key">
              {t("connection.panel.foreignKey", { time: clock(link.dhtDelivery.foreignKeySeenAt) })}
            </p>}
            <dl data-testid="connection-keys" className="space-y-1">
              {keyOfMine && <KeyRow label={t("connection.panel.keyYou")} value={keyOfMine} testId="connection-key-you" />}
              <KeyRow label={t("connection.panel.keyContact")} value={peerKey} testId="connection-key-contact" />
            </dl>
            {!!link?.transportHistory?.length && <ConnectionHistory events={link.transportHistory} contact={contact} />}
            {paired && <p>{t("connection.panel.fallbackNote")}</p>}
            {pair?.transitionTarget && <p>{t("connection.panel.preparing", { transport: name(pair.transitionTarget), current: name(pair.transport) })}</p>}
            {!dht && !textDht && link?.dhtDelivery?.error && <p>{t("connection.panel.offlineText", { error: link.dhtDelivery.error })}</p>}
            {pinned && !pair?.keyMismatch && <p>{link?.peerVerified ? t("connection.panel.pinnedVerified") : t("connection.panel.pinnedUnverified")}</p>}
            {(dht || textDht) && <div data-testid="dht-delivery-details">
              <p>{t("connection.panel.dhtText", { bytes: link?.dhtDelivery?.maxTextBytes ?? 256 })}</p>
              <p className="mt-1">{t("connection.panel.dhtAvailability")}</p>
              {!link?.dhtDelivery?.authenticated && <p className="mt-1">{t("connection.panel.dhtUnauthenticated")}</p>}
              {link?.dhtDelivery?.pendingUntil && <p className="mt-1">{t("connection.panel.receiptPending", { time: formatAt(link.dhtDelivery.pendingUntil, { timeStyle: "medium" }, language) })}</p>}
            </div>}
          </div>
        </details>
        {!dht && !ready && !awaitingJoin && online && link && <button className={`min-h-9 shrink-0 rounded-md px-2 text-accent hover:bg-surface-hover disabled:opacity-40 ${focus}`} disabled={busy}
          onClick={() => void run(() => engine.call("connect", {linkId:link.id}))}>{t("connection.panel.reconnect")}</button>}
      </div>
    </div>
  </details>
  <span role="tooltip" id={`${id}-tip`} data-testid="connection-tooltip" className={`pointer-events-none absolute end-0 top-full z-50 mt-1.5 w-max max-w-[min(16rem,55vw)] rounded-md border border-border bg-surface-alt px-2 py-1 text-[11px] leading-4 text-text-primary shadow-lg motion-safe:transition-opacity ${tip && !menuOpen ? "opacity-100" : "invisible opacity-0"}`}>
    {label}{elapsed && ` · ${elapsed}`}{summary && !failure && <span data-testid="connection-tooltip-detail" className="mt-0.5 block text-text-secondary">{summary.detail}</span>}
    {slow && <span className="mt-0.5 block text-text-secondary">{slow}</span>}
    {onDhtWhy && <span className="mt-0.5 block text-text-secondary">{onDhtWhy}</span>}
    {failure && failure !== label && <span className="mt-0.5 block break-words text-danger">{failure}</span>}
    {pairingReason && !failure && <span className="mt-0.5 block break-words text-danger">{pairingReason}</span>}
  </span>
  <span className="sr-only" aria-live="polite">{label}</span>
  </div>;
}

/** A key in full, copied by a click, as the chat's Tech Info has it. */
function KeyRow({ label, value, testId }: { label: string; value: string; testId: string }) {
  const { copied, copy } = useCopyKey(value);
  const { t } = useI18n();
  return (
    <div className="grid grid-cols-[5.5rem_1fr] gap-x-3">
      <dt>{label}</dt>
      <dd className="min-w-0">
        <button type="button" data-testid={testId} onClick={copy} title={t("chat.message.copyHint")} aria-label={t("connection.panel.copyKey", { label, value })}
          className={`break-all rounded bg-transparent p-0 text-start font-mono transition-colors hover:text-accent ${copied ? "text-accent" : "text-text-secondary"} ${focus}`}>
          {copied ? t("common.copied") : value}
        </button>
      </dd>
    </div>
  );
}
