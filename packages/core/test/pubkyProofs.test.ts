import { describe, expect, it } from "vitest";
import {
  createIdentity, decodeSvcbRecords, encodeSvcbPacket, homeserverWebEndpoint, identityStatement, isPubkyKey, isPubkyProofFolder,
  newIdentityBinding, newPubkyProofFolder, normalizePubkyKey, openRelayPayload, pubkyHomeserverOf, pubkyProofCapability, pubkyProofFile,
  pubkyProofPath, signRelayPayload, PUBKY_PROOF_ROOT,
} from "../src";
// covers: proofs.pubky

/**
 * A real homeserver's Pkarr packet, as https://pkarr.pubky.app served it on 2026-09-25: an HTTPS record for its
 * Pubky TLS endpoint (priority 1, target ".", port 6287, an IPv4 hint), one for browsers (priority 10,
 * homeserver.staging.pubky.app) and an A record, with its owner name compressed the way simple-dns writes it.
 */
const HOMESERVER = "ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy";
const HOMESERVER_PAYLOAD = fromHexString("bbf0a8b32727b7cf2a77568166ec4baf669d53b6bf620c777c0d77bb21894c42b258b366fe49dfb6b67b99f2be028025514fc376d7f2f53cf6cd854811d6170b00065c38c2687d7a000080000000000300000000347566696277626d6564366a6571396b3470353833676f3935776f66616b683966777070346b373334747271373970643975317579000041000100000e10001100010000030002188f000400042241e751c00c0041000100000e100020000a0a686f6d657365727665720773746167696e67057075626b790361707000c00c0001000100000e1000042241e751");

function fromHexString(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!, b => parseInt(b, 16));
}

describe("Pubky PKDNS records", () => {
  it("reads a real homeserver packet: signature, both HTTPS records, and the host browsers use", () => {
    const { dnsPacket } = openRelayPayload(HOMESERVER, HOMESERVER_PAYLOAD);
    const records = decodeSvcbRecords(dnsPacket);
    expect(records.map(r => [r.name, r.priority, r.target])).toEqual([[HOMESERVER, 1, ""], [HOMESERVER, 10, "homeserver.staging.pubky.app"]]);
    expect([...records[0].params.get(3)!]).toEqual([0x18, 0x8f]);
    expect(homeserverWebEndpoint(dnsPacket, HOMESERVER)).toEqual({ host: "homeserver.staging.pubky.app" });
  });

  it("refuses a packet signed by another key", () => {
    expect(() => openRelayPayload(createIdentity().pubKeyZ32, HOMESERVER_PAYLOAD)).toThrow(/signature/);
  });

  it("finds the homeserver a key's _pubky record names, in either name form", () => {
    const user = createIdentity();
    for (const name of [`_pubky.${user.pubKeyZ32}`, "_pubky"]) {
      const packet = encodeSvcbPacket([{ name, priority: 0, target: HOMESERVER }]);
      const { dnsPacket } = openRelayPayload(user.pubKeyZ32, signRelayPayload(user, packet, 1n));
      expect(pubkyHomeserverOf(dnsPacket, user.pubKeyZ32)).toBe(HOMESERVER);
    }
  });

  it("has no homeserver without a _pubky record, or with one that does not name a key", () => {
    const user = createIdentity().pubKeyZ32;
    expect(pubkyHomeserverOf(encodeSvcbPacket([{ name: `_other.${user}`, priority: 0, target: HOMESERVER }]), user)).toBeUndefined();
    expect(pubkyHomeserverOf(encodeSvcbPacket([{ name: `_pubky.${user}`, priority: 0, target: "homeserver.example.com" }]), user)).toBeUndefined();
    // Another key's _pubky record does not count for this one.
    expect(pubkyHomeserverOf(encodeSvcbPacket([{ name: `_pubky.${createIdentity().pubKeyZ32}`, priority: 0, target: HOMESERVER }]), user)).toBeUndefined();
  });

  it("picks the lowest-priority public host, with its port, and never a private one", () => {
    const hs = createIdentity().pubKeyZ32;
    const endpoint = (records: Parameters<typeof encodeSvcbPacket>[0]) => homeserverWebEndpoint(encodeSvcbPacket(records), hs);
    expect(endpoint([{ name: hs, priority: 20, target: "b.example.com" }, { name: hs, priority: 10, target: "a.example.com", port: 8443 }]))
      .toEqual({ host: "a.example.com", port: 8443 });
    expect(endpoint([{ name: hs, priority: 10, target: "a.example.com", port: 443 }])).toEqual({ host: "a.example.com" });
    for (const target of ["localhost", "homeserver.local", "hs.internal", "hs.test", "10.0.0.1", "", hs, `${createIdentity().pubKeyZ32}`])
      expect(endpoint([{ name: hs, priority: 10, target }]), target).toBeUndefined();
    // AliasMode (priority 0) and records of other names are not endpoints of this homeserver.
    expect(endpoint([{ name: hs, priority: 0, target: "a.example.com" }])).toBeUndefined();
    expect(endpoint([{ name: `_pubky.${hs}`, priority: 10, target: "a.example.com" }])).toBeUndefined();
    // A private name is skipped for the next public one.
    expect(endpoint([{ name: hs, priority: 1, target: "localhost" }, { name: hs, priority: 5, target: "hs.example.org" }])).toEqual({ host: "hs.example.org" });
  });

  it("refuses malformed SVCB records instead of reading past them", () => {
    const hs = createIdentity().pubKeyZ32;
    const good = encodeSvcbPacket([{ name: hs, priority: 10, target: "a.example.com", port: 8443 }]);
    // Shrink the parameter's declared length window by cutting the packet: every truncation throws, none reads garbage.
    for (let cut = good.length - 1; cut > 12; cut--) {
      const truncated = good.slice(0, cut);
      expect(() => decodeSvcbRecords(truncated), `cut at ${cut}`).toThrow();
    }
    // A parameter longer than its record.
    const bad = good.slice();
    bad[bad.length - 3] = 0x40;
    expect(() => decodeSvcbRecords(bad)).toThrow(/out of bounds/);
  });
});

describe("Pubky proof files", () => {
  const key = createIdentity().pubKeyZ32;

  it("normalizes the forms a Pubky key is written in", () => {
    for (const input of [key, key.toUpperCase(), `pubky${key}`, `pk:${key}`, `pubky://${key}`, ` ${key}\n`, `pubky://${key}/`]) expect(normalizePubkyKey(input)).toBe(key);
    for (const input of ["", key.slice(1), `${key}y`, `npub${key}`, `https://${key}`, `pubky://${key}/pub/x`, "0".repeat(52)]) expect(() => normalizePubkyKey(input), input).toThrow(/Pubky key/);
    expect(isPubkyKey(key)).toBe(true);
    expect(isPubkyKey(key.toUpperCase())).toBe(false);
  });

  it("asks for one folder only, and names the file after the statement", () => {
    const folder = newPubkyProofFolder();
    expect(isPubkyProofFolder(folder)).toBe(true);
    expect(newPubkyProofFolder()).not.toBe(folder);
    expect(pubkyProofCapability(folder)).toBe(`${PUBKY_PROOF_ROOT}${folder}/:w`);
    expect(pubkyProofCapability(folder)).not.toContain(",");
    const statement = identityStatement(newIdentityBinding({ provider: "pubky", subject: key, validitySeconds: 86_400 }).binding);
    expect(pubkyProofPath(folder, statement.id)).toBe(`/pub/ghostly.app/proofs/${folder}/${statement.id}.txt`);
    expect(pubkyProofFile(statement)).toBe(statement.text);
    for (const bad of ["", "../x", folder.toUpperCase(), `${folder}/..`, folder.slice(2)]) {
      expect(() => pubkyProofCapability(bad), bad).toThrow();
      expect(() => pubkyProofPath(bad, statement.id), bad).toThrow();
    }
    expect(() => pubkyProofPath(folder, "../../pub/other")).toThrow();
  });
});
