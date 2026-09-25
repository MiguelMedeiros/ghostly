import { useRef, useState, type ReactNode, type RefObject } from "react";
import type { PairedTransport } from "@ghostly/core";
import type { LinkView } from "@ghostly/browser/shared/types";
import { engine } from "@ghostly/browser/platform/engine";
import { liveTransport, useChatLink } from "../hooks/useChatLink";
import { Menu } from "./Menu";
import { focus, transportName } from "../lib/connection";
import { transportOptions } from "../lib/transportEvents";

export function TransportIcon({ transport, size = 14 }: { transport?: PairedTransport; size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="shrink-0">
    {transport === "iroh/1" ? <><circle cx="5" cy="12" r="3" /><circle cx="19" cy="12" r="3" /><path d="M8 12h8" /></>
      : transport === "hyperdht/1" ? <><circle cx="12" cy="4" r="2" /><circle cx="4" cy="19" r="2" /><circle cx="20" cy="19" r="2" /><path d="m11 6-6 11m8-11 6 11M6 19h12" /></>
      : <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z" /></>}
  </svg>;
}

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
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const options = transportOptions(link);
  const local = options.filter(o => (link.availableTransports ?? []).includes(o.transport));
  // One transport in this app (web, the extension): nothing to choose, only to know why.
  const single = local.length <= 1;
  const dht = link.deliveryMode === "dht";
  const current = liveTransport(link), automatic = link.transportAutomatic ?? link.preferredTransport === undefined;
  async function choose(transport: PairedTransport | "auto") {
    setBusy(true); setError("");
    try { await engine.call("setChatTransport", { linkId: link.id, transport }); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not change the connection."); }
    finally { setBusy(false); }
  }
  return (
    <Menu testId="transport-menu" open={open} onClose={onClose} anchorRef={anchorRef}>
      <div className="px-3 pb-1 pt-1.5 text-xs text-text-muted" data-testid="transport-menu-now">
        <span className="font-medium text-text-primary">Connection</span>
        {" · "}{current ? `on ${transportName(current)}${link.transportRttMs !== undefined ? `, ${link.transportRttMs} ms` : ""}` : dht ? "DHT only" : "not live"}
      </div>
      <div role="radiogroup" aria-label="Connection for this chat">
        {!single && <Option testId="transport-option-auto" checked={automatic} disabled={busy || dht} onClick={() => void choose("auto")}
          icon={<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3" /><path d="M18 3v4h-4M6 21v-4h4" /></svg>}
          hint="The apps choose, WebRTC first">Automatic</Option>}
        {(single ? local : options).map(o => (
          <Option key={o.transport} testId={`transport-option-${o.transport.replace("/1", "")}`} icon={<TransportIcon transport={o.transport} />}
            checked={single || (!automatic && link.preferredTransport === o.transport)} disabled={busy || dht || single || !o.available}
            hint={!o.available ? o.reason : current === o.transport ? `In use${link.transportRttMs !== undefined ? ` · ${link.transportRttMs} ms` : ""}` : !automatic && link.preferredTransport === o.transport ? "Chosen · not in use" : undefined}
            onClick={() => void choose(o.transport)}>{transportName(o.transport)}</Option>
        ))}
      </div>
      {(single || dht || error) && <p className="max-w-72 whitespace-normal px-3 pb-1.5 pt-1 text-[11px] leading-4 text-text-muted" data-testid="transport-menu-note">
        {error ? <span role="alert" className="text-danger">{error}</span>
          : dht ? "DHT only is on. Turn it off from the connection icon to choose a live connection."
          : "This app connects over WebRTC only. Iroh and HyperDHT need Ghostly Desktop on both sides."}
      </p>}
    </Menu>
  );
}

function Option({ children, hint, icon, checked, disabled, onClick, testId }: {
  children: ReactNode; hint?: ReactNode; icon: ReactNode; checked: boolean; disabled: boolean; onClick(): void; testId: string;
}) {
  return (
    <button type="button" role="radio" aria-checked={checked} disabled={disabled} data-testid={testId} data-menu-item onClick={onClick}
      className={`flex w-full min-w-0 items-center gap-3 whitespace-nowrap px-3 py-2 text-start text-sm transition-colors enabled:hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none disabled:cursor-default max-md:min-h-12 max-md:rounded-lg ${checked ? "text-text-primary" : "text-text-secondary"} ${disabled && !checked ? "opacity-60" : ""}`}>
      <span aria-hidden="true" className={`flex shrink-0 ${checked ? "text-accent" : ""}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span data-menu-text className="block truncate">{children}</span>
        {hint && <span data-menu-text className="block truncate text-xs text-text-muted">{hint}</span>}
      </span>
      <span aria-hidden="true" className={`ms-2 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${checked ? "border-accent" : "border-border"}`}>
        {checked && <span className="h-2 w-2 rounded-full bg-accent" />}
      </span>
    </button>
  );
}
