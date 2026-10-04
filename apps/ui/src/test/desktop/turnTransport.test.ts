import { beforeEach, describe, expect, it, vi } from "vitest";
import { toBase64Url } from "@ghostly/core";

// covers: devices.turn.read

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
// The UI suite points every @tauri-apps/api module at one stand-in (packages/browser/src/platform/tauri.ts).
vi.mock("@tauri-apps/api/core", () => ({
  getIdentifier: async () => "tools.ghostly.app",
  invoke: tauri.invoke,
  convertFileSrc: (path: string) => path,
  Channel: class {},
}));

import { createTauriTransport } from "../../desktop/host";

/**
 * The Desktop's turn path (WISP 06 § Publishing and reading): the engine in the WebView hands the turn record to
 * Rust's `turn_read` and `turn_put` (`apps/desktop/src/turn_network.rs`), never to the commands other records use.
 */
describe("the Desktop's transport and the turn record", () => {
  const key = "y".repeat(52);
  beforeEach(() => { tauri.invoke.mockReset(); });

  it("reads through turn_read: one answer per source, the DHT included, the packets as bytes", async () => {
    const packet = Uint8Array.from({ length: 80 }, (_, i) => i);
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command !== "turn_read") throw new Error(`unexpected ${command}`);
      return [
        { source: "dht", answered: true, payloads: [toBase64Url(packet)] },
        { source: "https://relay.test", answered: true, payloads: [], sequences: ["42"], stale: true },
        { source: "https://down.test", answered: false, payloads: [], detail: "timed out" },
      ];
    });
    const answers = await createTauriTransport().turnRead!(key);
    expect(answers).toEqual([
      { source: "dht", answered: true, payloads: [packet] },
      { source: "https://relay.test", answered: true, payloads: [], sequences: ["42"], stale: true },
      { source: "https://down.test", answered: false, payloads: [], detail: "timed out" },
    ]);
    expect(tauri.invoke.mock.calls).toEqual([["turn_read", { publicKeyZ32: key }]]);
    // The read a raising put acts on gives each source less time.
    await createTauriTransport().turnRead!(key, { timeoutMs: 5_000 });
    expect(tauri.invoke.mock.calls[1]).toEqual(["turn_read", { publicKeyZ32: key, timeoutMs: 5_000 }]);
    // A profile with a device set has the turn's DHT node made ahead of its first read.
    tauri.invoke.mockResolvedValue(undefined);
    await createTauriTransport().turnWarm!();
    expect(tauri.invoke.mock.calls[tauri.invoke.mock.calls.length - 1]).toEqual(["turn_warm"]);
  });

  it("puts through turn_put with each source's condition, and hands back every source's answer", async () => {
    const payload = Uint8Array.from({ length: 100 }, (_, i) => 255 - i);
    const puts = [{ source: "dht", outcome: "refused", detail: "301" }, { source: "https://relay.test", outcome: "stored", detail: "HTTP 204" }];
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command !== "turn_put") throw new Error(`unexpected ${command}`);
      return puts;
    });
    const conditions = { dht: "41943040", "https://relay.test": null };
    expect(await createTauriTransport().turnPut!(key, payload, conditions)).toEqual(puts);
    // One call: a refusal is an answer, and nothing here sends it again.
    expect(tauri.invoke.mock.calls).toEqual([["turn_put", { publicKeyZ32: key, payloadB64: toBase64Url(payload), conditions }]]);
  });
});
