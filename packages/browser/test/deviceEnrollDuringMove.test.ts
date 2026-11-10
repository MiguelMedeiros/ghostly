import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PkarrTransport } from "@ghostly/core";
import type { EnrollView } from "../src/devices/enroll";
import type { HandoffView } from "../src/devices/handoff";
import { GhostlyNode } from "../src/engine/node";
// covers: devices.enroll

/*
 * Add a device while the profile is moving to another device. Until the move ends this device may freeze at any moment
 * (pass 1 confirmed), and a grant sent just before that never finishes: the new device holds the set's secret, is in no
 * record, and the note that would move the set to a new secret stays on this device, now a standby, where nothing acts
 * on it. So Add a device waits for the move, as Rename and Remove already do. The enrollment and the move are stand-ins.
 */

const inviters = vi.hoisted(() => [] as unknown[]);

vi.mock("../src/devices/enroll", async (original) => {
  const real = await original<typeof import("../src/devices/enroll")>();
  class FakeInviter {
    view: EnrollView = { role: "inviter", step: "waiting" } as EnrollView;
    constructor() { inviters.push(this); }
    current(): EnrollView { return this.view; }
    async start(): Promise<EnrollView> { return this.view; }
    async cancel(): Promise<void> {}
  }
  return { ...real, EnrollInviter: FakeInviter };
});

const transport: PkarrTransport = {
  publish: async () => {}, publishPayload: async () => {}, resolve: async () => null, describe: () => ({ protocol: "none", relays: [] }),
  turnRead: async () => [], turnPut: async () => [],
};

const moving = (step: HandoffView["step"]): HandoffView => ({ role: "giver", device: "Phone", key: "phone-key", step, bytes: 0, total: 100 });

afterEach(() => { inviters.splice(0); });

describe("Add a device while the profile moves", () => {
  function node(view: HandoffView | null) {
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onDeviceGate: vi.fn() }, { transport, automaticWallets: false });
    const inner = node as unknown as { settings: { online: boolean }; handoffGiver: { view(): HandoffView | null } | null };
    inner.settings.online = true;
    inner.handoffGiver = { view: () => view };
    return node;
  }

  it("is refused while the move copies, with no code made", async () => {
    const engine = node(moving("copying"));
    await expect(engine.deviceEnrollInvite({ name: "Mac" })).rejects.toThrow(/^enroll-busy: /);
    expect(inviters).toHaveLength(0);
    await engine.shutdown();
  });

  it("is refused while the other device checks the password", async () => {
    const engine = node(moving("authorizing"));
    await expect(engine.deviceEnrollInvite({ name: "Mac" })).rejects.toThrow(/^enroll-busy: /);
    await engine.shutdown();
  });

  it("is refused while a Remove or a new device secret moves the set (the code would carry the old secret)", async () => {
    const engine = node(null);
    (engine as unknown as { settingMove: Promise<unknown> | null }).settingMove = new Promise(() => {});
    await expect(engine.deviceEnrollInvite({ name: "Mac" })).rejects.toThrow(/^enroll-busy: /);
    expect(inviters).toHaveLength(0);
    await engine.shutdown();
  });

  it("goes on once the move stopped, and with none", async () => {
    for (const view of [{ ...moving("failed"), failure: "cancelled" } as HandoffView, null]) {
      const engine = node(view);
      expect((await engine.deviceEnrollInvite({ name: "Mac" })).step).toBe("waiting");
      await engine.shutdown();
    }
    expect(inviters).toHaveLength(2);
  });
});
