import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoundChannel } from "@ghostly/core";

// covers: files.large.binary, transport.hyperdht

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), channels: [] as { onmessage: ((event: unknown) => void) | null }[] }));
vi.mock("@tauri-apps/api/core", () => ({
  getIdentifier: async () => "tools.ghostly.app",
  invoke: tauri.invoke,
  convertFileSrc: (path: string) => path,
  Channel: class { onmessage: ((event: unknown) => void) | null = null; constructor() { tauri.channels.push(this); } },
}));

import { createHyperEndpoint, createIrohEndpoint } from "../../desktop/nativeTransports";

/** A contact's connection, as Rust opens it on the page. */
async function incoming(create: typeof createHyperEndpoint) {
  const endpoint = await create("c2VlZA");
  const connections: BoundChannel[] = [];
  endpoint.onConnection = (bound) => connections.push(bound);
  tauri.channels[0].onmessage!({ type: "open", id: 7, binding: { transport: "hyperdht/1", context: "aa", identities: [] }, incoming: true });
  const { channel } = connections[0];
  const heard: (string | Uint8Array)[] = [];
  channel.onMessage = (data) => heard.push(data);
  return { channel, heard };
}

describe("the Desktop's native channels and binary messages", () => {
  beforeEach(() => {
    tauri.channels.length = 0;
    tauri.invoke.mockReset();
    tauri.invoke.mockImplementation(async (command: string) => command.endsWith("_start") ? { id: 1, descriptor: { publicKey: "ab".repeat(32) } } : null);
  });

  it("HyperDHT's carries them: a binary message goes to Rust as bytes and comes back as one", async () => {
    const { channel, heard } = await incoming(createHyperEndpoint);
    expect(channel.binary).toBe(true);
    channel.send(new Uint8Array([0x04, 0, 255, 10]));
    channel.send("{\"t\":\"ping\"}");
    await vi.waitFor(() => expect(tauri.invoke.mock.calls.filter(([command]) => command === "paired_hyperdht_send").map(([, args]) => args)).toEqual([
      { endpointId: 1, connectionId: 7, seq: 1, bytes: "BAD/Cg==" },
      { endpointId: 1, connectionId: 7, seq: 2, text: "{\"t\":\"ping\"}" },
    ]));
    tauri.channels[0].onmessage!({ type: "frame", id: 7, bytes: "BAD/Cg==" });
    tauri.channels[0].onmessage!({ type: "frame", id: 7, text: "hello" });
    expect(heard).toEqual([new Uint8Array([0x04, 0, 255, 10]), "hello"]);
  });

  it("HyperDHT's keeps several frames in flight: each counts against the budget until the runtime says it went", async () => {
    // Rust answers a send once it queued it for the runtime; the runtime says `sent` later, once its socket has room.
    const sends: { seq: number }[] = [];
    tauri.invoke.mockImplementation(async (command: string, args: { seq: number }) => {
      if (command.endsWith("_start")) return { id: 1, descriptor: { publicKey: "ab".repeat(32) } };
      if (command === "paired_hyperdht_send") sends.push(args);
      return null;
    });
    const { channel } = await incoming(createHyperEndpoint);
    const frame = new Uint8Array(16 * 1024);
    for (let i = 0; i < 6; i++) channel.send(frame);
    await vi.waitFor(() => expect(sends).toHaveLength(6));
    // All six reached Rust before the runtime said anything: no round trip to the runtime per frame.
    expect(channel.bufferedAmount).toBe(6 * frame.length);
    let room = false;
    void channel.drained().then(() => { room = true; });
    const sent = (seq: number) => tauri.channels[0].onmessage!({ type: "sent", id: 7, seq });
    for (const { seq } of sends.slice(0, 2)) sent(seq);
    await Promise.resolve();
    expect(channel.bufferedAmount).toBe(4 * frame.length);
    expect(room).toBe(false);
    // Room again once under a quarter of the budget (what a file may hold in it).
    sent(sends[2].seq);
    await vi.waitFor(() => expect(room).toBe(true));
    expect(channel.bufferedAmount).toBe(3 * frame.length);
    for (const { seq } of sends.slice(3, 5)) sent(seq);
    // A frame the runtime could not send closes the channel, as a refused send did.
    let closed = false;
    channel.onClose = () => { closed = true; };
    tauri.channels[0].onmessage!({ type: "unsent", id: 7, seq: sends[5].seq, message: "Native channel is closed" });
    expect(closed).toBe(true);
    expect(channel.bufferedAmount).toBe(0);
  });

  it("HyperDHT's lets a file have four 16 KiB chunks on the way, as each waits for a trip to the runtime and back", async () => {
    const { channel } = await incoming(createHyperEndpoint);
    // What a file may hold on a channel: a quarter of its send budget (WISP 501, Backpressure; ghostlink.ts `filesCap`).
    // With two, a file went at two chunks per round trip, 25% slower than when a frame counted only until Rust queued it.
    const files = channel.sendBudget! / 4;
    let chunks = 0;
    while (channel.bufferedAmount < files) { channel.send(new Uint8Array(16 * 1024)); chunks++; }
    expect(chunks).toBe(4);
  });

  it("Iroh's carries text only: nothing binary is offered on it, and none is sent", async () => {
    const { channel } = await incoming(createIrohEndpoint);
    expect(channel.binary).toBeFalsy();
    expect(() => channel.send(new Uint8Array([0x04, 1]))).toThrow();
    // Its frames count only until Rust answers: its budget is not HyperDHT's.
    expect(channel.sendBudget).toBe(120 * 1024);
  });
});
