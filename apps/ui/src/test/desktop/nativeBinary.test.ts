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
    await channel.drained();
    expect(tauri.invoke.mock.calls.filter(([command]) => command === "paired_hyperdht_send").map(([, args]) => args)).toEqual([
      { endpointId: 1, connectionId: 7, bytes: "BAD/Cg==" },
      { endpointId: 1, connectionId: 7, text: "{\"t\":\"ping\"}" },
    ]);
    tauri.channels[0].onmessage!({ type: "frame", id: 7, bytes: "BAD/Cg==" });
    tauri.channels[0].onmessage!({ type: "frame", id: 7, text: "hello" });
    expect(heard).toEqual([new Uint8Array([0x04, 0, 255, 10]), "hello"]);
  });

  it("Iroh's carries text only: nothing binary is offered on it, and none is sent", async () => {
    const { channel } = await incoming(createIrohEndpoint);
    expect(channel.binary).toBeFalsy();
    expect(() => channel.send(new Uint8Array([0x04, 1]))).toThrow();
  });
});
