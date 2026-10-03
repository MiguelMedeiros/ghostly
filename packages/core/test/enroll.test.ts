import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import {
  DEVICE_INVITE_BYTES, DEVICE_INVITE_LIFETIME_S, createChatInvite, createDeviceInvite, deviceInviteJoinerKeyZ32, deviceInviteJoinerParams, encodeDeviceInvite,
  enrollCancelFrame, enrollCancelReason, enrollDigits, enrollGrantFrame, enrollHelloFrame, enrollMessage, enrollProofFrame, formatEnrollDigits, fromBase64Url,
  identityFromSeed, identityFromSeedB64, readDeviceInvite, readEnrollGrant, readEnrollHello, readInviteCode, seedSigner, toBase64Url, toZ32, utf8Encode,
  verifyEnrollProof, type DeviceInvite,
} from "../src/index";
import { readInviteCode as readInviteCode102 } from "./fixtures/invite-1.0.2";
// covers: devices.enroll.invite, devices.enroll.session

/*
 * Adding a device (WISP 06 § Adding a device): the code of version 2 and the frames of `enroll/1`, pinned by vectors.
 * `vectors/enroll.json` is what this file builds from fixed labels, checked in: write it again with
 * `ENROLL_VECTORS_WRITE=1 npx vitest run test/enroll.test.ts`. Every seed here is a test value made from a label.
 */

const FILE = fileURLToPath(new URL("./vectors/enroll.json", import.meta.url));
const seed = (label: string) => sha256(utf8Encode(`ghostly enroll vectors: ${label}`));
const NOW = 1_790_000_000;

/** A code from fixed values: what the vectors pin. */
function fixedInvite(expires = NOW + DEVICE_INVITE_LIFETIME_S): DeviceInvite {
  return {
    joinerSeedB64: toBase64Url(seed("joiner rendezvous")),
    linkKeyB64: toBase64Url(seed("link key")),
    inviterRendezvousZ32: identityFromSeed(seed("inviter rendezvous")).pubKeyZ32,
    inviterKey: identityFromSeed(seed("inviter device")).publicKey,
    flags: 1,
    expires,
  };
}
const inviter = seedSigner(seed("inviter device"));
const joiner = seedSigner(seed("joiner device"));
const HASH = bytesToHex(seed("transcript"));

interface Vectors {
  invite: { joinerSeed: string; linkKey: string; inviterRendezvousZ32: string; inviterKey: string; flags: number; expires: number; payload: string; code: string };
  enroll: { transcriptHash: string; inviterKey: string; joinerKey: string; message: string; digits: string; hello: Record<string, unknown>; proof: Record<string, unknown>; grant: Record<string, unknown> };
}

async function build(): Promise<Vectors> {
  const invite = fixedInvite();
  const code = encodeDeviceInvite(invite);
  const payload = new Uint8Array(DEVICE_INVITE_BYTES);
  payload.set(fromBase64Url(invite.joinerSeedB64), 0); payload.set(fromBase64Url(invite.linkKeyB64), 32);
  payload.set(identityFromSeed(seed("inviter rendezvous")).publicKey, 64); payload.set(invite.inviterKey, 96);
  payload[128] = 1; new DataView(payload.buffer).setUint32(129, invite.expires);
  const grant = enrollGrantFrame({
    d: seed("D"), set: [{ key: inviter.publicKey, name: "MacBook" }, null, { key: joiner.publicKey, name: "Phone" }], turn: 123_456_789, rev: 3,
    network: { relays: ["https://relay.example"], irohRelays: ["https://iroh.example"], iceServers: [{ urls: "turn:turn.example:3478", username: "u", credential: "c" }] },
  });
  return {
    invite: { joinerSeed: invite.joinerSeedB64, linkKey: invite.linkKeyB64, inviterRendezvousZ32: invite.inviterRendezvousZ32, inviterKey: toBase64Url(invite.inviterKey), flags: 1, expires: invite.expires, payload: bytesToHex(payload), code },
    enroll: {
      transcriptHash: HASH, inviterKey: toBase64Url(inviter.publicKey), joinerKey: toBase64Url(joiner.publicKey),
      message: new TextDecoder().decode(enrollMessage(HASH, inviter.publicKey, joiner.publicKey)),
      digits: enrollDigits(HASH, inviter.publicKey, joiner.publicKey),
      hello: await enrollHelloFrame(HASH, inviter.publicKey, joiner, { name: "Phone", kind: "web", app: "1.1.0" }),
      proof: await enrollProofFrame(HASH, inviter, joiner.publicKey),
      grant,
    },
  };
}

describe("device invite vectors", () => {
  it("match the checked-in file", async () => {
    const built = await build();
    if (process.env.ENROLL_VECTORS_WRITE === "1" || !existsSync(FILE)) writeFileSync(FILE, `${JSON.stringify(built, null, 2)}\n`);
    const file = JSON.parse(readFileSync(FILE, "utf8")) as Vectors;
    expect(built).toEqual(file);
    // The payload's bytes are the fields in order, then the flags and the expiry, big-endian.
    expect(file.invite.payload.length).toBe(DEVICE_INVITE_BYTES * 2);
    expect(file.invite.code.startsWith("ghostly1z")).toBe(true);
  });

  it("read back to the same fields", () => {
    const invite = fixedInvite();
    const reading = readDeviceInvite(encodeDeviceInvite(invite), NOW);
    expect(reading).toEqual({ ok: true, invite: { ...invite, inviterKey: new Uint8Array(invite.inviterKey) } });
  });

  it("reads a code in capitals, as a QR code holds it, and after a #", () => {
    const code = encodeDeviceInvite(fixedInvite());
    expect(readDeviceInvite(code.toUpperCase(), NOW).ok).toBe(true);
    expect(readDeviceInvite(`https://ghostly.tools/#${code}`, NOW).ok).toBe(true);
    expect(readDeviceInvite(` ${code}. `, NOW).ok).toBe(true);
  });
});

describe("device invite refusals", () => {
  const code = encodeDeviceInvite(fixedInvite());

  it("an app of version 1.0.2 refuses a device code as a newer version, and makes no chat of it", () => {
    expect(readInviteCode102(code)).toEqual({ ok: false, reason: "update", detail: "Version 2" });
    expect(readInviteCode102(code.toUpperCase())).toMatchObject({ ok: false, reason: "update" });
    expect(readInviteCode102(`https://ghostly.tools/#${code}`)).toMatchObject({ ok: false, reason: "update" });
  });

  it("this app's chat reader refuses it as a device code", () => {
    expect(readInviteCode(code)).toEqual({ ok: false, reason: "device" });
    expect(readInviteCode(`https://ghostly.tools/#${code.toUpperCase()}`)).toEqual({ ok: false, reason: "device" });
  });

  it("the device reader refuses a chat invite", () => {
    expect(readDeviceInvite(createChatInvite().inviteCode, NOW)).toEqual({ ok: false, reason: "chat" });
  });

  it("refuses a code past its time", () => {
    expect(readDeviceInvite(encodeDeviceInvite(fixedInvite(NOW)), NOW)).toEqual({ ok: false, reason: "expired" });
    expect(readDeviceInvite(encodeDeviceInvite(fixedInvite(NOW - 1)), NOW)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a code of a kind it does not know (no own-device flag), a typo, a damaged payload and a later version", () => {
    expect(readDeviceInvite(encodeDeviceInvite({ ...fixedInvite(), flags: 0 }), NOW)).toMatchObject({ ok: false, reason: "update" });
    const typo = code.slice(0, 20) + (code[20] === "q" ? "p" : "q") + code.slice(21);
    expect(readDeviceInvite(typo, NOW)).toEqual({ ok: false, reason: "typo" });
    expect(readDeviceInvite("npub1abc", NOW)).toEqual({ ok: false, reason: "not-ghostly" });
    expect(readDeviceInvite("hello", NOW)).toEqual({ ok: false, reason: "not-ghostly" });
  });
});

describe("a new code", () => {
  it("is good for ten minutes, and its two ends are the two ends of one link", () => {
    const side = createDeviceInvite(inviter.publicKey, NOW);
    expect(side.invite.expires).toBe(NOW + 600);
    const read = readDeviceInvite(side.code, NOW);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const joinerEnd = deviceInviteJoinerParams(read.invite);
    // Each end's rendezvous key is what the other waits for, and both seal with the same key.
    expect(joinerEnd.peerPubKeyZ32).toBe(identityFromSeedB64(side.params.seedB64).pubKeyZ32);
    expect(side.params.peerPubKeyZ32).toBe(identityFromSeedB64(joinerEnd.seedB64).pubKeyZ32);
    expect(side.params.peerPubKeyZ32).toBe(deviceInviteJoinerKeyZ32(read.invite));
    expect(joinerEnd.encKeyB64).toBe(side.params.encKeyB64);
    expect(toZ32(read.invite.inviterKey)).toBe(toZ32(inviter.publicKey));
  });
});

describe("enroll/1", () => {
  it("a hello is the joiner's, over this session and these two keys, and nothing else", async () => {
    const hello = await enrollHelloFrame(HASH, inviter.publicKey, joiner, { name: "A phone with a long name", kind: "web", app: "1.1.0" });
    const read = readEnrollHello(hello, HASH, inviter.publicKey, joiner.publicKey);
    expect(read).toMatchObject({ name: "A phone with a l", kind: "web", app: "1.1.0" });
    // Another session, another inviter, a key the session did not authenticate, a changed field: refused.
    expect(readEnrollHello(hello, bytesToHex(seed("another transcript")), inviter.publicKey, joiner.publicKey)).toBeNull();
    expect(readEnrollHello(hello, HASH, joiner.publicKey, joiner.publicKey)).toBeNull();
    expect(readEnrollHello(hello, HASH, inviter.publicKey, inviter.publicKey)).toBeNull();
    const other = seedSigner(seed("someone else"));
    expect(readEnrollHello({ ...hello, k: toBase64Url(other.publicKey) }, HASH, inviter.publicKey, other.publicKey)).toBeNull();
    // An unknown kind is read as web.
    const odd = await enrollHelloFrame(HASH, inviter.publicKey, joiner, { name: "Phone", kind: "web", app: "1.1.0" });
    expect(readEnrollHello({ ...odd, kind: "toaster" }, HASH, inviter.publicKey, joiner.publicKey)?.kind).toBe("web");
  });

  it("a proof is checked against the key in the code", async () => {
    const proof = await enrollProofFrame(HASH, inviter, joiner.publicKey);
    expect(verifyEnrollProof(proof, HASH, inviter.publicKey, joiner.publicKey)).toBe(true);
    // Signed by anyone else, for another session, or for another joiner: no proof, so no digits.
    const impostor = seedSigner(seed("impostor"));
    expect(verifyEnrollProof(await enrollProofFrame(HASH, impostor, joiner.publicKey), HASH, inviter.publicKey, joiner.publicKey)).toBe(false);
    expect(verifyEnrollProof(proof, bytesToHex(seed("another transcript")), inviter.publicKey, joiner.publicKey)).toBe(false);
    expect(verifyEnrollProof(proof, HASH, inviter.publicKey, impostor.publicKey)).toBe(false);
    expect(verifyEnrollProof({ t: "enroll-proof", s: "x" }, HASH, inviter.publicKey, joiner.publicKey)).toBe(false);
  });

  it("the digits are six, the same on both ends, and change with the session and with either key", () => {
    const digits = enrollDigits(HASH, inviter.publicKey, joiner.publicKey);
    expect(digits).toMatch(/^\d{6}$/);
    expect(formatEnrollDigits("482913")).toBe("482 913");
    expect(enrollDigits(bytesToHex(seed("another transcript")), inviter.publicKey, joiner.publicKey)).not.toBe(digits);
    expect(enrollDigits(HASH, seedSigner(seed("impostor")).publicKey, joiner.publicKey)).not.toBe(digits);
    expect(enrollDigits(HASH, inviter.publicKey, seedSigner(seed("impostor")).publicKey)).not.toBe(digits);
    // The first 32 bits, big-endian, modulo a million (the WISP's 20 bits would favour values under 48,576).
    const h = sha256(new Uint8Array([...utf8Encode("ghostly-enroll-digits"), ...seed("transcript"), ...inviter.publicKey, ...joiner.publicKey]));
    expect(Number(digits)).toBe(new DataView(h.buffer, h.byteOffset).getUint32(0) % 1_000_000);
  });

  it("a grant keeps every slot in its place and lists both devices once", () => {
    const frame = enrollGrantFrame({ d: seed("D"), set: [null, { key: inviter.publicKey, name: "MacBook" }, { key: joiner.publicKey, name: "Phone" }, null], turn: 5, rev: 2 });
    expect(frame.set).toEqual([null, [toBase64Url(inviter.publicKey), "MacBook"], [toBase64Url(joiner.publicKey), "Phone"]]);
    const read = readEnrollGrant(frame, inviter.publicKey, joiner.publicKey);
    expect(read).toMatchObject({ turn: 5, rev: 2, ownSlot: 2, inviterSlot: 1 });
    expect(read?.set[0]).toBeNull();
    // Not this joiner, not this inviter, a key twice, a turn out of range, five slots: refused.
    expect(readEnrollGrant(frame, inviter.publicKey, seedSigner(seed("impostor")).publicKey)).toBeNull();
    expect(readEnrollGrant(frame, seedSigner(seed("impostor")).publicKey, joiner.publicKey)).toBeNull();
    expect(readEnrollGrant({ ...frame, set: [[toBase64Url(inviter.publicKey), "A"], [toBase64Url(joiner.publicKey), "B"], [toBase64Url(joiner.publicKey), "C"]] }, inviter.publicKey, joiner.publicKey)).toBeNull();
    expect(readEnrollGrant({ ...frame, turn: 2 ** 32 - 1 }, inviter.publicKey, joiner.publicKey)).toBeNull();
    expect(readEnrollGrant({ ...frame, set: [null, null, null, [toBase64Url(inviter.publicKey), "A"], [toBase64Url(joiner.publicKey), "B"]] }, inviter.publicKey, joiner.publicKey)).toBeNull();
    expect(readEnrollGrant({ ...frame, d: "short" }, inviter.publicKey, joiner.publicKey)).toBeNull();
  });

  it("a grant carries the person's network settings, checked as the device record checks them", () => {
    const network = { off: true, relays: ["https://r.example"], readRelays: true, irohRelays: ["https://i.example"], iceServers: [{ urls: "turn:t.example", username: "u", credential: "c" }] };
    const frame = enrollGrantFrame({ d: seed("D"), set: [{ key: inviter.publicKey, name: "A" }, { key: joiner.publicKey, name: "B" }], turn: 5, rev: 0, network });
    expect(readEnrollGrant(frame, inviter.publicKey, joiner.publicKey)?.network).toEqual(network);
    // Without one, none; a malformed one refuses the grant.
    expect(readEnrollGrant({ ...frame, net: undefined }, inviter.publicKey, joiner.publicKey)?.network).toBeUndefined();
    for (const net of [{ relays: "x" }, { relays: Array(17).fill("x") }, { off: "yes" }, { iceServers: [{ urls: 3 }] }, [1]]) {
      expect(readEnrollGrant({ ...frame, net }, inviter.publicKey, joiner.publicKey)).toBeNull();
    }
  });

  it("a cancel says why, and an unknown reason is a failure", () => {
    expect(enrollCancelReason(enrollCancelFrame("digits"))).toBe("digits");
    expect(enrollCancelReason({ t: "enroll-cancel", why: "boredom" })).toBe("failed");
    expect(enrollCancelReason({ t: "enroll-done" })).toBeNull();
  });
});
