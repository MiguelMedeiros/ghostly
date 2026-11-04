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

  it("HyperDHT's counts a frame until Rust queued it, and holds a file back only while the runtime says its socket is full", async () => {
    // Rust answers a send once it queued it for the runtime; here, when the test lets it.
    const answers: (() => void)[] = [];
    tauri.invoke.mockImplementation((command: string) => {
      if (command.endsWith("_start")) return Promise.resolve({ id: 1, descriptor: { publicKey: "ab".repeat(32) } });
      if (command === "paired_hyperdht_send") return new Promise<null>((resolve) => answers.push(() => resolve(null)));
      return Promise.resolve(null);
    });
    const { channel } = await incoming(createHyperEndpoint);
    const frame = new Uint8Array(16 * 1024);
    for (let i = 0; i < 6; i++) channel.send(frame);
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    expect(channel.bufferedAmount).toBe(6 * frame.length);
    // Each answer frees its frame: the runtime says nothing for a frame that found room, as a word back for each
    // cost a file about a fifth of its speed.
    while (channel.bufferedAmount > 0) { answers.shift()?.(); await new Promise((resolve) => setTimeout(resolve, 0)); }
    await channel.drained();
    // The runtime's socket is full: a file's quarter of the budget counts until it has room, and a message still fits.
    const event = tauri.channels[0].onmessage!;
    event({ type: "full", id: 7 });
    expect(channel.bufferedAmount).toBe(channel.sendBudget! / 4);
    let room = false;
    void channel.drained().then(() => { room = true; });
    channel.send("{\"t\":\"ping\"}");
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    answers.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(room).toBe(false);
    event({ type: "room", id: 7 });
    await vi.waitFor(() => expect(room).toBe(true));
    expect(channel.bufferedAmount).toBe(0);
    // A frame the runtime could not send closes the channel, as a refused send did.
    let closed = false;
    channel.onClose = () => { closed = true; };
    event({ type: "full", id: 7 });
    event({ type: "unsent", id: 7, seq: 7, message: "Native channel is closed" });
    expect(closed).toBe(true);
    expect(channel.bufferedAmount).toBe(0);
  });

  it("Iroh's carries text only: nothing binary is offered on it, and none is sent", async () => {
    const { channel } = await incoming(createIrohEndpoint);
    expect(channel.binary).toBeFalsy();
    expect(() => channel.send(new Uint8Array([0x04, 1]))).toThrow();
  });
});
