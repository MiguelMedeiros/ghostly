import type { PairedTransport } from "@ghostly/core";
import type { ReactNode } from "react";
import type { ConnectionKind } from "../lib/connection";
import { TransportIcon } from "./TransportIcon";

const icons: Record<ConnectionKind, ReactNode> = {
  connected: <><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></>,
  dht: <><path d="m3 7 9-4 9 4-9 4Z"/><path d="m3 12 9 4 9-4M3 17l9 4 9-4"/></>,
  waiting: <><circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 1.5"/></>,
  failure: <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/></>,
  offline: <><path d="m18.8 12.3 1.7-1.8a5 5 0 0 0-7-7l-1.7 1.7"/><path d="m5.2 11.7-1.7 1.8a5 5 0 0 0 7 7l1.7-1.7"/><path d="M8 2v3M2 8h3m11 11v3m3-6h3"/></>,
};
export function StateIcon({ kind, size, weight }: { kind: ConnectionKind; size: number; weight: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={weight} strokeLinecap="round" strokeLinejoin="round" className="shrink-0">{icons[kind]}</svg>;
}

/** Held for an away contact (store-and-forward): a tray with something in it. */
const held = <><path d="M3 13h5l1.5 3h5L16 13h5" /><path d="M5 6h14l2 7v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Z" /><path d="M12 3v7m-2.5-2.5L12 10l2.5-2.5" /></>;

/**
 * The connection at a glance, by shape before colour: live, the transport's own mark (WebRTC, Iroh, HyperDHT);
 * otherwise DHT only, held for the contact, on its way, failed or offline. A 1:1 chat's connection control and
 * the group header's both draw it.
 */
export function ConnectionIcon({ kind, transport, holding, size, weight }: { kind: ConnectionKind; transport?: PairedTransport; holding?: boolean; size: number; weight: number }) {
  if (kind === "connected" && transport) return <TransportIcon transport={transport} size={size} weight={weight} />;
  if (holding && kind === "waiting") return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={weight} strokeLinecap="round" strokeLinejoin="round" className="shrink-0" data-transport-icon="hold">{held}</svg>;
  return <StateIcon kind={kind} size={size} weight={weight} />;
}
