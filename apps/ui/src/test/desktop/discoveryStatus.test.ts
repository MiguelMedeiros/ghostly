import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveryStatus } from "@ghostly/core";

// covers: chat.paired.discovery-health

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
 * The connection panel's discovery path on Desktop is Rust's (`pkarr_status`), asked after reads and writes at most every
 * 2 s. A new chat's first writes go before its first reads (an inviter's first envelope since #1445, a joiner's claim):
 * Rust is asked after them, before any read, and the read that lands a moment later must reach the panel by the time
 * the pair is live, though nothing else reads or writes for a while.
 */
describe("the Desktop's discovery status", () => {
  const key = "y".repeat(52);
  let rust: DiscoveryStatus;
  beforeEach(() => {
    vi.useFakeTimers();
    // No relay: their health stays as it was, only the path changes.
    rust = { path: null, relays: [] };
    tauri.invoke.mockReset();
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === "pkarr_status") return structuredClone(rust);
      if (command === "resolve_records") { rust.path = { via: "dht" }; return null; }
      return undefined;
    });
  });
  afterEach(() => { vi.useRealTimers(); });

  const asked = () => tauri.invoke.mock.calls.filter(([command]) => command === "pkarr_status").length;

  it("shows the first read at once, though it lands within 2 s of the last ask, and tells the panel", async () => {
    const transport = createTauriTransport();
    const heard: unknown[] = [];
    transport.subscribe!((change) => heard.push(change));
    await transport.publish({ seedB64: "", pubKeyZ32: key } as never, []);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.discovery!().path).toBeNull();

    await vi.advanceTimersByTimeAsync(500);
    await transport.resolve(key, { background: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.discovery!().path).toEqual({ via: "dht" });
    // A path, not a relay tripping or recovering: the engine shows it (node.ts `emitState`), and no link looks again.
    expect(heard).toEqual([undefined]);
    expect(asked()).toBe(2);
  });

  it("asks about a later read when the 2 s are up, and not before", async () => {
    const transport = createTauriTransport();
    await transport.resolve(key, { background: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.discovery!().path).toEqual({ via: "dht" });

    // "Also use Pkarr relays" on: the next read goes through a relay.
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === "pkarr_status") return structuredClone(rust);
      if (command === "resolve_records") { rust.path = { via: "relay", relay: "http://127.0.0.1:46401" }; return null; }
      return undefined;
    });
    await vi.advanceTimersByTimeAsync(500);
    await transport.resolve(key);
    await transport.resolve(key);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.discovery!().path).toEqual({ via: "dht" });
    expect(asked()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(transport.discovery!().path).toEqual({ via: "relay", relay: "http://127.0.0.1:46401" });
    expect(asked()).toBe(2);
  });
});
