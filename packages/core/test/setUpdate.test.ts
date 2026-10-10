import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import {
  readSetUpdate, readTurnPacket, seedSigner, setAckFrame, setUpdateFrame, setUpdateMessage, signTombstone, toBase64Url, turnKeys, utf8Encode, verifySetUpdate,
  TOMBSTONE_SEQUENCE, TOMBSTONE_TURN, TURN_NO_ACTIVE, type DeviceFrame,
} from "../src/index";
// covers: devices.remove.frame

/*
 * Removing a device (WISP 06 § Removing a device): the tombstone and the signed `set-update`, pinned by vectors.
 * `vectors/set-update.json` is what this file builds from fixed labels, checked in: write it again with
 * `SET_UPDATE_VECTORS_WRITE=1 npx vitest run test/setUpdate.test.ts`. Every seed here is a test value made from a label.
 */

const FILE = fileURLToPath(new URL("./vectors/set-update.json", import.meta.url));
const seed = (label: string) => sha256(utf8Encode(`ghostly set-update vectors: ${label}`));
const remover = seedSigner(seed("remover device"));
const staying = seedSigner(seed("staying device"));
const removed = seedSigner(seed("removed device"));
const oldD = seed("old D"), newD = seed("new D");
const oldKeys = turnKeys(oldD);
const sign = (signer: typeof remover) => (bytes: Uint8Array) => signer.sign(bytes);

async function tombstone(): Promise<Uint8Array> {
  return signTombstone(oldKeys, 0, [{ key: remover.publicKey, name: "MacBook" }, null, { key: staying.publicKey, name: "Phone" }], sign(remover), { instance: seed("instance").slice(0, 8), nonce: seed("nonce").slice(0, 24) });
}

async function frame(tomb: Uint8Array): Promise<DeviceFrame> {
  return setUpdateFrame(oldKeys.address, { d: newD, set: [{ key: remover.publicKey, name: "MacBook" }, null, { key: staying.publicKey, name: "Phone" }], turn: 123_456_789, rev: 0, tomb }, remover);
}

interface Vectors { oldAddress: string; tombstone: string; message: string; frame: Record<string, unknown>; ack: Record<string, unknown> }

async function build(): Promise<Vectors> {
  const tomb = await tombstone();
  const built = await frame(tomb);
  const update = readSetUpdate(built)!;
  return { oldAddress: toBase64Url(oldKeys.address), tombstone: toBase64Url(tomb), message: new TextDecoder().decode(setUpdateMessage(oldKeys.address, update)), frame: built, ack: setAckFrame() };
}

describe("set-update vectors", () => {
  it("match the checked-in file", async () => {
    const built = await build();
    if (process.env.SET_UPDATE_VECTORS_WRITE === "1" || !existsSync(FILE)) writeFileSync(FILE, `${JSON.stringify(built, null, 2)}\n`);
    expect(built).toEqual(JSON.parse(readFileSync(FILE, "utf8")) as Vectors);
    expect(built.message.startsWith("[\"ghostly-set-update\",")).toBe(true);
  });
});

describe("the tombstone", () => {
  it("is a valid record at the one sequence 2^52 - 1, with no active device, listing only the devices that stay", async () => {
    const read = readTurnPacket(oldKeys, await tombstone());
    expect(read.kind).toBe("valid");
    if (read.kind !== "valid") return;
    expect(read.sequence).toBe(BigInt(TOMBSTONE_SEQUENCE));
    expect(read.record).toMatchObject({ tombstone: true, turn: TOMBSTONE_TURN, active: TURN_NO_ACTIVE, rev: 0, author: 0 });
    expect(read.record.release).toBeUndefined();
    expect(read.record.slots.map((slot) => slot && toBase64Url(slot.key))).toEqual([toBase64Url(remover.publicKey), null, toBase64Url(staying.publicKey), null]);
    expect(read.record.slots.some((slot) => slot && toBase64Url(slot.key) === toBase64Url(removed.publicKey))).toBe(false);
  });

  it("is under the old address only: the new secret's keys do not open it", async () => {
    expect(readTurnPacket(turnKeys(newD), await tombstone()).kind).toBe("foreign");
  });
});

describe("the set-update frame", () => {
  it("reads back to what was signed, and verifies for the old address only", async () => {
    const tomb = await tombstone();
    const update = readSetUpdate(await frame(tomb))!;
    expect(update).not.toBeNull();
    expect(toBase64Url(update.d)).toBe(toBase64Url(newD));
    expect(toBase64Url(update.by)).toBe(toBase64Url(remover.publicKey));
    expect(toBase64Url(update.tomb)).toBe(toBase64Url(tomb));
    expect(update.set[1]).toBeNull();
    expect(verifySetUpdate(update, oldKeys.address)).toBe(true);
    expect(verifySetUpdate(update, turnKeys(newD).address)).toBe(false);
  });

  it("does not verify once any signed field changed, or when another key claims it", async () => {
    const tomb = await tombstone();
    const good = await frame(tomb);
    const changed: DeviceFrame[] = [
      { ...good, d: toBase64Url(seed("another D")) },
      { ...good, turn: 123_456_790 },
      { ...good, rev: 1 },
      { ...good, set: [[toBase64Url(remover.publicKey), "MacBook"], [toBase64Url(removed.publicKey), "Tablet"], [toBase64Url(staying.publicKey), "Phone"]] },
      { ...good, tomb: toBase64Url(new Uint8Array([...tomb.slice(0, -1), tomb[tomb.length - 1] ^ 1])) },
      { ...good, by: toBase64Url(removed.publicKey) },
    ];
    for (const forged of changed) {
      const update = readSetUpdate(forged);
      expect(update && verifySetUpdate(update, oldKeys.address)).toBeFalsy();
    }
  });

  it("shows its names cleaned, and still verifies the names as its remover signed them", async () => {
    const tomb = await tombstone();
    const good = await frame(tomb);
    // What a build that does not clean names signs: the set as it holds it.
    const set = [[toBase64Url(remover.publicKey), "MacBook"], null, [toBase64Url(staying.publicKey), "\u202EenohP\n\x07"]];
    const message = utf8Encode(JSON.stringify(["ghostly-set-update", toBase64Url(oldKeys.address), toBase64Url(newD), set, 123_456_789, 0, toBase64Url(sha256(tomb))]));
    const update = readSetUpdate({ ...good, set, s: toBase64Url(await remover.sign(message)) })!;
    expect(update.set.map((slot) => slot?.name)).toEqual(["MacBook", undefined, "enohP"]);
    expect(verifySetUpdate(update, oldKeys.address)).toBe(true);
    // The names are still signed: the same frame under the signature of the clean names is refused.
    const other = readSetUpdate({ ...good, set })!;
    expect(verifySetUpdate(other, oldKeys.address)).toBe(false);
    // A remover of this build signs the clean names, whatever its own record held.
    const made = await setUpdateFrame(oldKeys.address, { d: newD, set: [{ key: remover.publicKey, name: "MacBook" }, null, { key: staying.publicKey, name: "\u202EenohP\n\x07" }], turn: 1, rev: 0, tomb }, remover);
    expect(made.set).toEqual([[toBase64Url(remover.publicKey), "MacBook"], null, [toBase64Url(staying.publicKey), "enohP"]]);
    expect(verifySetUpdate(readSetUpdate(made)!, oldKeys.address)).toBe(true);
  });

  it("is refused when it is not well formed", async () => {
    const good = await frame(await tombstone());
    const bad: DeviceFrame[] = [
      { ...good, t: "set-ack" },
      { ...good, d: "short" },
      { ...good, set: [] },
      { ...good, set: [[toBase64Url(remover.publicKey), "A"], [toBase64Url(remover.publicKey), "B"]] },
      { ...good, set: [null, null, null, null, null] },
      { ...good, set: [[toBase64Url(remover.publicKey), "a name much longer than sixteen bytes"]] },
      { ...good, set: [[toBase64Url(remover.publicKey), "a\0b"]] },
      { ...good, turn: 2 ** 32 - 1 },
      { ...good, rev: 2 ** 18 },
      { ...good, tomb: "" },
      { ...good, s: "x" },
    ];
    for (const frame of bad) expect(readSetUpdate(frame)).toBeNull();
  });
});
