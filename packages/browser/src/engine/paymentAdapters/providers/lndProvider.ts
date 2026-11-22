import { base64, hex } from "@scure/base";
import type { LightningProviderDescriptor } from "./lightning";
import { SourceConfigError, type ProviderSettings } from "./types";

/**
 * LND as the source picker lists it, and its settings: the macaroon, the node's address and certificate, read before
 * anything is contacted. The client (`./lnd`) loads when a node connects, not with the app.
 */

export const LND_SOURCE = "lnd";

/** What the recommended macaroon grants: `lncli bakemacaroon info:read invoices:read invoices:write offchain:read offchain:write`. */
export const LND_SCOPE = ["info:read", "invoices:read", "invoices:write", "offchain:read", "offchain:write"];
export const LND_BAKE = `lncli bakemacaroon ${LND_SCOPE.join(" ")}`;
/** Read-only powers a macaroon may carry beyond the scope without being refused: none of them moves money. */
const HARMLESS = new Set(["onchain:read", "address:read", "peers:read", "message:read"]);
/** The RPCs this provider calls, for macaroons scoped by method (`uri:` permissions). */
const URIS = {
  info: "/lnrpc.Lightning/GetInfo",
  addInvoice: "/lnrpc.Lightning/AddInvoice",
  lookupInvoice: "/lnrpc.Lightning/LookupInvoice",
  balance: "/lnrpc.Lightning/ChannelBalance",
  send: "/routerrpc.Router/SendPaymentV2",
  track: "/routerrpc.Router/TrackPaymentV2",
} as const;

// -- the macaroon ------------------------------------------------------------------

export interface MacaroonOp { entity: string; actions: string[] }
export interface LndMacaroon { hex: string; ops: MacaroonOp[] }

/** Hex (what `lncli` and most node UIs show) or base64 of the binary macaroon. */
export function parseMacaroon(input: string): LndMacaroon {
  const text = input.trim().replace(/\s+/g, "");
  let bytes: Uint8Array;
  try {
    if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) bytes = hex.decode(text.toLowerCase());
    else bytes = base64.decode(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "="));
  } catch { throw new Error("The macaroon must be hex or base64"); }
  const ops = macaroonOps(bytes);
  if (!ops) throw new Error("That is not an LND macaroon");
  return { hex: hex.encode(bytes), ops };
}

class Reader {
  pos = 0;
  constructor(readonly bytes: Uint8Array) {}
  get done() { return this.pos >= this.bytes.length; }
  varint(): number {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      if (this.done) throw new Error("truncated");
      const b = this.bytes[this.pos++];
      value += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return value;
    }
    throw new Error("varint too long");
  }
  take(length: number): Uint8Array {
    if (length > this.bytes.length - this.pos) throw new Error("truncated");
    return this.bytes.subarray(this.pos, (this.pos += length));
  }
}

/**
 * The permissions LND wrote into the macaroon's identifier: a V2 binary macaroon whose identifier is a
 * version byte (3) and a `MacaroonId` protobuf `{ nonce = 1; storageId = 2; repeated Op ops = 3 }`, each
 * `Op { entity = 1; repeated actions = 2 }`. Undefined when it is not shaped like that.
 */
function macaroonOps(bytes: Uint8Array): MacaroonOp[] | undefined {
  try {
    const r = new Reader(bytes);
    if (r.varint() !== 2) return undefined;
    let id: Uint8Array | undefined;
    for (let type = r.varint(); type !== 0; type = r.varint()) {
      const data = r.take(r.varint());
      if (type === 2) id = data;
    }
    if (!id || id[0] !== 3) return undefined;
    const text = new TextDecoder("utf-8", { fatal: true });
    const fields = (buf: Uint8Array, each: (field: number, data: Uint8Array) => void) => {
      const p = new Reader(buf);
      while (!p.done) {
        const key = p.varint(), field = Math.floor(key / 8), wire = key & 7;
        if (wire === 2) each(field, p.take(p.varint()));
        else if (wire === 0) p.varint();
        else throw new Error("unexpected wire type");
      }
    };
    const ops: MacaroonOp[] = [];
    fields(id.subarray(1), (field, data) => {
      if (field !== 3) return;
      const op: MacaroonOp = { entity: "", actions: [] };
      fields(data, (f, d) => { if (f === 1) op.entity = text.decode(d); else if (f === 2) op.actions.push(text.decode(d)); });
      ops.push(op);
    });
    return ops.length ? ops : undefined;
  } catch { return undefined; }
}

export interface MacaroonScope { receive: boolean; send: boolean; balance: boolean; info: boolean; excess: string[] }

/** What a macaroon lets this provider do, and what it allows beyond that (which is refused). */
export function macaroonScope(ops: readonly MacaroonOp[]): MacaroonScope {
  const perms = new Set<string>(), uris = new Set<string>();
  for (const op of ops) for (const action of op.actions) {
    if (op.entity === "uri") uris.add(action); else perms.add(`${op.entity}:${action}`);
  }
  const has = (...wanted: string[]) => wanted.every((w) => (w.startsWith("/") ? uris.has(w) : perms.has(w)));
  const used = new Set<string>(Object.values(URIS));
  const excess = [...[...perms].filter((p) => !LND_SCOPE.includes(p) && !HARMLESS.has(p)), ...[...uris].filter((u) => !used.has(u))];
  return {
    info: has("info:read") || has(URIS.info),
    receive: has("invoices:read", "invoices:write") || has(URIS.addInvoice, URIS.lookupInvoice),
    send: has("offchain:read", "offchain:write") || has(URIS.send, URIS.track),
    balance: has("offchain:read") || has(URIS.balance),
    excess,
  };
}

// -- where the node is ---------------------------------------------------------------

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/** The REST address, normalized: https (plain http only on this machine), no path, no credentials. */
export function parseNodeUrl(input: string): string {
  let url: URL;
  try { url = new URL(input.trim().includes("://") ? input.trim() : `https://${input.trim()}`); } catch { throw new Error("That is not an address"); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.test(url.hostname))) throw new Error("The REST address must start with https:// (plain http only for a node on this machine)");
  if (url.username || url.password) throw new Error("Put no credentials in the address: the macaroon is enough");
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) throw new Error("Give only the node's address and port, like https://mynode.local:8080");
  return url.origin;
}

/** A certificate as PEM (with or without its line breaks), base64 or hex DER: returned as base64 DER. */
export function parseCertificate(input: string): string {
  const text = input.trim();
  const pem = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(text);
  const body = (pem ? pem[1] : text).replace(/\s+/g, "");
  let der: Uint8Array;
  try { der = /^[0-9a-f]+$/i.test(body) && body.length % 2 === 0 ? hex.decode(body.toLowerCase()) : base64.decode(body); }
  catch { throw new Error("The TLS certificate must be PEM (tls.cert), base64 or hex"); }
  // An X.509 certificate is a DER SEQUENCE; anything else is not one.
  if (der.length < 64 || der[0] !== 0x30) throw new Error("That is not a TLS certificate");
  return base64.encode(der);
}

export interface LndSettings { url: string; macaroon: LndMacaroon; scope: MacaroonScope; certificate?: string }

/** Everything the form says, checked before the node is contacted. Throws a message fit for the person. */
export function lndSettings({ config, secrets }: ProviderSettings): LndSettings {
  const url = parseNodeUrl(config.url ?? "");
  const macaroon = parseMacaroon(secrets.macaroon ?? "");
  const scope = macaroonScope(macaroon.ops);
  if (scope.excess.length) throw new Error(`This macaroon can do more than Ghostly needs (${scope.excess.slice(0, 4).join(", ")}${scope.excess.length > 4 ? "…" : ""}). Bake one for it: ${LND_BAKE}`);
  if (!scope.info || (!scope.receive && !scope.send)) throw new Error(`This macaroon does not allow what Ghostly needs. Bake one for it: ${LND_BAKE}`);
  return { url, macaroon, scope, certificate: secrets.certificate ? parseCertificate(secrets.certificate) : undefined };
}

export const lnd: LightningProviderDescriptor = {
  id: LND_SOURCE,
  label: "LND node",
  kind: "lightning",
  description: "Your own LND node, over its REST API. Your node holds the sats.",
  networks: ["bitcoin", "testnet", "signet", "regtest"],
  platforms: ["web", "extension", "desktop"],
  fields: [
    { name: "url", label: "REST address", kind: "url", placeholder: "https://mynode.local:8080",
      help: "LND's REST port (restlisten, 8080 by default). In a browser the node must allow this app with restcors and have a certificate the browser trusts; the desktop app needs neither." },
    { name: "macaroon", label: "Macaroon (hex)", kind: "secret", placeholder: "0201036c6e64…",
      help: `Never the admin macaroon: bake one with ${LND_BAKE} (only invoices:… to receive only).` },
    { name: "certificate", label: "TLS certificate", kind: "secret", optional: true, placeholder: "-----BEGIN CERTIFICATE-----…",
      help: "Desktop only: the node's tls.cert, pinned (the node must present exactly this one). Leave empty for a certificate from a public authority; anywhere else it must stay empty." },
  ],
  experimental: true,
  validate(settings) { lndSettings(settings); },
  async create(settings, host) {
    const { url, macaroon, scope, certificate } = lndSettings(settings);
    const { LndLightning, fetchTransport, tauriTransport } = await import("./lnd");
    const desktop = host.platform === "desktop" && host.invoke;
    // `fetch` cannot pin: taking the certificate here would send the macaroon to any certificate the platform trusts.
    if (certificate && !desktop) throw new SourceConfigError("Only the desktop app can pin the node's TLS certificate. Leave the certificate empty here: the node then needs a certificate this device trusts.");
    const transport = desktop
      ? tauriTransport(desktop, url, macaroon.hex, certificate)
      : fetchTransport(url, macaroon.hex, host.signal);
    return new LndLightning(transport, scope);
  },
};
