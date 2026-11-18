import { afterEach, describe, expect, it, vi } from "vitest";

// covers: delivery.hold.protocol

const invoke = vi.hoisted(() => vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(async () => undefined));
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  listen: async () => () => {},
  getIdentifier: async () => "tools.ghostly.app",
  convertFileSrc: (path: string) => path,
  Channel: class {},
}));
// The options the host is made with, as they are.
vi.mock("@ghostly/browser/inPageHost", () => ({ createInPageHost: (options: unknown) => options }));

import { HOLD_LIMITS } from "@ghostly/core";
import { createDesktopHost } from "../../desktop/host";

/*
 * A held item or manifest (WISP 404) is read from the address a contact chose. The WebView's `fetch` cannot see what a
 * name resolves to, so Desktop reads it from Rust (`hold_fetch`, apps/desktop/src/hold_fetch.rs), which connects only
 * to public addresses, as the CLI's does.
 */

type Made = { node: { holdFetch?: typeof fetch } };
const holdFetch = () => {
  const made = (createDesktopHost("1.2.0") as unknown as Made).node.holdFetch;
  expect(made).toBeTypeOf("function");
  return made!;
};

afterEach(() => {
  invoke.mockReset();
  vi.unstubAllGlobals();
});

describe("the Desktop host's held-item reads", () => {
  it("go to Rust, never to the WebView's fetch", async () => {
    const page = vi.fn(async () => new Response("from the page"));
    vi.stubGlobal("fetch", page);
    invoke.mockImplementation(async (command) => command === "hold_fetch" ? { status: 200, bodyB64: btoa("held") } : undefined);
    const response = await holdFetch()("https://s3.example.com/b/o?X-Amz-Signature=x", { redirect: "error" });
    expect(invoke).toHaveBeenCalledWith("hold_fetch", { url: "https://s3.example.com/b/o?X-Amz-Signature=x" });
    expect(page).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("held");
  });

  it("answer the storage's status as it came: a redirect is not followed", async () => {
    invoke.mockImplementation(async () => ({ status: 302, bodyB64: "" }));
    const response = await holdFetch()(new URL("https://s3.example.com/b/o"));
    expect(response.status).toBe(302);
    expect(response.ok).toBe(false);
  });

  it("fail as a network problem when Rust refuses the address", async () => {
    invoke.mockImplementation(async () => { throw "unreachable: not a public address"; });
    await expect(holdFetch()("https://rebind.example.com/b/o")).rejects.toThrow(/not a public address/);
  });

  it("answer an item past the largest one as larger than it, not as a network problem", async () => {
    // A network problem is retried at the next poll, in order: the contact's later items would never come.
    invoke.mockImplementation(async () => { throw "The held item is too large"; });
    const response = await holdFetch()("https://s3.example.com/b/o");
    expect(response.ok).toBe(true);
    expect(Number(response.headers.get("content-length"))).toBeGreaterThan(HOLD_LIMITS.maxBundleBytes);
  });

  it("ask nothing once the pickup gave up", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(holdFetch()("https://s3.example.com/b/o", { signal: abort.signal })).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalledWith("hold_fetch", expect.anything());
  });
});
