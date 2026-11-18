import { afterEach, describe, expect, it, vi } from "vitest";

// covers: proofs.share, profiles.public

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

import { boundedIdentityFetch } from "@ghostly/browser/proofs/verify";
import { createDesktopHost } from "../../desktop/host";

/*
 * A contact's identity proof and public data (WISP 300, PUBLIC-PROFILES.md) are read at the addresses the proof names.
 * The WebView's `fetch` cannot see what a name resolves to, so Desktop reads them from Rust (`hold_fetch`,
 * apps/desktop/src/hold_fetch.rs), which connects only to public addresses, as the CLI's does.
 */

type Made = { node: { identityFetch?: typeof fetch } };
const identityFetch = () => {
  const made = (createDesktopHost("1.2.0") as unknown as Made).node.identityFetch;
  expect(made).toBeTypeOf("function");
  return made!;
};
const read = () => boundedIdentityFetch({ online: () => true, fetcher: identityFetch() });

afterEach(() => {
  invoke.mockReset();
  vi.unstubAllGlobals();
});

describe("the Desktop host's identity reads", () => {
  it("go to Rust with what they accept, never to the WebView's fetch", async () => {
    const page = vi.fn(async () => new Response("from the page"));
    vi.stubGlobal("fetch", page);
    invoke.mockImplementation(async (command) => command === "hold_fetch" ? { status: 200, contentType: "application/did+json", bodyB64: btoa("{}") } : undefined);
    const answer = await read()("https://contact.example/.well-known/did.json", { headers: { accept: "application/did+json" } });
    expect(invoke).toHaveBeenCalledWith("hold_fetch", { url: "https://contact.example/.well-known/did.json", headers: [["accept", "application/did+json"]] });
    expect(page).not.toHaveBeenCalled();
    expect(answer).toMatchObject({ status: 200, contentType: "application/did+json", text: "{}" });
  });

  it("fail when Rust refuses a name that leads to this machine or its network", async () => {
    invoke.mockImplementation(async () => { throw "unreachable: error trying to connect: 192.168.1.10 is not a public address"; });
    await expect(read()("https://rebind.contact.example/.well-known/atproto-did")).rejects.toThrow(/not a public address/);
  });

  it("refuse a redirect, as the page's fetch does", async () => {
    invoke.mockImplementation(async () => ({ status: 302, contentType: "", bodyB64: "" }));
    await expect(read()("https://contact.example/.well-known/did.json")).rejects.toThrow(/Redirect refused/);
  });

  it("send nothing but a GET, and nothing once the read gave up", async () => {
    await expect(identityFetch()("https://contact.example/x", { method: "POST" })).rejects.toThrow(/GET/);
    const abort = new AbortController();
    abort.abort();
    await expect(identityFetch()("https://contact.example/x", { signal: abort.signal })).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalledWith("hold_fetch", expect.anything());
  });
});
