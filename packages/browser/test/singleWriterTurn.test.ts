import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PkarrTransport } from "@ghostly/core";

/*
 * A wallet database has one writer in the world (WISP 06 § Wallets): the active device opens a single-writer wallet
 * (Fedimint, Spark and the Breez source, Ark, Bark) only after a good turn read under 60 seconds old, on every network.
 * The read at start counts while it is fresh; otherwise the engine reads, and without a good read the wallets wait for
 * the next one. A profile on one device has no turn and opens them as before.
 */
// covers: devices.handoff.wallets

const gate = vi.hoisted(() => ({ state: "active" as string | undefined }));
vi.mock("../src/devices/gate", async (original) => ({ ...await original<object>(), knownDeviceGate: () => (gate.state ? { profile: "ghostly", state: gate.state, full: true, view: null } : undefined) }));
const { GhostlyNode } = await import("../src/engine/node");

const transport: PkarrTransport = { publish: async () => {}, publishPayload: async () => {}, resolve: async () => null, describe: () => ({ protocol: "none", relays: [] }) };

type Outcome = { kind: string; restricted?: boolean };
interface Inner {
  singleWriterTurn(): Promise<boolean>;
  openSingleWriters(): Promise<void>;
  noteGoodTurn(): void;
  singleWritersWaiting: boolean;
  walletsStarted: boolean;
  settings: { online?: boolean };
  deviceLinks: { turnKeeper(): Promise<{ check(atStart: boolean): Promise<Outcome> } | null> } | null;
  stopReplaced(view: unknown): Promise<void>;
  openWallets(network: string): void;
  turnGoodAt: number | null;
}

const nodes: InstanceType<typeof GhostlyNode>[] = [];
function engine(options: { turnReadAt?: number; online?: boolean; outcome?: Outcome } = {}) {
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false, ...(options.turnReadAt !== undefined ? { turnReadAt: options.turnReadAt } : {}) });
  nodes.push(node);
  const inner = node as unknown as Inner;
  inner.settings = { ...inner.settings, online: options.online ?? true };
  const check = vi.fn(async () => options.outcome ?? { kind: "go-on", restricted: false });
  inner.deviceLinks = { turnKeeper: async () => ({ check }) };
  const opened = vi.spyOn(inner, "openWallets").mockImplementation(() => {});
  const replaced = vi.spyOn(inner, "stopReplaced").mockResolvedValue();
  return { inner, check, opened, replaced };
}

afterEach(async () => { gate.state = "active"; for (const node of nodes.splice(0)) { (node as unknown as Inner).deviceLinks = null; await node.shutdown().catch(() => {}); } vi.restoreAllMocks(); });

describe("single-writer wallets open after a fresh turn read", () => {
  it("a profile on one device has no turn: they open with no read", async () => {
    gate.state = "single";
    const { inner, check } = engine();
    expect(await inner.singleWriterTurn()).toBe(true);
    expect(check).not.toHaveBeenCalled();
  });

  it("the read the active device made at start counts while it is under 60 seconds old", async () => {
    const { inner, check } = engine({ turnReadAt: Date.now() - 5_000 });
    expect(await inner.singleWriterTurn()).toBe(true);
    expect(check).not.toHaveBeenCalled();
  });

  it("an older read is not enough: the turn is read now, and only a good read that says this device opens them", async () => {
    const good = engine({ turnReadAt: Date.now() - 61_000 });
    expect(await good.inner.singleWriterTurn()).toBe(true);
    expect(good.check).toHaveBeenCalledWith(false);
    expect(good.inner.turnGoodAt).toBeGreaterThan(Date.now() - 1_000);
    const unreachable = engine({ outcome: { kind: "go-on", restricted: true } });
    expect(await unreachable.inner.singleWriterTurn()).toBe(false);
  });

  it("a read that says another device took the turn stops this one, and opens nothing", async () => {
    const { inner, replaced } = engine({ outcome: { kind: "gated" } });
    expect(await inner.singleWriterTurn()).toBe(false);
    // The keeper wrote what this device became; with no record of it in this test, there is nothing to show.
    expect(replaced).not.toHaveBeenCalled();
  });

  it("group admin work asks the same: a stale read is read again, a takeover read stops this device and refuses", async () => {
    const adminTurn = (inner: Inner, wait?: boolean) => (inner as unknown as { groups: { host: { adminTurn(id: string, o?: { wait?: boolean }): Promise<boolean> } } }).groups.host.adminTurn("g", wait === undefined ? undefined : { wait });
    const fresh = engine({ turnReadAt: Date.now() - 5_000 });
    expect(await adminTurn(fresh.inner)).toBe(true);
    expect(fresh.check).not.toHaveBeenCalled();
    const stale = engine({ turnReadAt: Date.now() - 61_000 });
    expect(await adminTurn(stale.inner)).toBe(true);
    expect(stale.check).toHaveBeenCalledWith(false);
    const taken = engine({ turnReadAt: Date.now() - 61_000, outcome: { kind: "gated" } });
    expect(await adminTurn(taken.inner)).toBe(false);
    const unreachable = engine({ turnReadAt: Date.now() - 61_000, outcome: { kind: "go-on", restricted: true } });
    expect(await adminTurn(unreachable.inner)).toBe(false);
    const offline = engine({ turnReadAt: Date.now() - 61_000, online: false });
    expect(await adminTurn(offline.inner)).toBe(false);
    expect(offline.check).not.toHaveBeenCalled();
  });

  it("a read that does not answer refuses after a bounded wait; the door does not wait at all; callers share one read", async () => {
    const adminTurn = (inner: Inner, wait?: boolean) => (inner as unknown as { groups: { host: { adminTurn(id: string, o?: { wait?: boolean }): Promise<boolean> } } }).groups.host.adminTurn("g", wait === undefined ? undefined : { wait });
    const { inner, check } = engine({ turnReadAt: Date.now() - 61_000 });
    let answer: (outcome: Outcome) => void = () => {};
    check.mockImplementation(() => new Promise<Outcome>((resolve) => { answer = resolve; }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // The door: no wait, and the read starts.
      expect(await adminTurn(inner, false)).toBe(false);
      const asked = adminTurn(inner);
      const again = adminTurn(inner);
      await vi.advanceTimersByTimeAsync(GhostlyNode.TURN_CONFIRM_WAIT_MS);
      expect(await asked).toBe(false);
      expect(await again).toBe(false);
      expect(check).toHaveBeenCalledTimes(1);
      // The read answers late, and good: it counts for the next ask, with no read of its own.
      answer({ kind: "go-on", restricted: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(await adminTurn(inner, false)).toBe(true);
      expect(check).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("offline, they wait; the next good read opens them", async () => {
    const { inner, check, opened } = engine({ online: false });
    inner.walletsStarted = true;
    await inner.openSingleWriters();
    expect(check).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
    expect(inner.singleWritersWaiting).toBe(true);
    inner.noteGoodTurn();
    await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(2));
    expect(inner.singleWritersWaiting).toBe(false);
  });
});
