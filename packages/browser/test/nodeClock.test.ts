import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import type { ServerTime, SignedPacket } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";

// covers: app.clock-off

/**
 * The engine says when this device's clock seems to be off (`EngineState.transport.clockOffMs`), from what its
 * transport's servers say of the time, and stops saying it once they agree with the clock again.
 */
let listener: ((time: ServerTime) => void) | null = null;
let unsubscribed = 0;
const transport = {
  publish: async () => {},
  resolve: async (): Promise<SignedPacket | null> => null,
  describe: () => ({ protocol: "fixture", relays: [] }),
  onServerTime: (next: (time: ServerTime) => void) => { listener = next; return () => { listener = null; unsubscribed++; }; },
};
/** A relay's answer as its `Date` header gives the time: the real one, while this device's clock reads `off` ms ahead. */
const says = (source: string, off: number) => { const now = Date.now(); listener!({ source, date: Math.floor((now - off) / 1000) * 1000, sent: now, received: now + 40 }); };

afterEach(async () => { listener = null; unsubscribed = 0; for (const link of await db.getLinks()) await db.deleteLink(link.id); });

it("says the clock is off once two relays say so, by how much and which way, and takes it back when they agree again", async () => {
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", undefined);
  const onState = vi.fn();
  const node = new GhostlyNode({ onState, onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false, nativeTransports: {} });
  try {
    await node.start();
    expect(listener, "the engine listens to its transport's servers").not.toBeNull();
    expect(node.getState().transport.clockOffMs).toBeUndefined();
    says("https://a.test", 2 * 60_000);
    expect(node.getState().transport.clockOffMs, "one relay alone").toBeUndefined();
    const states = onState.mock.calls.length;
    says("https://b.test", 2 * 60_000);
    const off = node.getState().transport.clockOffMs!;
    expect(Math.abs(off - 2 * 60_000)).toBeLessThan(2_000);
    await vi.waitFor(() => expect(onState.mock.calls.length, "the pages are told").toBeGreaterThan(states));
    // Behind reads as a negative amount.
    says("https://a.test", -10 * 60_000);
    says("https://b.test", -10 * 60_000);
    expect(node.getState().transport.clockOffMs).toBeLessThan(-9 * 60_000);
    // The clock was set right.
    says("https://a.test", 0);
    says("https://b.test", 0);
    expect(node.getState().transport.clockOffMs).toBeUndefined();
  } finally { await node.shutdown(); vi.unstubAllGlobals(); }
  expect(unsubscribed, "and stops listening when it shuts down").toBe(1);
}, 20_000);
