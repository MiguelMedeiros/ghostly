import type { PairedTransport } from "@ghostly/core";

/** A transport as people call it. */
export const transportName = (transport?: PairedTransport) => transport === "iroh/1" ? "Iroh" : transport === "hyperdht/1" ? "HyperDHT" : "WebRTC";

/** The focus ring of the connection controls. */
export const focus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** What a connection control's icon says at a glance; its label says the rest. */
export type ConnectionKind = "connected" | "dht" | "waiting" | "failure" | "offline";

/** The dot on the icon: connected, on its way, or failed. */
export const dots: Partial<Record<ConnectionKind, string>> = { connected: "bg-accent", waiting: "bg-text-muted", failure: "bg-danger" };

/*
 * Forced colors (Windows Contrast) paint a background with the page's Canvas, and a dot drawn by its fill alone went
 * with it: reachable and not reachable looked the same. There they take system colours, and a shape besides: filled
 * (Highlight) when reached, a Highlight ring when only some are (the header's amber), a GrayText ring when not.
 */
const REACHED = "forced-colors:forced-color-adjust-none forced-colors:bg-[color:Highlight]";
const SOME = "forced-colors:forced-color-adjust-none forced-colors:border-2 forced-colors:border-[color:Highlight] forced-colors:bg-[color:Canvas]";
const NOT_REACHED = "forced-colors:forced-color-adjust-none forced-colors:border forced-colors:border-[color:GrayText] forced-colors:bg-[color:Canvas]";

/** A reach dot's fill (`edgeDot`, `dots`), with how it is drawn in forced colors. */
export const reachDot = (fill: string) => {
  const colour = fill.split(" ")[0];
  return `${fill} ${colour === "bg-accent" ? REACHED : colour === "bg-amber-500" ? SOME : NOT_REACHED}`;
};
