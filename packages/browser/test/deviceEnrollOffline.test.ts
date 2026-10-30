import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDeviceGate } from "../src/devices/gate";
import { createPeerServer } from "../src/devices/peer";
import { EngineServer } from "../src/engine/server";
import { FakeTurnNetwork } from "./helpers/turnNetwork";
import { DESKTOP_NETWORK, MemoryPkarr } from "../../core/test/support/pairingWorld";
// covers: devices.enroll

/*
 * Add a device and the network switch: turning the network off while the code waits stops the enrollment, and its
 * one-time link reads the relays no more. Nothing leaves the process.
 */

vi.mock("../src/platform/irohWeb", async (original) => ({
  ...(await original<typeof import("../src/platform/irohWeb")>()),
  createIrohWebEndpoint: async () => { throw new Error("No Iroh in this test"); },
}));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Add a device while the network is turned off", () => {
  it("stops the enrollment, says why, and reads the relays no more", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const pkarr = new MemoryPkarr(DESKTOP_NETWORK);
    const gate = await openDeviceGate("ghostly");
    // The turn of the device set is read and put elsewhere: only the one-time link's reads are counted.
    const turn = new FakeTurnNetwork();
    const transport = { ...pkarr.transport(), turnRead: turn.turnRead.bind(turn), turnPut: turn.turnPut.bind(turn) };
    const server = await createPeerServer({ transport, automaticWallets: false }, { gate }) as EngineServer;
    await server.ready;
    await server.node.updateSettings({ settings: { online: true } });
    const node = server.node as unknown as { startDeviceSet(): Promise<void>; deviceLinks: unknown };
    expect((await server.node.deviceEnrollInvite({ name: "MacBook" })).step).toBe("waiting");
    // The one-time link looks for the other device's packet.
    const before = pkarr.reads;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pkarr.reads).toBeGreaterThan(before);

    await server.node.updateSettings({ settings: { online: false } });
    expect(server.node.deviceEnrollView()).toMatchObject({ role: "inviter", step: "failed", reason: "offline" });
    const off = pkarr.reads;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pkarr.reads).toBe(off);

    // An enrollment that finished anyway (past its point of no return) starts no device links with the network off.
    await node.startDeviceSet();
    expect(node.deviceLinks).toBeFalsy();
    await server.stop();
  });
});
