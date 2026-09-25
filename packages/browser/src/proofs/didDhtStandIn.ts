import { base58 } from "@scure/base";
import { DEFAULT_RELAYS, fromBase64Url, parseRelayPayload, parseDid } from "@ghostly/core";

/**
 * A stand-in for `resolveDidDht` from `@ghostly/core` (packages/core/src/didDht.ts, PR #247), with the same
 * signature, until that lands on dev: it reads the keys and their authentication / assertionMethod
 * relationships of a did:dht record from Pkarr relays, and nothing else. Delete this file and import the
 * real one when #247 merges.
 */

export interface DidDhtFetchResponse { status: number; bytes: Uint8Array }
export type DidDhtFetch = (url: string, options?: { maxBytes?: number; signal?: AbortSignal; redirect?: "error" }) => Promise<DidDhtFetchResponse>;
export interface ResolveDidDhtOptions { fetch: DidDhtFetch; relays?: string[]; signal?: AbortSignal }
export interface DidDhtResolution {
  document: Record<string, unknown>;
  metadata: { versionId: string; updated: string; deactivated?: true; types?: number[] };
  relay: string;
}

/** Key types of the did:dht registry: 0 Ed25519, 1 secp256k1, 2 P-256 (compressed), as multicodec prefixes. */
const CODEC: Record<string, number[]> = { "0": [0xed, 0x01], "1": [0xe7, 0x01], "2": [0x80, 0x24] };
const MAX_PAYLOAD = 64 + 8 + 1000;

const properties = (value: string) => new Map(value.split(";").map(p => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)] as const));

export async function resolveDidDht(did: string, options: ResolveDidDhtOptions): Promise<DidDhtResolution> {
  const parsed = parseDid(did);
  if (parsed.method !== "dht") throw new Error("Not a did:dht");
  const z32 = parsed.id;
  let notFound = false;
  for (const relay of options.relays ?? DEFAULT_RELAYS) {
    options.signal?.throwIfAborted();
    let response: DidDhtFetchResponse;
    try { response = await options.fetch(`${relay.replace(/\/+$/, "")}/${z32}`, { maxBytes: MAX_PAYLOAD, signal: options.signal, redirect: "error" }); }
    catch (e) { if (options.signal?.aborted) throw e; continue; }
    if (response.status === 404) { notFound = true; continue; }
    if (response.status !== 200) continue;
    let records: { label: string; value: string }[];
    try { records = parseRelayPayload(z32, response.bytes).records; } catch { throw new Error("The did:dht record is not signed by the DID's key"); }
    const root = records.find(r => r.label === "_did");
    if (!root) throw new Error("The did:dht record has no DID document");
    const rootProps = properties(root.value);
    const ids = new Map<string, string>();
    const verificationMethod = (rootProps.get("vm") ?? "").split(",").filter(Boolean).flatMap(alias => {
      const record = records.find(r => r.label === `_${alias}._did`);
      const p = record ? properties(record.value) : undefined;
      const prefix = p && CODEC[p.get("t") ?? ""];
      if (!p || !prefix) return [];
      const id = `${did}#${p.get("id") ?? alias}`;
      ids.set(alias, id);
      return [{ id, type: "Multikey", controller: did, publicKeyMultibase: `z${base58.encode(Uint8Array.from([...prefix, ...fromBase64Url(p.get("k") ?? "")]))}` }];
    });
    const refs = (name: string) => (rootProps.get(name) ?? "").split(",").flatMap(alias => ids.has(alias) ? [ids.get(alias)!] : []);
    return {
      document: { id: did, verificationMethod, authentication: refs("auth"), assertionMethod: refs("asm") },
      metadata: { versionId: "0", updated: new Date(0).toISOString() },
      relay,
    };
  }
  throw new Error(notFound ? "No document is published for this did:dht" : "No Pkarr relay answered for this did:dht");
}
