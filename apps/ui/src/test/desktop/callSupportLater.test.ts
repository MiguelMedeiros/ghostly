import { describe, expect, it, vi } from "vitest";

// covers: calls.linux-native

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  listen: async () => () => {},
  getIdentifier: async () => "tools.ghostly.app",
  convertFileSrc: (path: string) => path,
  Channel: class {},
}));
// The options the host is made with, as they are, and its engine's start counted.
const started = vi.fn(async () => ({ send: () => {} }));
vi.mock("@ghostly/browser/inPageHost", () => ({ createInPageHost: (options: object) => ({ ...options, connect: started }) }));

import { createDesktopHost } from "../../desktop/host";
import { nativeDevices, type NativeCallSupport } from "../../desktop/nativeCalls";
import { deviceSource } from "../../lib/mediaDevices";

/*
 * On Linux, Rust's answer about calls starts GStreamer (0.6 s on a first launch): the host is made, and the page drawn,
 * before it comes. The engine starts with it, since it tells contacts whether this app takes calls.
 */

type Made = { node: { callsSupport?: boolean; callsUnavailable?: string }; callMedia?: unknown; connect(onMessage: () => void): Promise<unknown> };

function pending() {
  let answer!: (said: NativeCallSupport | null) => void;
  const said = new Promise<NativeCallSupport | null>((resolve) => { answer = resolve; });
  return { said, answer };
}

describe("the Desktop host before Rust has said whether calls work", () => {
  it("starts the engine once the answer is there, with calls on and the native media", async () => {
    started.mockClear();
    const { said, answer } = pending();
    const host = createDesktopHost("1.2.0", said) as unknown as Made;
    const connecting = host.connect(() => {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).not.toHaveBeenCalled();
    expect(host.callMedia).toBeUndefined();

    answer({ native: true, missing: null });
    await connecting;
    expect(started).toHaveBeenCalledTimes(1);
    expect(host.node.callsSupport).toBe(true);
    expect(host.callMedia).toBeDefined();
    expect(deviceSource()).toBe(nativeDevices);
  });

  it("tells the engine what to install when GStreamer lacks a plugin", async () => {
    const { said, answer } = pending();
    const host = createDesktopHost("1.2.0", said) as unknown as Made;
    answer({ native: true, missing: "Install gst-plugins-good" });
    await host.connect(() => {});
    expect(host.node).toMatchObject({ callsSupport: false, callsUnavailable: "Install gst-plugins-good" });
    expect(host.callMedia).toBeUndefined();
  });
});
