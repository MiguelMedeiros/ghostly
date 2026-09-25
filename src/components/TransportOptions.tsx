import type { ReactNode } from "react";
import type { PairedTransport } from "@ghostly/core";
import type { LinkView } from "@ghostly/browser/shared/types";
import { TransportIcon } from "./TransportIcon";
import { transportName } from "../lib/connection";
import { liveTransport, transportOptions } from "../lib/transportEvents";

/** A choice for the chat's connection: Automatic, a transport, or DHT only (WISP 400). */
export type ConnectionChoice = PairedTransport | "auto" | "dht";

/**
 * The chat's connection choices, in its connection panel, one short line each: Automatic, each transport, and DHT
 * only, which every app can choose (it travels as the DHT envelope's mode). The one chosen is checked; the one in use
 * carries "In use · N ms", since a chat set to WebRTC can be live over Iroh while Fallback is on. A transport this
 * app or the contact's lacks is listed, off, with the reason in its tooltip. Choosing a transport moves the live
 * session without reconnecting, and one that cannot connect yet is waited for (WISP 100); choosing one while on DHT
 * only leaves it. The choice is kept for the next reconnect. `onChoose` is only asked for a change.
 */
export function TransportOptions({ link, disabled = false, onChoose }: {
  link: LinkView; disabled?: boolean; onChoose(choice: ConnectionChoice): void;
}) {
  const options = transportOptions(link);
  const local = options.filter(o => (link.availableTransports ?? []).includes(o.transport));
  // One transport in this app (web, the extension): nothing to choose between, only to know why.
  const single = local.length <= 1;
  const dht = link.deliveryMode === "dht";
  const current = liveTransport(link), automatic = link.transportAutomatic ?? link.preferredTransport === undefined;
  const peerDht = link.dhtDelivery?.peerMode === "dht";
  function choose(choice: ConnectionChoice) {
    // A single transport here: choosing it means leaving DHT only, back to the app's rule.
    if (single && choice !== "dht") choice = "auto";
    // Already so: nothing to ask the engine.
    const already = choice === "dht" ? dht : !dht && (choice === "auto" ? automatic : !automatic && link.preferredTransport === choice && current === choice);
    if (!already) onChoose(choice);
  }
  return (
    <div role="radiogroup" aria-label="Connection for this chat" data-testid="transport-options">
      {!single && <Option testId="connection-option-auto" checked={automatic && !dht} disabled={disabled} onClick={() => choose("auto")}
        icon={<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3" /><path d="M18 3v4h-4M6 21v-4h4" /></svg>}
        hint="The apps choose, WebRTC first" label="Automatic" />}
      {/* Every transport, what this app lacks too: off, and why. */}
      {options.map(o => {
        const inUse = current === o.transport && o.available, waiting = link.transportWait?.transport === o.transport && !dht;
        const using = `In use${o.relayed ? " · relayed" : ""}${link.transportRttMs !== undefined ? ` · ${link.transportRttMs} ms` : ""}`;
        return <Option key={o.transport} testId={`connection-option-${o.transport.replace("/1", "")}`} icon={<TransportIcon transport={o.transport} />}
          checked={!dht && (single ? o.available : !automatic && link.preferredTransport === o.transport)} disabled={disabled || !o.available} inUse={inUse}
          mark={inUse ? using : waiting && o.available ? "Waiting" : undefined}
          hint={!o.available ? o.reason : inUse ? using : waiting ? "Chosen · waiting for it" : !automatic && link.preferredTransport === o.transport ? "Chosen · not in use" : o.relayed ? "Through a relay · used when nothing direct connects" : undefined}
          onClick={() => choose(o.transport)} label={transportName(o.transport)} />;
      })}
      <Option testId="connection-option-dht" checked={dht} disabled={disabled} onClick={() => choose("dht")} label="DHT only"
        icon={<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="m3 7 9-4 9 4-9 4Z" /><path d="m3 12 9 4 9-4M3 17l9 4 9-4" /></svg>}
        hint={peerDht && !dht ? "Your contact chose it · no live link until you both leave it" : dht ? "Short texts over the DHT, no live link · choose another to leave it" : "Short texts over the DHT, even offline"} />
    </div>
  );
}

function Option({ label, hint, mark, icon, checked, inUse = false, disabled, onClick, testId }: {
  label: string; hint?: string; mark?: string; icon: ReactNode; checked: boolean; inUse?: boolean; disabled: boolean; onClick(): void; testId: string;
}) {
  return (
    // One line: the radio is what is chosen; the mark ("In use · 42 ms") is what carries the chat now, which may be
    // another row. The longer word on a row (why it is off, what it does) is its tooltip and accessible description.
    <button type="button" role="radio" aria-checked={checked} aria-label={label} aria-description={hint} disabled={disabled} data-testid={testId} data-in-use={inUse ? "" : undefined} onClick={onClick}
      title={hint ? `${label}: ${hint}` : undefined}
      className={`flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-1 text-start text-xs transition-colors enabled:hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none disabled:cursor-default max-md:min-h-11 ${checked ? "text-text-primary" : "text-text-secondary"} ${disabled && !checked ? "opacity-60" : ""}`}>
      <span aria-hidden="true" className={`flex shrink-0 ${checked ? "text-accent" : ""}`}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {mark && <span className={`flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] ${inUse ? "text-accent" : "text-text-muted"}`}>
        {inUse && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />}{mark}
      </span>}
      <span aria-hidden="true" className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${checked ? "border-accent" : "border-border"}`}>
        {checked && <span className="h-2 w-2 rounded-full bg-accent" />}
      </span>
    </button>
  );
}
