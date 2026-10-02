import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import {
  deviceEchoFrame, deviceEchoNonce, deviceFrameCapability, deviceKeyZ32, deviceLinkParams, deviceLinkRendezvousSeed, deviceLinkSealKey, deviceLinkSecret,
  devicePingFrame, firstDeviceSetSecret, fromBase64Url, identityFromSeed, randomBytes, seedSigner, sign, turnKeys, utf8Encode, verify, webCryptoSigner,
} from "../src/index";
// covers: devices.links.derivation, devices.signing-key

/*
 * The derivations of a device set (WISP 06 § Terms), pinned by vectors: the first device-set secret from the DID
 * key's seed, the turn's keys under it, and for every pair of devices the link secret, each side's rendezvous seed
 * and key, and the sealing key. `vectors/device-links.json` is what this file builds from fixed labels, checked in:
 * write it again with `DEVICE_VECTORS_WRITE=1 npx vitest run test/deviceLink.test.ts`. Every seed here is a test
 * value made from a label.
 */

const FILE = fileURLToPath(new URL("./vectors/device-links.json", import.meta.url));
const seed = (label: string) => sha256(utf8Encode(`ghostly device link vectors: ${label}`));
const DEVICES = ["Desktop", "Phone", "Laptop", "Tablet"];

interface SetVector {
  name: string; d: string; turnSeed: string; turnAddress: string; turnAddressZ32: string; turnSealKey: string;
  links: { a: number; b: number; lower: number; linkSecret: string; rendezvousSeedA: string; rendezvousKeyA: string; rendezvousSeedB: string; rendezvousKeyB: string; sealKey: string }[];
}
interface Vectors {
  about: string; salt: string; didSeed: string;
  devices: { name: string; seed: string; key: string; keyZ32: string }[];
  sets: SetVector[];
}

function build(): Vectors {
  const didSeed = seed("DID key");
  const devices = DEVICES.map((name, i) => ({ name, ...identityFromSeed(seed(`device ${i}`)) }));
  const set = (name: string, d: Uint8Array): SetVector => {
    const turn = turnKeys(d);
    const links: SetVector["links"] = [];
    for (let a = 0; a < devices.length; a++) for (let b = a + 1; b < devices.length; b++) {
      const keyA = devices[a].publicKey, keyB = devices[b].publicKey;
      const secret = deviceLinkSecret(d, keyA, keyB);
      const rvA = deviceLinkRendezvousSeed(secret, keyA), rvB = deviceLinkRendezvousSeed(secret, keyB);
      links.push({
        a, b, lower: bytesToHex(keyA) < bytesToHex(keyB) ? a : b, linkSecret: bytesToHex(secret),
        rendezvousSeedA: bytesToHex(rvA), rendezvousKeyA: identityFromSeed(rvA).pubKeyZ32,
        rendezvousSeedB: bytesToHex(rvB), rendezvousKeyB: identityFromSeed(rvB).pubKeyZ32,
        sealKey: bytesToHex(deviceLinkSealKey(secret)),
      });
    }
    return { name, d: bytesToHex(d), turnSeed: bytesToHex(turn.identity.seed), turnAddress: bytesToHex(turn.address), turnAddressZ32: turn.identity.pubKeyZ32, turnSealKey: bytesToHex(turn.sealKey), links };
  };
  return {
    about: "Test vectors of a device set's derivations (WISP 06, Terms): the first device-set secret D0 from the DID key's seed, the turn's keys, and every device link. Built by packages/core/test/deviceLink.test.ts from labels; every seed is a test value. Bytes are hex; a key ending in Z32 is z-base-32. All HKDF-SHA256 with the salt below; info is ASCII, then raw key bytes: D0 'device-set' (ikm: the DID seed); turn seed 'turn' and turn seal key 'turn-seal' (ikm: D); link secret 'link' || lowerKey || higherKey (ikm: D; keys compared as bytes); rendezvous seed 'rv' || ownSigningKey and link seal key 'enc' (ikm: the link secret).",
    salt: "ghostly-devices/1",
    didSeed: bytesToHex(didSeed),
    devices: devices.map((d) => ({ name: d.name, seed: bytesToHex(d.seed), key: bytesToHex(d.publicKey), keyZ32: d.pubKeyZ32 })),
    sets: [set("the first device set: D0 from the DID key's seed", firstDeviceSetSecret(didSeed)), set("after a removal: a random D", seed("D after a removal"))],
  };
}

describe("a device set's derivations: the vectors", () => {
  it("the checked-in file is what this code builds, byte for byte", () => {
    const built = `${JSON.stringify(build(), null, 2)}\n`;
    if (process.env.DEVICE_VECTORS_WRITE) writeFileSync(FILE, built);
    expect(existsSync(FILE), "write it with DEVICE_VECTORS_WRITE=1").toBe(true);
    expect(readFileSync(FILE, "utf8")).toBe(built);
  });

  const vectors = (): Vectors => JSON.parse(readFileSync(FILE, "utf8")) as Vectors;

  it("the first D comes from the DID key's seed, and the turn's keys from D", () => {
    const v = vectors(), first = v.sets[0];
    expect(bytesToHex(firstDeviceSetSecret(hexToBytes(v.didSeed)))).toBe(first.d);
    for (const set of v.sets) {
      const keys = turnKeys(hexToBytes(set.d));
      expect(bytesToHex(keys.identity.seed)).toBe(set.turnSeed);
      expect(bytesToHex(keys.address)).toBe(set.turnAddress);
      expect(keys.identity.pubKeyZ32).toBe(set.turnAddressZ32);
      expect(bytesToHex(keys.sealKey)).toBe(set.turnSealKey);
    }
  });

  it("both ends of every link derive the same link from D and the two device signing keys", () => {
    const v = vectors();
    for (const set of v.sets) for (const link of set.links) {
      const d = hexToBytes(set.d), a = hexToBytes(v.devices[link.a].key), b = hexToBytes(v.devices[link.b].key);
      // The order the keys are given in changes nothing: lower then higher, compared as bytes.
      expect(bytesToHex(deviceLinkSecret(d, a, b))).toBe(link.linkSecret);
      expect(bytesToHex(deviceLinkSecret(d, b, a))).toBe(link.linkSecret);
      const fromA = deviceLinkParams(d, a, b), fromB = deviceLinkParams(d, b, a);
      expect(bytesToHex(fromBase64Url(fromA.seedB64))).toBe(link.rendezvousSeedA);
      expect(bytesToHex(fromBase64Url(fromB.seedB64))).toBe(link.rendezvousSeedB);
      // Each side knows the other's rendezvous key without the other having said it.
      expect(fromA.peerPubKeyZ32).toBe(link.rendezvousKeyB);
      expect(fromB.peerPubKeyZ32).toBe(link.rendezvousKeyA);
      expect(bytesToHex(fromBase64Url(fromA.encKeyB64))).toBe(link.sealKey);
      expect(fromB.encKeyB64).toBe(fromA.encKeyB64);
      expect(fromA.profile).toBe("paired-chat/1");
    }
  });

  it("no two links of a set, and no link of two sets, share a secret, a rendezvous key or a sealing key", () => {
    const v = vectors();
    const all = v.sets.flatMap((set) => set.links.flatMap((link) => [link.linkSecret, link.rendezvousSeedA, link.rendezvousSeedB, link.rendezvousKeyA, link.rendezvousKeyB, link.sealKey]));
    expect(new Set(all).size).toBe(all.length);
    // Six links among four devices, in each of the two sets.
    expect(v.sets.map((set) => set.links.length)).toEqual([6, 6]);
  });

  it("a device signing key is the participation key the session names", () => {
    const v = vectors();
    for (const device of v.devices) expect(deviceKeyZ32(hexToBytes(device.key))).toBe(device.keyZ32);
  });
});

describe("a device link's keys", () => {
  const d = randomBytes(32), a = identityFromSeed(randomBytes(32)).publicKey, b = identityFromSeed(randomBytes(32)).publicKey;

  it("a device that holds another D derives another link: other rendezvous keys on both sides and another sealing key", () => {
    const current = deviceLinkParams(d, a, b), stale = deviceLinkParams(randomBytes(32), a, b);
    expect(stale.seedB64).not.toBe(current.seedB64);
    expect(stale.peerPubKeyZ32).not.toBe(current.peerPubKeyZ32);
    expect(stale.encKeyB64).not.toBe(current.encKeyB64);
  });

  it("another device signing key under the same D is another link", () => {
    const other = identityFromSeed(randomBytes(32)).publicKey;
    expect(deviceLinkParams(d, a, other).peerPubKeyZ32).not.toBe(deviceLinkParams(d, a, b).peerPubKeyZ32);
    expect(deviceLinkParams(d, other, b).seedB64).not.toBe(deviceLinkParams(d, a, b).seedB64);
  });

  it("refuses a secret or a key of the wrong size, and a link from a device to itself", () => {
    expect(() => deviceLinkSecret(randomBytes(31), a, b)).toThrow("32 bytes");
    expect(() => deviceLinkSecret(d, a.subarray(1), b)).toThrow("32 bytes");
    expect(() => deviceLinkSecret(d, a, new Uint8Array(a))).toThrow("itself");
  });
});

describe("the frames of a device link", () => {
  it("a frame's type names the capability it travels under", () => {
    expect(deviceFrameCapability("device-ping")).toBe("devices/1");
    expect(deviceFrameCapability("set-update")).toBe("devices/1");
    expect(deviceFrameCapability("set-ack")).toBe("devices/1");
    expect(deviceFrameCapability("handoff-hello")).toBe("handoff/1");
    expect(deviceFrameCapability("enroll-grant")).toBe("enroll/1");
    for (const other of ["paired-message", "group-msg", "device-", "set-", "devices", "", 7, null, undefined]) expect(deviceFrameCapability(other)).toBeNull();
  });

  it("a ping is echoed with its nonce, and nothing else is", () => {
    const ping = devicePingFrame();
    expect(ping.t).toBe("device-ping");
    expect(fromBase64Url(ping.n)).toHaveLength(16);
    const echo = deviceEchoFrame(ping)!;
    expect(echo).toEqual({ t: "device-echo", n: ping.n });
    expect(deviceEchoNonce(echo)).toBe(ping.n);
    expect(deviceEchoFrame({ t: "device-ping" })).toBeNull();
    expect(deviceEchoFrame({ t: "device-ping", n: "short" })).toBeNull();
    expect(deviceEchoFrame({ t: "device-echo", n: ping.n })).toBeNull();
    expect(deviceEchoNonce(ping)).toBeNull();
    expect(deviceEchoNonce({ t: "device-echo", n: 5 })).toBeNull();
    expect(() => devicePingFrame(randomBytes(8))).toThrow("16 bytes");
  });
});

describe("a signer", () => {
  const message = utf8Encode("ghostly signer test");

  it("a seed behind the interface signs exactly what the raw seed signs", async () => {
    const seedBytes = randomBytes(32), signer = seedSigner(seedBytes);
    expect(signer.publicKey).toEqual(identityFromSeed(seedBytes).publicKey);
    expect(await signer.sign(message)).toEqual(sign(message, seedBytes));
    expect(() => seedSigner(randomBytes(31))).toThrow("32 bytes");
  });

  it("a non-extractable WebCrypto key signs what the JavaScript library verifies, and verifies what a seed signs", async () => {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]) as CryptoKeyPair;
    expect(pair.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("pkcs8", pair.privateKey)).rejects.toThrow();
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const signer = webCryptoSigner(pair.privateKey, publicKey);
    const signature = await signer.sign(message);
    expect(signature).toHaveLength(64);
    expect(verify(signature, message, publicKey)).toBe(true);
    expect(verify(signature, utf8Encode("another message"), publicKey)).toBe(false);
    // The other way round: WebCrypto verifies a signature the library made from a seed.
    const seedBytes = randomBytes(32), identity = identityFromSeed(seedBytes);
    const imported = await crypto.subtle.importKey("raw", new Uint8Array(identity.publicKey), { name: "Ed25519" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "Ed25519" }, imported, new Uint8Array(sign(message, seedBytes)), new Uint8Array(message))).toBe(true);
    expect(() => webCryptoSigner(pair.privateKey, publicKey.subarray(1))).toThrow("32 bytes");
  });
});
