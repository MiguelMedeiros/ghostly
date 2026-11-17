import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import type { PkarrTransport } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
// covers: devices.remove

/*
 * A move of the device set (Remove, New device secret, the automatic one) is one at a time: each plans the next set from
 * the record it reads, and a second one planned from the same record would overwrite the first. The busy mark is taken
 * when the move begins, before a Remove reads the record, so a change asked for during that read is refused. The ports
 * of the move are a stand-in that holds until released, then has none (the move stops there).
 */

const transport: PkarrTransport = {
  publish: async () => {}, publishPayload: async () => {}, resolve: async () => null, describe: () => ({ protocol: "none", relays: [] }),
  turnRead: async () => [], turnPut: async () => [],
};

const PHONE = "P".repeat(43), LAPTOP = "L".repeat(43);

function engine() {
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onDeviceGate: vi.fn() }, { transport, automaticWallets: false });
  const inner = node as unknown as { settings: { online: boolean }; setMovePorts: () => Promise<null> };
  inner.settings.online = true;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ports = vi.fn(async () => { await held; return null; });
  inner.setMovePorts = ports;
  return { node, ports, release };
}

describe("a move of the device set, one at a time", () => {
  it("a second Remove or a new device secret asked while a Remove reads the record is refused, and only one move runs", async () => {
    const { node, ports, release } = engine();
    const first = node.deviceRemove({ key: PHONE }).catch((error: Error) => error);
    const second = node.deviceRemove({ key: LAPTOP }).catch((error: Error) => error);
    const again = node.deviceRemove({ key: PHONE }).catch((error: Error) => error);
    const secret = node.deviceNewSecret().catch((error: Error) => error);
    release();
    expect(String(await first)).toMatch(/remove-state: /);
    expect(String(await second)).toMatch(/remove-busy: /);
    expect(String(await again)).toMatch(/remove-busy: /);
    expect(String(await secret)).toMatch(/remove-busy: /);
    expect(ports).toHaveBeenCalledTimes(1);
    await node.shutdown();
  });

  it("Add a device asked while a Remove reads the record is refused", async () => {
    const { node, release } = engine();
    const first = node.deviceRemove({ key: PHONE }).catch((error: Error) => error);
    await expect(node.deviceEnrollInvite({ name: "Mac" })).rejects.toThrow(/^enroll-busy: /);
    release();
    expect(String(await first)).toMatch(/remove-state: /);
    await node.shutdown();
  });

  it("free again once the move stopped", async () => {
    const { node, ports, release } = engine();
    release();
    expect(String(await node.deviceRemove({ key: PHONE }).catch((error: Error) => error))).toMatch(/remove-state: /);
    expect(String(await node.deviceNewSecret().catch((error: Error) => error))).toMatch(/remove-state: /);
    expect(ports).toHaveBeenCalledTimes(2);
    await node.shutdown();
  });
});
