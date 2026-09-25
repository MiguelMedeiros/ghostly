import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DidDht } from "@web5/dids";
import {
  RelayTransport, createIdentity, didDhtDocument, didDhtFromPublicKey, encodeDidDhtPacket, resolveDidDht, signDidDhtPacket, type DidDhtFetch,
} from "@ghostly/core";
// covers: did.dht.document, did.dht.interop

/**
 * did:dht between Ghostly and an independent implementation, TBD's `@web5/dids` (the did:dht method's
 * original authors), both ways, through a Pkarr relay: Ghostly publishes, web5 resolves; web5 publishes,
 * Ghostly resolves.
 *
 * The relay is one in this process, which keeps the newest packet per key like a real one. To run the
 * same tests against a real relay (the `pkarr-relay` release binary, or a public one):
 *
 *   GHOSTLY_PKARR_RELAY=http://127.0.0.1:6881 npx vitest run test/didDhtInterop.test.ts
 */
const realRelay = process.env.GHOSTLY_PKARR_RELAY;

let server: Server | undefined;
let relay: string;

beforeAll(async () => {
  if (realRelay) { relay = realRelay.replace(/\/+$/, ""); return; }
  const packets = new Map<string, Buffer>();
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (c: Buffer) => chunks.push(c));
    request.on("end", () => {
      const key = new URL(request.url ?? "/", "http://relay").pathname.slice(1);
      if (request.method === "PUT") {
        const body = Buffer.concat(chunks);
        const known = packets.get(key);
        if (!known || body.readBigUInt64BE(64) >= known.readBigUInt64BE(64)) packets.set(key, body);
        response.writeHead(204).end();
        return;
      }
      const packet = packets.get(key);
      if (!packet) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": "application/octet-stream" }).end(packet);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  relay = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server?.close(); });

const fetchBytes: DidDhtFetch = async (url, options) => {
  const response = await fetch(url, { signal: options?.signal, redirect: "error" });
  return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
};

describe("did:dht interop with @web5/dids", () => {
  it("web5 resolves a DID Ghostly published, identity key and alsoKnownAs", { timeout: 30_000 }, async () => {
    const identity = createIdentity();
    const alsoKnownAs = ["nostr:npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m", "https://example.com"];
    const ours = didDhtDocument(identity.publicKey, { alsoKnownAs });
    const seq = Math.floor(Date.now() / 1000);
    await new RelayTransport({ relays: [relay], requestsPerMinute: Infinity })
      .publishPayload(identity.pubKeyZ32, signDidDhtPacket(identity, encodeDidDhtPacket(ours), seq));

    const { didDocument, didDocumentMetadata, didResolutionMetadata } = await DidDht.resolve(ours.id, { gatewayUri: relay });
    expect(didResolutionMetadata.error).toBeUndefined();
    expect(didDocumentMetadata.versionId).toBe(String(seq));
    expect(didDocument).toMatchObject({
      id: ours.id,
      alsoKnownAs,
      authentication: [`${ours.id}#0`],
      assertionMethod: [`${ours.id}#0`],
      capabilityInvocation: [`${ours.id}#0`],
      capabilityDelegation: [`${ours.id}#0`],
    });
    expect(didDocument!.service).toBeUndefined();
    expect(didDocument!.verificationMethod).toHaveLength(1);
    expect(didDocument!.verificationMethod![0]).toMatchObject({
      id: `${ours.id}#0`, type: "JsonWebKey", controller: ours.id,
      publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: ours.verificationMethod[0].publicKeyJwk.x, alg: "EdDSA" },
    });
  });

  it("Ghostly resolves a DID web5 published, with keys, a service and aka of its own", { timeout: 30_000 }, async () => {
    const did = await DidDht.create({ options: {
      gatewayUri: relay,
      publish: true,
      alsoKnownAs: ["did:example:efgh"],
      verificationMethods: [{ algorithm: "secp256k1", purposes: ["assertionMethod", "capabilityInvocation"] }],
      services: [{ id: "dwn", type: "DecentralizedWebNode", serviceEndpoint: ["https://dwn.example.com/1", "https://dwn.example.com/2"] }],
    } });

    const resolved = await resolveDidDht(did.uri, { fetch: fetchBytes, relays: [relay] });
    expect(resolved.relay).toBe(relay);
    const theirs = did.document;
    expect(resolved.document.id).toBe(theirs.id);
    expect(resolved.document.alsoKnownAs).toEqual(["did:example:efgh"]);
    expect(resolved.document.service).toEqual([{ id: `${did.uri}#dwn`, type: "DecentralizedWebNode", serviceEndpoint: ["https://dwn.example.com/1", "https://dwn.example.com/2"] }]);
    // Same keys (web5 names the identity key's JWK without a kid; ours says "0", as the spec does).
    const keys = (vms: { id: string; publicKeyJwk?: { crv?: string; x?: string; y?: string } }[] = []) =>
      vms.map((vm) => ({ id: vm.id, crv: vm.publicKeyJwk?.crv, x: vm.publicKeyJwk?.x, y: vm.publicKeyJwk?.y }));
    expect(keys(resolved.document.verificationMethod)).toEqual(keys(theirs.verificationMethod));
    for (const relationship of ["authentication", "assertionMethod", "capabilityInvocation", "capabilityDelegation"] as const) {
      expect(resolved.document[relationship], relationship).toEqual(theirs[relationship]);
    }
    expect(didDhtFromPublicKey(Buffer.from(resolved.document.verificationMethod[0].publicKeyJwk.x, "base64url"))).toBe(did.uri);
  });
});
