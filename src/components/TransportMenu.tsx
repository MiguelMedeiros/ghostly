import { useRef, useState, type ReactNode, type RefObject } from "react";
import type { PairedTransport } from "@ghostly/core";
import type { LinkView } from "@ghostly/browser/shared/types";
import { engine } from "@ghostly/browser/platform/engine";
import { useChatLink } from "../hooks/useChatLink";
import { Menu } from "./Menu";
import { TransportIcon } from "./TransportIcon";
import { focus, transportName } from "../lib/connection";
import { connectionSummary, liveTransport, transportOptions } from "../lib/transportEvents";

/**
 * The chat's live transport in its header, once live (the pairing indicator has the place until then). It opens
 * the chat's Connection menu.
 */
export function TransportChip({ peerKey }: { peerKey: string }) {
  const link = useChatLink(peerKey);
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const transport = liveTransport(link);
  if (!link || !transport) return null;
  const moving = link.pairing?.transitionTarget;
  const label = moving ? `Switching to ${transportName(moving)}` : transportName(transport);
  return (
    <div ref={wrapper} className="relative min-w-0">
      <button type="button" data-testid="transport-chip" data-transport={transport} aria-haspopup="true" aria-expanded={open}
        aria-label={`Connection: ${label}${link.transportRttMs !== undefined ? `, round trip ${link.transportRttMs} ms` : ""}. Change`}
        onClick={() => setOpen(!open)}
        className={`flex min-h-6 max-w-full items-center gap-1 rounded-full border border-border px-2 text-[11px] leading-none text-text-secondary transition-colors hover:border-accent/40 hover:text-accent ${focus}`}>
        <TransportIcon transport={moving ?? transport} size={12} />
        <span className={`truncate ${moving ? "motion-safe:animate-pulse" : ""}`}>{label}</span>
        {link.transportRttMs !== undefined && !moving && <span className="shrink-0 text-text-muted max-md:hidden">· {link.transportRttMs} ms</span>}
      </button>
      <TransportMenu link={link} open={open} onClose={() => setOpen(false)} anchorRef={wrapper} />
    </div>
  );
}

/**
 * "Connection" for one chat: Automatic, or a transport both apps support on this link. The others are shown
 * disabled with the reason. Switching moves the live session without reconnecting; a switch that cannot connect
 * leaves it where it was, and the chat's timeline says so. The choice is kept for the next reconnect.
 */
export function TransportMenu({ link, open, onClose, anchorRef }: {
  link: LinkView; open: boolean; onClose(): void; anchorRef: RefObject<HTMLElement | null>;
}) {
  const summary = connectionSummary(link, Date.now());
  return (
    <Menu testId="transport-menu" open={open} onClose={onClose} anchorRef={anchorRef}>
      <div className="px-3 pb-1 pt-1.5 text-xs text-text-muted" data-testid="transport-menu-now">
        <span className="font-medium text-text-primary">Connection</span>
        {" · "}{summary ? `on ${summary.name}${summary.rttMs !== undefined ? `, ${summary.rttMs} ms` : ""}` : link.deliveryMode === "dht" ? "DHT only" : "not live"}
      </div>
      <TransportOptions link={link} onChosen={onClose} menu />
    </Menu>
  );
}

/**
 * The choices themselves, shared by the chat's ⋮ menu and its connection popover. `menu`: laid out as menu rows
 * (one line each, the reason in a tooltip when cut).
 */
export function TransportOptions({ link, disabled = false, onChosen, menu = false }: {
  link: LinkView; disabled?: boolean; onChosen?(): void; menu?: boolean;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const options = transportOptions(link);
  const local = options.filter(o => (link.availableTransports ?? []).includes(o.transport));
  // One transport in this app (web, the extension): nothing to choose, only to know why.
  const single = local.length <= 1;
  const dht = link.deliveryMode === "dht";
  const current = liveTransport(link), automatic = link.transportAutomatic ?? link.preferredTransport === undefined;
  // In the menu, DHT only is one of the choices: picking another leaves it. The popover has its own switch for it.
  const off = busy || disabled || (dht && !menu);
  const peerDht = link.dhtDelivery?.peerMode === "dht";
  // One set of ids per place: the popover's and the menu's options can both be in the page.
  const ids = menu ? "transport-option" : "connection-option";
  async function choose(transport: PairedTransport | "auto" | "dht") {
    // A single transport here: choosing it means leaving DHT only, back to the app's rule.
    if (single && transport !== "dht") transport = "auto";
    // Already so: nothing to ask the engine.
    const already = transport === "dht" ? dht : !dht && (transport === "auto" ? automatic : !automatic && link.preferredTransport === transport && current === transport);
    if (already) { onChosen?.(); return; }
    setBusy(true); setError("");
    try { await engine.call("setChatTransport", { linkId: link.id, transport }); onChosen?.(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not change the connection."); }
    finally { setBusy(false); }
  }
  return <>
    <div role="radiogroup" aria-label="Connection for this chat" data-testid="transport-options">
      {!single && <Option menu={menu} testId={`${ids}-auto`} checked={automatic && !dht} disabled={off} onClick={() => void choose("auto")}
        icon={<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3" /><path d="M18 3v4h-4M6 21v-4h4" /></svg>}
        hint="The apps choose, WebRTC first" label="Automatic" />}
      {/* The menu offers what can be chosen; the popover also lists what this app lacks, and why. */}
      {(single && menu ? local : options).map(o => (
        <Option menu={menu} key={o.transport} testId={`${ids}-${o.transport.replace("/1", "")}`} icon={<TransportIcon transport={o.transport} />}
          checked={!dht && (single ? o.available : !automatic && link.preferredTransport === o.transport)} disabled={off || (single && menu && !dht) || !o.available}
          hint={!o.available ? o.reason : current === o.transport ? `In use${link.transportRttMs !== undefined ? ` · ${link.transportRttMs} ms` : ""}` : !automatic && link.preferredTransport === o.transport ? "Chosen · not in use" : undefined}
          onClick={() => void choose(o.transport)} label={transportName(o.transport)} />
      ))}
      {/* Always there (WISP 400): it travels as the DHT envelope's mode, so every app can choose it. */}
      {menu && <Option menu testId="transport-option-dht" checked={dht} disabled={busy || disabled} onClick={() => void choose("dht")} label="DHT only"
        icon={<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="m3 7 9-4 9 4-9 4Z" /><path d="m3 12 9 4 9-4M3 17l9 4 9-4" /></svg>}
        hint={peerDht && !dht ? "Your contact chose it · no live link until you both leave it" : dht ? "Short texts over the DHT, no live link" : "Short texts over the DHT, even offline"} />}
    </div>
    {((single && menu) || (peerDht && menu) || error) && <p className={`${menu ? "max-w-72 px-3 pb-1.5 pt-1" : "mt-1"} whitespace-normal text-[11px] leading-4 text-text-muted`} data-testid="transport-menu-note">
      {error ? <span role="alert" className="text-danger">{error}</span>
        : peerDht ? "Your contact chose DHT only: no live connection until you both leave it."
        : "This app connects over WebRTC only. Iroh and HyperDHT need Ghostly Desktop on both sides."}
    </p>}
  </>;
}

function Option({ label, hint, icon, checked, disabled, onClick, testId, menu }: {
  label: string; hint?: string; icon: ReactNode; checked: boolean; disabled: boolean; onClick(): void; testId: string; menu: boolean;
}) {
  return (
    // A row is one line (as every menu's is); a reason cut at the menu's width is whole in the tooltip.
    <button type="button" role="radio" aria-checked={checked} aria-label={label} aria-description={hint} disabled={disabled} data-testid={testId} data-menu-item onClick={onClick}
      title={hint ? `${label}: ${hint}` : undefined}
      className={`flex w-full min-w-0 items-center gap-3 text-start transition-colors enabled:hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none disabled:cursor-default ${menu ? "whitespace-nowrap px-3 py-2 text-sm max-md:min-h-12 max-md:rounded-lg" : "min-h-10 rounded-lg px-2.5 py-1.5 text-xs"} ${checked ? "text-text-primary" : "text-text-secondary"} ${disabled && !checked ? "opacity-60" : ""}`}>
      <span aria-hidden="true" className={`flex shrink-0 ${checked ? "text-accent" : ""}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span data-menu-text className="block truncate">{label}</span>
        {hint && <span data-menu-text className={`block text-text-muted ${menu ? "truncate text-xs" : "break-words text-[11px]"}`}>{hint}</span>}
      </span>
      <span aria-hidden="true" className={`ms-2 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${checked ? "border-accent" : "border-border"}`}>
        {checked && <span className="h-2 w-2 rounded-full bg-accent" />}
      </span>
    </button>
  );
}
