import { base64urlnopad } from "@scure/base";
import type { LightningProviderDescriptor } from "./lightning";
import { PROVIDER_PLATFORMS, type ProviderSettings } from "./types";

/**
 * Core Lightning as the source picker lists it, and its rune, read before anything is contacted. The client
 * (`./coreLightning`) and its Commando handshake load when a node connects, not with the app.
 */

/** What Ghostly calls, and all a rune for it should allow. */
export const CLN_METHODS = ["getinfo", "invoice", "listinvoices", "xpay", "pay", "listpays", "listfunds"] as const;
export const CLN_RUNE_COMMAND = `lightning-cli createrune restrictions='[[${CLN_METHODS.map((m) => `"method=${m}"`).join(",")}]]'`;

const NODE_ID = /^0[23][0-9a-f]{64}$/;

// -- runes ----------------------------------------------------------------------

/**
 * The restrictions a rune carries, read without the node: a rune is base64url of a 32-byte hash state
 * followed by its restrictions (`&` between restrictions, `|` between alternatives, `\` escapes).
 */
export function runeRestrictions(rune: string): string[][] {
  let bytes: Uint8Array;
  try { bytes = base64urlnopad.decode(rune.trim().replace(/=+$/, "")); } catch { throw new Error("That is not a rune"); }
  if (bytes.length < 32) throw new Error("That is not a rune");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(32));
  const restrictions: string[][] = [];
  let alternatives: string[] = [], current = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length) { current += text[++i]; continue; }
    if (c === "|") { alternatives.push(current); current = ""; continue; }
    if (c === "&") { alternatives.push(current); restrictions.push(alternatives); alternatives = []; current = ""; continue; }
    current += c;
  }
  if (text.length) { alternatives.push(current); restrictions.push(alternatives); }
  return restrictions;
}

/**
 * Refuses a rune that could run anything but what Ghostly calls: at least one of its restrictions must
 * be only `method=<one of CLN_METHODS>` alternatives. Other restrictions (a rate, amounts) only narrow it.
 */
export function checkRune(rune: string) {
  const allowed = new Set<string>(CLN_METHODS);
  const limited = runeRestrictions(rune).some((alternatives) => alternatives.length > 0 && alternatives.every((alt) => alt.startsWith("method=") && allowed.has(alt.slice(7))));
  if (!limited) throw new Error(`This rune is not restricted to the methods Ghostly uses. Create one with: ${CLN_RUNE_COMMAND}`);
}

const settingsOf = ({ config, secrets }: ProviderSettings) => ({ url: config.url?.trim() ?? "", nodeId: config.nodeId?.trim().toLowerCase() ?? "", rune: secrets.rune?.trim() ?? "" });

export const coreLightning: LightningProviderDescriptor = {
  id: "core-lightning",
  label: "Core Lightning",
  kind: "lightning",
  description: "Your own Core Lightning node, over Commando with a rune. Your node holds the sats. The web app reaches it only through wss://.",
  networks: ["bitcoin", "testnet", "signet", "regtest"],
  platforms: PROVIDER_PLATFORMS,
  fields: [
    { name: "nodeId", label: "Node id", kind: "text", placeholder: "02… or 03… (66 hex characters)", help: "lightning-cli getinfo → id. The connection is authenticated against it." },
    { name: "url", label: "WebSocket address", kind: "url", placeholder: "wss://node.example.com", help: "The node's bind-addr=ws:… listener, behind a wss:// proxy for the web app; ws:// only to this machine." },
    { name: "rune", label: "Rune", kind: "secret", placeholder: "A rune restricted to Ghostly's methods", help: `Never an unrestricted rune. Create one with: ${CLN_RUNE_COMMAND}` },
  ],
  validate(settings) {
    const { url, nodeId, rune } = settingsOf(settings);
    if (!NODE_ID.test(nodeId)) throw new Error("The node id is 66 hex characters, starting with 02 or 03");
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error("Enter the node's websocket address, starting with wss:// or ws://"); }
    if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") throw new Error("The websocket address starts with wss:// or ws://");
    if (parsed.username || parsed.password) throw new Error("Put the rune in its own field, not in the address");
    checkRune(rune);
  },
  async create(settings, host) {
    const { CoreLightning } = await import("./coreLightning");
    return CoreLightning.connect(settingsOf(settings), host.signal);
  },
};
