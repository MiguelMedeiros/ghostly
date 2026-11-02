import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PkarrTransport } from "@ghostly/core";
import type { EnrollView } from "../src/devices/enroll";
import { GhostlyNode } from "../src/engine/node";
// covers: devices.enroll

/*
 * A grant that never finished, cut short by a second Add a device: the new device secret it calls for is made once
 * the second enrollment is over, while the engine runs, not at the next start. The enrollment itself is a stand-in
 * the test moves from step to step; the move of the set is counted, not made. Nothing leaves the process.
 */

const due = vi.hoisted(() => ({ grant: false }));
const inviters = vi.hoisted(() => [] as Array<{ show(view: EnrollView): void; options: { onChange?: (view: EnrollView) => void } }>);

vi.mock("../src/devices/rotate", async (original) => ({
  ...(await original<typeof import("../src/devices/rotate")>()),
  newDeviceSecretDue: () => (due.grant ? { why: "unfinished-grant", keys: ["phone-1"] } : null),
}));

vi.mock("../src/devices/enroll", async (original) => {
  const real = await original<typeof import("../src/devices/enroll")>();
  class FakeInviter {
    view: EnrollView = { role: "inviter", step: "waiting" } as EnrollView;
    constructor(readonly options: { onChange?: (view: EnrollView) => void }) { inviters.push(this); }
    show(view: EnrollView): void { this.view = view; this.options.onChange?.(view); }
    current(): EnrollView { return this.view; }
    async start(): Promise<EnrollView> { return this.view; }
    async cancel(): Promise<void> { if (this.view.step !== "done" && this.view.step !== "failed") this.show({ role: "inviter", step: "failed", reason: "cancelled" } as EnrollView); }
  }
  return { ...real, EnrollInviter: FakeInviter };
});

const transport: PkarrTransport = {
  publish: async () => {}, publishPayload: async () => {}, resolve: async () => null, describe: () => ({ protocol: "none", relays: [] }),
  turnRead: async () => [], turnPut: async () => [],
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(() => { inviters.splice(0); due.grant = false; vi.restoreAllMocks(); });

describe("Add a device started again while the first grant is still out", () => {
  it("makes the new device secret once the second enrollment is done", async () => {
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onDeviceGate: vi.fn() }, { transport, automaticWallets: false });
    const inner = node as unknown as { settings: { online: boolean }; moveDeviceSet(): Promise<unknown> };
    inner.settings.online = true;
    const moves = vi.spyOn(inner, "moveDeviceSet").mockResolvedValue({});

    await node.deviceEnrollInvite({ name: "Mac" });
    // Phone1 got the grant; its done never comes back.
    inviters[0].show({ role: "inviter", step: "adding", device: "Phone1" } as EnrollView);
    due.grant = true;
    // Try again: the first one is cancelled, and its move is refused while the second waits.
    await node.deviceEnrollInvite({ name: "Mac" });
    await tick();
    expect(inviters[0].view.step).toBe("failed");
    expect(moves).not.toHaveBeenCalled();

    // Phone2 finishes: nothing blocks the move any more.
    inviters[1].show({ role: "inviter", step: "adding", device: "Phone2" } as EnrollView);
    await tick();
    expect(moves).not.toHaveBeenCalled();
    inviters[1].show({ role: "inviter", step: "done", device: "Phone2", published: true } as EnrollView);
    await tick();
    expect(moves).toHaveBeenCalledTimes(1);
    await node.shutdown();
  });

  it("makes none after an enrollment that finished with no grant left out", async () => {
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onDeviceGate: vi.fn() }, { transport, automaticWallets: false });
    const inner = node as unknown as { settings: { online: boolean }; moveDeviceSet(): Promise<unknown> };
    inner.settings.online = true;
    const moves = vi.spyOn(inner, "moveDeviceSet").mockResolvedValue({});
    await node.deviceEnrollInvite({ name: "Mac" });
    inviters[0].show({ role: "inviter", step: "done", device: "Phone", published: true } as EnrollView);
    await tick();
    expect(moves).not.toHaveBeenCalled();
    await node.shutdown();
  });
});
