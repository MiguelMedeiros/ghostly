import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { toBase64Url } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { firstRecord } from "../src/devices/state";
import { readDeviceRecord } from "../src/devices/store";
import { databaseName, setDatabaseName } from "../src/shared/idb";
import { putDeviceRecord } from "./helpers/deviceRecord";
// covers: devices.handoff

/*
 * The engine's side of a Cancel on the giver's "Ready" step (`GiverPorts.quiesce`, `QuiesceCancel`): the freeze asks
 * whether Cancel was pressed just before it stops, and once `releasing` is written it lets the giver put the record
 * back before the pages start again. The giver's side runs in `deviceHandoff.test.ts`.
 */

type Cancel = { asked(): boolean; undo(): Promise<void> };
type Engine = {
  quiesceForHandoff(patch: object, taker?: unknown, cancel?: Cancel): Promise<{ why: string } | null | void>;
  cancelPendingReviews(): Promise<void>;
  shutdown(options?: object): Promise<void>;
  refreshWallet(): Promise<void>;
  handoffPlan(): Promise<{ wallets: unknown[] }>;
  cardFacts(): Promise<{ pinned: string[]; breez: Map<string, string> }>;
};

const A = toBase64Url(new Uint8Array(32).fill(0xa1)), B = toBase64Url(new Uint8Array(32).fill(0xb2));
const note = { handoff: { role: "releasing", step: "pass2", id: "h".repeat(22), peer: B, from: 7, secret: toBase64Url(new Uint8Array(32).fill(5)), at: Date.now() } };

/** An engine whose wallets and stop are stand-ins, with what it did in `order`. */
function engine(order: string[]): Engine {
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onDeviceGate: (view) => { order.push(`reload ${view.state}`); } }, { automaticWallets: false });
  const inner = node as unknown as Engine;
  inner.cancelPendingReviews = async () => {};
  inner.refreshWallet = async () => {};
  inner.handoffPlan = async () => ({ wallets: [] });
  inner.cardFacts = async () => ({ pinned: [], breez: new Map() });
  inner.shutdown = async () => { order.push("stop"); };
  return inner;
}

it("stops nothing and asks for no reload when Cancel was pressed while the freeze read the wallets", async () => {
  const order: string[] = [];
  const undo = vi.fn(async () => {});
  expect(await engine(order).quiesceForHandoff(note, undefined, { asked: () => true, undo })).toBeNull();
  expect(order).toEqual([]);
  expect(undo).not.toHaveBeenCalled();
});

it("lets the giver put the record back after `releasing` is written and before the pages start again", async () => {
  setDatabaseName("ghostly_quiesce_cancel");
  await putDeviceRecord(firstRecord(databaseName(), "active", { turn: 7, d: toBase64Url(new Uint8Array(32).fill(0xd0)), deviceSet: [{ key: A, name: "Desktop" }, { key: B, name: "Phone" }], ownSlot: 0, activeSlot: 0, turnPacket: "AAAA" }));
  const order: string[] = [];
  // Not pressed at the check before the stop; pressed while it stopped.
  let checks = 0;
  const cancel: Cancel = { asked: () => checks++ > 0, undo: async () => { order.push(`undo ${(await readDeviceRecord(databaseName()))?.state}`); } };
  expect(await engine(order).quiesceForHandoff(note, undefined, cancel)).toBeNull();
  expect(order).toEqual(["stop", "undo releasing", "reload releasing"]);
});
