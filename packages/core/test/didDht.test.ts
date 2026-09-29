import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fromBase64Url, toZ32 } from "../src/bytes";
import { decodeTxtPacket, encodeTxtPacket, type NsRecord, type TxtRecord } from "../src/dns";
import {
  DID_DHT_TTL, DidDhtError, decodeDidDhtPacket, didDhtDocument, didDhtFromPublicKey, didDhtKey, didDhtRecords, encodeDidDhtPacket,
  jwkThumbprint, openDidDhtPayload, resolveDidDht, signDidDhtPacket, type DidDhtDocument, type DidDhtFetch,
} from "../src/didDht";
import { createIdentity } from "../src/identity";
import { MAX_DNS_PACKET_BYTES, PacketTooLargeError } from "../src/pkarr";

// covers: did.dht.document

/** The official vectors (https://did-dht.com/#test-vectors), as the reference implementation keeps them. */
const vector = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/did-dht/${name}.json`, import.meta.url), "utf8")) as T;
interface VectorRecord { name: string; type: "TXT" | "NS"; ttl: number; rdata: string[] }

/** A vector's records as a DNS packet, the way its publisher would have written it. */
function packetOf(records: VectorRecord[]): Uint8Array {
  return encodeTxtPacket(records.map((r): TxtRecord | NsRecord => r.type === "NS"
    ? { type: "NS", name: r.name, host: r.rdata[0], ttl: r.ttl }
    : { name: r.name, value: r.rdata.join(""), ttl: r.ttl }), { authoritative: true });
}

/** Our records in the vectors' shape. */
const asVector = (records: (TxtRecord | NsRecord)[]): VectorRecord[] => records.map((r) => "host" in r
  ? { name: r.name, type: "NS", ttl: r.ttl, rdata: [r.host] }
  : { name: r.name, type: "TXT", ttl: r.ttl, rdata: [r.value] });

const joined = (records: VectorRecord[]) => records.map((r) => ({ ...r, rdata: [r.rdata.join("")] }));
/** The spec gives record sets; the order is ours (root after the keys, see didDhtRecords). */
const sorted = (records: VectorRecord[]) => [...records].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

describe("did:dht identifiers", () => {
  it("is the z-base-32 of the identity key, and only that", () => {
    const jwk = vector<{ x: string }>("vector-1-public-key-jwk-1");
    const did = didDhtFromPublicKey(fromBase64Url(jwk.x));
    expect(did).toBe("did:dht:cyuoqaf7itop8ohww4yn5ojg13qaq83r9zihgqntc5i9zwrfdfoo");
    expect(didDhtKey(did).publicKey).toEqual(fromBase64Url(jwk.x));
    for (const bad of [
      "did:dht:cyuoqaf7itop8ohww4yn5ojg13qaq83r9zihgqntc5i9zwrfdfoo#0",
      "did:dht:cyuoqaf7itop8ohww4yn5ojg13qaq83r9zihgqntc5i9zwrfdfo",
      "did:dht:CYUOQAF7ITOP8OHWW4YN5OJG13QAQ83R9ZIHGQNTC5I9ZWRFDFOO",
      "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
      // Same 256 bits, a different last character: not canonical.
      "did:dht:cyuoqaf7itop8ohww4yn5ojg13qaq83r9zihgqntc5i9zwrfdfor",
    ]) expect(() => didDhtKey(bad), bad).toThrow(DidDhtError);
  });
});

describe("the spec's test vectors", () => {
  it("vector 1: the minimal document is exactly its records, and they decode back to it", () => {
    const jwk = vector<{ x: string }>("vector-1-public-key-jwk-1");
    const expected = vector<DidDhtDocument>("vector-1-did-document");
    const document = didDhtDocument(fromBase64Url(jwk.x));
    expect(document).toEqual(expected);
    expect(sorted(asVector(didDhtRecords(document)))).toEqual(sorted(vector<VectorRecord[]>("vector-1-dns-records")));
    expect(decodeDidDhtPacket(expected.id, encodeDidDhtPacket(document))).toEqual({ document: expected, deactivated: false });
    expect(decodeDidDhtPacket(expected.id, packetOf(vector("vector-1-dns-records"))).document).toEqual(expected);
  });

  it("vector 2: a second key with an id and a controller, a service, an aka, a controller, types and gateways", () => {
    const expected = vector<DidDhtDocument>("vector-2-did-document");
    const records = vector<VectorRecord[]>("vector-2-dns-records");
    const decoded = decodeDidDhtPacket(expected.id, packetOf(records));
    expect(decoded.document).toEqual(expected);
    expect(decoded.types).toEqual([1, 2, 3]);
    expect(sorted(asVector(didDhtRecords(expected, {
      types: [1, 2, 3], gateways: ["gateway1.example-did-dht-gateway.com.", "gateway2.example-did-dht-gateway.com."],
    })))).toEqual(sorted(records));
  });

  it("vector 3: an X25519 key named by its thumbprint, a non-default alg, an endpoint over 255 bytes, a previous DID", () => {
    const expected = vector<DidDhtDocument>("vector-3-did-document");
    const records = vector<VectorRecord[]>("vector-3-dns-records");
    expect(jwkThumbprint(vector("vector-3-public-key-jwk-2"))).toBe("WVy5IWMa36AoyAXZDvPd5j9zxt2t-GjifDEV-DwgIdQ");
    expect(decodeDidDhtPacket(expected.id, packetOf(records)).document).toEqual(expected);
    // `_prv._did.` (the link to a previous DID) is read past, not written.
    const ours = didDhtRecords(expected, { gateways: ["gateway1.example-did-dht-gateway.com."] });
    expect(sorted(asVector(ours))).toEqual(sorted(joined(records.filter((r) => r.name !== "_prv._did."))));
    // A TXT value longer than 255 bytes is split into character-strings and joined again.
    const packet = encodeDidDhtPacket(expected);
    expect(decodeTxtPacket(packet).find((r) => r.name === "_s0._did")!.value.length).toBeGreaterThan(255);
    expect(decodeDidDhtPacket(expected.id, packet).document).toEqual(expected);
  });
});

describe("Ghostly's document", () => {
  const identity = createIdentity();
  const did = didDhtFromPublicKey(identity.publicKey);

  it("carries no service and no alsoKnownAs by default", () => {
    const document = didDhtDocument(identity.publicKey);
    expect(document.service).toBeUndefined();
    expect(document.alsoKnownAs).toBeUndefined();
    // The keys before the root record that names them: @web5/dids reads references in packet order.
    expect(didDhtRecords(document).map((r) => r.name)).toEqual(["_k0._did.", `_did.${identity.pubKeyZ32}.`]);
  });

  it("lists the identities chosen as public, in order, as alsoKnownAs", () => {
    const alsoKnownAs = ["at://did:plc:ewvi7nxzyoun6zhxrhs64oiz", "nostr:npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m", "https://example.com"];
    const packet = encodeDidDhtPacket(didDhtDocument(identity.publicKey, { alsoKnownAs }));
    expect(decodeTxtPacket(packet).find((r) => r.name === "_aka._did")!.value).toBe(alsoKnownAs.join(","));
    expect(decodeDidDhtPacket(did, packet).document.alsoKnownAs).toEqual(alsoKnownAs);
    expect(() => didDhtRecords(didDhtDocument(identity.publicKey, { alsoKnownAs: ["https://a.test/x,y"] }))).toThrow(/cannot be written/);
  });

  it("shares its key's one packet with the key's other records, within 1000 bytes", () => {
    const extra = [{ name: `_pubky.${identity.pubKeyZ32}`, value: "anything", ttl: 300 }];
    const packet = encodeDidDhtPacket(didDhtDocument(identity.publicKey), { extra });
    expect(decodeTxtPacket(packet).map((r) => r.name)).toEqual(["_k0._did", `_did.${identity.pubKeyZ32}`, `_pubky.${identity.pubKeyZ32}`]);
    expect(decodeDidDhtPacket(did, packet).document).toEqual(didDhtDocument(identity.publicKey));

    const tooMuch = [{ name: "_big", value: "x".repeat(MAX_DNS_PACKET_BYTES), ttl: 300 }];
    expect(() => encodeDidDhtPacket(didDhtDocument(identity.publicKey), { extra: tooMuch })).toThrow(PacketTooLargeError);
    const aka = Array.from({ length: 40 }, (_, i) => `https://identity-${i}.example.com`);
    expect(() => encodeDidDhtPacket(didDhtDocument(identity.publicKey, { alsoKnownAs: aka }))).toThrow(PacketTooLargeError);
  });

  it("is authoritative and compressed, as the spec requires", () => {
    const packet = encodeDidDhtPacket(didDhtDocument(identity.publicKey));
    expect(packet[2] & 0x84).toBe(0x84); // QR and AA
    // The second `_did` label is a pointer, not a repeat.
    expect(new TextDecoder().decode(packet).split("_did").length - 1).toBe(2);
  });

  it("signs with a sequence number in seconds and opens only under its own key", () => {
    const seq = 1_790_000_000;
    const payload = signDidDhtPacket(identity, encodeDidDhtPacket(didDhtDocument(identity.publicKey)), seq);
    const opened = openDidDhtPayload(did, payload);
    expect(opened.seq).toBe(BigInt(seq));
    expect(opened.document.id).toBe(did);
    const other = didDhtFromPublicKey(createIdentity().publicKey);
    expect(() => openDidDhtPayload(other, payload)).toThrow(/not signed by the DID's key/);
    const tampered = payload.slice();
    tampered[tampered.length - 1] ^= 1;
    expect(() => openDidDhtPayload(did, tampered)).toThrow(DidDhtError);
  });
});

describe("strict parsing", () => {
  const identity = createIdentity();
  const did = didDhtFromPublicKey(identity.publicKey);
  const z32 = identity.pubKeyZ32;
  const k0 = `t=0;k=${Buffer.from(identity.publicKey).toString("base64url")}`;
  const decode = (records: { name: string; value: string }[]) =>
    decodeDidDhtPacket(did, encodeTxtPacket(records.map((r) => ({ ...r, ttl: DID_DHT_TTL })), { authoritative: true }));
  const root = (value: string) => ({ name: `_did.${z32}.`, value });

  it("accepts names with the key appended, as a Pkarr client that adds its origin writes them", () => {
    expect(decode([root("v=0;vm=k0;auth=k0"), { name: `_k0._did.${z32}`, value: k0 }]).document.authentication).toEqual([`${did}#0`]);
  });

  it("reads a deactivated DID as such", () => {
    expect(decode([root("deactivated")])).toEqual({ document: { id: did, verificationMethod: [] }, deactivated: true });
  });

  it.each([
    ["no root record", [{ name: "_k0._did.", value: k0 }]],
    ["another version", [root("v=1;vm=k0"), { name: "_k0._did.", value: k0 }]],
    ["k0 missing from vm", [root("v=0;vm=k1"), { name: "_k1._did.", value: k0 }]],
    ["a listed key without a record", [root("v=0;vm=k0,k1"), { name: "_k0._did.", value: k0 }]],
    ["a relationship to an unlisted key", [root("v=0;vm=k0;auth=k3"), { name: "_k0._did.", value: k0 }]],
    ["k0 that is another key", [root("v=0;vm=k0"), { name: "_k0._did.", value: `t=0;k=${Buffer.from(createIdentity().publicKey).toString("base64url")}` }]],
    ["k0 of another type", [root("v=0;vm=k0"), { name: "_k0._did.", value: k0.replace("t=0", "t=3") }]],
    ["an unknown key type", [root("v=0;vm=k0,k1"), { name: "_k0._did.", value: k0 }, { name: "_k1._did.", value: "t=9;k=AAAA" }]],
    ["padded base64", [root("v=0;vm=k0"), { name: "_k0._did.", value: `${k0}=` }]],
    ["a property twice", [root("v=0;v=0;vm=k0"), { name: "_k0._did.", value: k0 }]],
    ["a property without a value separator", [root("v=0;vm=k0;auth"), { name: "_k0._did.", value: k0 }]],
    ["two root records", [root("v=0;vm=k0"), root("v=0;vm=k0"), { name: "_k0._did.", value: k0 }]],
    ["two k0 records", [root("v=0;vm=k0"), { name: "_k0._did.", value: k0 }, { name: "_k0._did.", value: k0 }]],
    ["a service without a record", [root("v=0;vm=k0;svc=s0"), { name: "_k0._did.", value: k0 }]],
    ["a service endpoint that is not a URI", [root("v=0;vm=k0;svc=s0"), { name: "_k0._did.", value: k0 }, { name: "_s0._did.", value: "id=a;t=T;se=not a uri" }]],
    ["an aka that is not a URI", [root("v=0;vm=k0"), { name: "_k0._did.", value: k0 }, { name: "_aka._did.", value: "no-scheme" }]],
    ["a secp256k1 key off the curve", [root("v=0;vm=k0,k1"), { name: "_k0._did.", value: k0 }, { name: "_k1._did.", value: `t=1;k=${Buffer.alloc(33, 7).toString("base64url")}` }]],
  ])("refuses %s", (_, records) => {
    expect(() => decode(records)).toThrow(/malformed/);
  });

  it("ignores the key's other records and did:dht records it does not know", () => {
    const decoded = decode([root("v=0;vm=k0"), { name: "_k0._did.", value: k0 }, { name: "_prv._did.", value: "id=did:dht:x;s=y" }, { name: `_msgs.${z32}`, value: "?" }]);
    expect(decoded.document.verificationMethod).toHaveLength(1);
  });

  it("refuses bytes that are not a DNS packet", () => {
    expect(() => decodeDidDhtPacket(did, new Uint8Array([1, 2, 3]))).toThrow(/malformed/);
  });
});

describe("resolveDidDht", () => {
  const identity = createIdentity();
  const did = didDhtFromPublicKey(identity.publicKey);
  const document = didDhtDocument(identity.publicKey, { alsoKnownAs: ["https://example.com"] });
  const seq = 1_790_000_000;
  const payload = signDidDhtPacket(identity, encodeDidDhtPacket(document), seq);

  /** Relays by URL: a payload, a status, or a network error. */
  function relays(answers: Record<string, Uint8Array | number | Error>) {
    const asked: string[] = [];
    const fetch: DidDhtFetch = async (url, options) => {
      asked.push(url);
      expect(options?.maxBytes).toBe(1072);
      expect(options?.redirect).toBe("error");
      const answer = answers[new URL(url).origin];
      if (answer instanceof Error) throw answer;
      if (typeof answer === "number") return { status: answer, bytes: new Uint8Array() };
      return { status: 200, bytes: answer };
    };
    return { fetch, asked };
  }

  it("reads the document from the first relay that has it, with its metadata", async () => {
    const { fetch, asked } = relays({ "https://a.test": 404, "https://b.test": payload });
    const resolved = await resolveDidDht(did, { fetch, relays: ["https://a.test", "https://b.test/"] });
    expect(resolved).toEqual({ document, metadata: { versionId: String(seq), updated: new Date(seq * 1000).toISOString() }, relay: "https://b.test" });
    expect(asked).toEqual([`https://a.test/${identity.pubKeyZ32}`, `https://b.test/${identity.pubKeyZ32}`]);
  });

  it("asks one relay when it answers", async () => {
    const { fetch, asked } = relays({ "https://a.test": payload, "https://b.test": payload });
    await resolveDidDht(did, { fetch, relays: ["https://a.test", "https://b.test"] });
    expect(asked).toHaveLength(1);
  });

  it("moves past a relay serving a forged packet, and says so when none is good", async () => {
    const forged = signDidDhtPacket(createIdentity(), encodeDidDhtPacket(document), seq + 1);
    await expect(resolveDidDht(did, { ...relays({ "https://a.test": forged, "https://b.test": payload }), relays: ["https://a.test", "https://b.test"] }))
      .resolves.toMatchObject({ relay: "https://b.test" });
    await expect(resolveDidDht(did, { ...relays({ "https://a.test": forged }), relays: ["https://a.test"] }))
      .rejects.toThrow("The did:dht record is not signed by the DID's key");
  });

  it("tells not found from unreachable", async () => {
    await expect(resolveDidDht(did, { ...relays({ "https://a.test": 404, "https://b.test": new Error("offline") }), relays: ["https://a.test", "https://b.test"] }))
      .rejects.toMatchObject({ code: "not-found", message: "No document is published for this did:dht" });
    await expect(resolveDidDht(did, { ...relays({ "https://a.test": 500, "https://b.test": new Error("offline") }), relays: ["https://a.test", "https://b.test"] }))
      .rejects.toMatchObject({ code: "unreachable" });
    await expect(resolveDidDht("did:dht:nope", { ...relays({}) })).rejects.toMatchObject({ code: "invalid-did" });
  });

  it("reports a deactivated DID in the metadata", async () => {
    const deactivated = signDidDhtPacket(identity, encodeTxtPacket([{ name: `_did.${identity.pubKeyZ32}.`, value: "deactivated", ttl: DID_DHT_TTL }], { authoritative: true }), seq);
    const resolved = await resolveDidDht(did, { ...relays({ "https://a.test": deactivated }), relays: ["https://a.test"] });
    expect(resolved.metadata.deactivated).toBe(true);
    expect(resolved.document).toEqual({ id: did, verificationMethod: [] });
  });

  it("reads a packet a Pkarr client stamped in microseconds", async () => {
    const micros = signDidDhtPacket(identity, encodeDidDhtPacket(document), seq * 1_000_000);
    const resolved = await resolveDidDht(did, { ...relays({ "https://a.test": micros }), relays: ["https://a.test"] });
    expect(resolved.metadata.updated).toBe(new Date(seq * 1000).toISOString());
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(resolveDidDht(did, { ...relays({ "https://a.test": payload }), relays: ["https://a.test"], signal: controller.signal })).rejects.toThrow();
  });

  it("uses the public relays by default", async () => {
    const { fetch, asked } = relays({ "https://pkarr.pubky.org": payload });
    await resolveDidDht(did, { fetch });
    expect(asked).toEqual([`https://pkarr.pubky.org/${toZ32(identity.publicKey)}`]);
  });
});
