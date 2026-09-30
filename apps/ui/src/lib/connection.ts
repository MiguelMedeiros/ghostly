import type { PairedTransport } from "@ghostly/core";

/** A transport as people call it. */
export const transportName = (transport?: PairedTransport) => transport === "iroh/1" ? "Iroh" : transport === "hyperdht/1" ? "HyperDHT" : "WebRTC";

/** The focus ring of the connection controls. */
export const focus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** What a connection control's icon says at a glance; its label says the rest. */
export type ConnectionKind = "connected" | "dht" | "waiting" | "failure" | "offline";

/** The dot on the icon: connected, on its way, or failed. */
export const dots: Partial<Record<ConnectionKind, string>> = { connected: "bg-accent", waiting: "bg-text-muted", failure: "bg-danger" };
