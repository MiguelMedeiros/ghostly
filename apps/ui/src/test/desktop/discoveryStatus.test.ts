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
 * 2 s. An inviter's first envelope goes out before its first read (#1445): Rust is asked after the envelope, before any
 * read, and the read that lands a moment later must still reach the panel, though the pair goes live and nothing else
 * reads or writes for a while.
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

  it("shows a read that lands within 2 s of the last ask, and tells the panel", async () => {
    const transport = createTauriTransport();
    const heard: unknown[] = [];
    transport.subscribe!((change) => heard.push(change));
    await transport.publish({ seedB64: "", pubKeyZ32: key } as never, []);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.discovery!().path).toBeNull();

    await vi.advanceTimersByTimeAsync(500);
    await transport.resolve(key, { background: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(transport.discovery!().path).toEqual({ via: "dht" });
    // A path, not a relay tripping or recovering: the engine shows it (node.ts `emitState`), and no link looks again.
    expect(heard).toEqual([undefined]);
    // Rust was asked twice in those 2.5 s: once after the envelope, once when the spacing allowed.
    expect(tauri.invoke.mock.calls.filter(([command]) => command === "pkarr_status")).toHaveLength(2);
  });
});
