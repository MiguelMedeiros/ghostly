import { afterEach, describe, expect, it, vi } from "vitest";

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

import { createDesktopHost } from "../../desktop/host";

/*
 * A group's call node (WISP 602) is the origin the group's admin named. The WebView's `fetch` cannot see what a name
 * resolves to, and takes any `https` origin, so Desktop sends the token and moderation requests from Rust
 * (`group_call_fetch`, apps/desktop/src/hold_fetch.rs), which connects only to public addresses, as the CLI's does.
 */

type Made = { node: { groupCallFetch?: typeof fetch } };
const groupCallFetch = () => {
  const made = (createDesktopHost("1.2.0") as unknown as Made).node.groupCallFetch;
  expect(made).toBeTypeOf("function");
  return made!;
};
const request = { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"v":1}', redirect: "error", credentials: "omit" } as const;

afterEach(() => {
  invoke.mockReset();
  vi.unstubAllGlobals();
});

describe("the Desktop host's requests to a group's call node", () => {
  it("go to Rust with their body, never to the WebView's fetch", async () => {
    const page = vi.fn(async () => new Response("from the page"));
    vi.stubGlobal("fetch", page);
    invoke.mockImplementation(async (command) => command === "group_call_fetch" ? { status: 200, contentType: "application/json", bodyB64: btoa('{"token":"t"}'), retryAfter: "" } : undefined);
    const response = await groupCallFetch()("https://sfu.example.com/sfu/group-token", request);
    expect(invoke).toHaveBeenCalledWith("group_call_fetch", { url: "https://sfu.example.com/sfu/group-token", body: '{"v":1}' });
    expect(page).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ token: "t" });
  });

  it("fail as an unreachable node when Rust refuses a name that leads to this machine or its network", async () => {
    invoke.mockImplementation(async () => { throw "unreachable: error trying to connect: 192.168.1.1 is not a public address"; });
    await expect(groupCallFetch()("https://192.168.1.1/sfu/group-token", request)).rejects.toThrow(TypeError);
  });

  it("keep a refusal's status and its Retry-After, and send nothing but a POST", async () => {
    invoke.mockImplementation(async () => ({ status: 429, contentType: "", bodyB64: "", retryAfter: "30" }));
    const response = await groupCallFetch()("https://sfu.example.com/sfu/group-moderate", request);
    expect([response.status, response.headers.get("retry-after")]).toEqual([429, "30"]);
    await expect(groupCallFetch()("https://sfu.example.com/x", { method: "GET" })).rejects.toThrow("Only POST is sent");
    expect(invoke.mock.calls.filter(([command]) => command === "group_call_fetch")).toHaveLength(1);
  });

  it("stop waiting at the engine's timeout", async () => {
    invoke.mockImplementation(() => new Promise(() => {}));
    await expect(groupCallFetch()("https://sfu.example.com/sfu/group-token", { ...request, signal: AbortSignal.timeout(10) })).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
