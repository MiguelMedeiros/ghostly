import { describe, expect, it, vi } from "vitest";
import { MINI_APP_LIMITS } from "@ghostly/core/miniApp";
import { APP_CLOSED_EVENT, APP_REQUEST_EVENT, desktopOpener, forIpc, toBase64 } from "../../lib/apps/desktopOpener";
import { memoryAppId, memoryHost } from "../../lib/apps/memoryHost";
import type { AppEntry } from "../../lib/platform";

// covers: apps.desktop-sandbox

/**
 * Desktop's opener (WISP 1200, Desktop row): the web broker in the Ghostly window, one per app window, reached through
 * Rust (apps/desktop/src/app_sandbox.rs). Rust is played here: `app_open` answers a label, the window's requests come
 * as `ghostly-app-request` events with that label, and what the broker sends goes to `app_post`.
 */
const REF = "pubkeyalpha/chess";
const LINK = "link-1";

function setup(entry: Partial<AppEntry> = {}) {
  const host = memoryHost("ghostly-app://localhost/", "ghostly-app://localhost/");
  host.entry = async (ref) => ({ ref, digest: "d", version: "1.2.0", title: "Chess", permissions: ["chat"], entry: "<p>chess</p>", ...entry });
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  let labels = 0;
  const hooks: { opened?: (label: string) => void } = {};
  const invoke = vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    if (command === "app_open") {
      const label = `app-${++labels}`;
      hooks.opened?.(label);
      return label;
    }
    return undefined;
  }) as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  const listen = async <T,>(event: string, handler: (event: { payload: T }) => void) => { handlers.set(event, handler as (event: { payload: unknown }) => void); return () => {}; };
  const stops: string[] = [];
  const open = desktopOpener({ apps: () => host, invoke, listen, onStop: (_, reason) => stops.push(reason), view: { theme: () => "light", locale: () => "en" }, startTimeoutMs: 200 });
  /** The app window `label` asks, as Rust hands it over. */
  const request = (label: string, message: unknown) => handlers.get(APP_REQUEST_EVENT)!({ payload: { label, request: message } });
  const posts = (label: string) => calls.filter((c) => c.command === "app_post" && c.args.label === label).map((c) => c.args.message as Record<string, unknown>);
  const answer = async (label: string, id: number) => {
    await vi.waitFor(() => expect(posts(label).some((m) => m.id === id)).toBe(true));
    return posts(label).find((m) => m.id === id)!;
  };
  return { host, calls, hooks, open, request, posts, answer, stops, closed: (label: string) => handlers.get(APP_CLOSED_EVENT)!({ payload: label }) };
}

describe("opening an app on Desktop", () => {
  it("opens a window with the checked entry and what the person granted, and runs the web broker for it", async () => {
    const { calls, open, request, answer, host } = setup();
    await open(REF, LINK);
    expect(calls[0]).toEqual({ command: "app_open", args: { request: { app: REF, title: "Chess", entry: "<p>chess</p>", internet: false } } });

    request("app-1", { id: 1, type: "writing", args: [] });
    expect(await answer("app-1", 1)).toEqual({ id: 1, ok: true });
    request("app-1", { id: 2, type: "context", args: [] });
    expect(await answer("app-1", 2)).toEqual({ id: 2, ok: true, value: { version: "1.2.0", inChat: true, peer: null, theme: "light", locale: "en" } });
    request("app-1", { id: 3, type: "storage.set", args: ["k", 1] });
    await answer("app-1", 3);
    expect(host.stored.get(`${REF} ${LINK}`)?.get("k")).toBe(1);
    expect(host.calls.find((c) => c.op === "chat.open")).toEqual({ op: "chat.open", ref: REF, linkId: LINK });
  });

  it("opens an app granted internet in the network runner's window", async () => {
    const { calls, open } = setup({ permissions: ["internet"] });
    await open(REF, null);
    expect(calls[0]!.args).toEqual({ request: { app: REF, title: "Chess", entry: "<p>chess</p>", internet: true } });
  });

  it("refuses an app granted internet where the client has no network runner", async () => {
    const { host, calls, open } = setup({ permissions: ["internet"] });
    delete host.netRunnerUrl;
    await expect(open(REF, null)).rejects.toThrow(/internet/);
    expect(calls).toEqual([]);
  });

  it("knows each app by its window's label, never by what it says", async () => {
    const { open, request, answer, host, posts } = setup();
    await open(REF, LINK);
    await open("pubkeybeta/snake", null);
    request("app-1", { id: 1, type: "writing", args: [] });
    request("app-2", { id: 1, type: "writing", args: [] });
    await answer("app-2", 1);
    request("app-2", { id: 2, type: "storage.set", args: ["k", "b"], ref: REF, linkId: LINK });
    await answer("app-2", 2);
    expect(host.stored.get(`pubkeybeta/snake alone`)?.get("k")).toBe("b");
    expect(host.stored.get(`${REF} ${LINK}`)).toBeUndefined();
    // A window nobody opened is nobody's: its requests are not answered.
    request("app-9", { id: 1, type: "context", args: [] });
    await new Promise((done) => setTimeout(done, 20));
    expect(posts("app-9")).toEqual([]);
  });

  it("keeps the web broker's caps: 64 KiB, 50 a second, the API and nothing more", async () => {
    const { open, request, answer } = setup();
    await open(REF, LINK);
    request("app-1", { id: 1, type: "writing", args: [] });
    await answer("app-1", 1);
    request("app-1", { id: 2, type: "storage.set", args: ["k", "x".repeat(MINI_APP_LIMITS.requestBytes)] });
    expect(await answer("app-1", 2)).toEqual({ id: 2, ok: false, error: "too-large" });
    request("app-1", { id: 3, type: "fetch", args: ["https://example.com/"] });
    expect(await answer("app-1", 3)).toEqual({ id: 3, ok: false, error: "unknown-type" });
    for (let id = 4; id < 4 + MINI_APP_LIMITS.requestsPerSecond; id++) request("app-1", { id, type: "storage.keys", args: [] });
    const last = 4 + MINI_APP_LIMITS.requestsPerSecond - 1;
    expect(await answer("app-1", last)).toEqual({ id: last, ok: false, error: "too-fast" });
  });

  it("sends a file's bytes as base64, which the runner turns back into an ArrayBuffer", async () => {
    const { open, request, answer, host } = setup();
    host.files.set(REF, new Map([["board.svg", new Uint8Array([0, 1, 2, 250, 255])]]));
    await open(REF, LINK);
    request("app-1", { id: 1, type: "writing", args: [] });
    await answer("app-1", 1);
    request("app-1", { id: 2, type: "file", args: ["board.svg"] });
    expect(await answer("app-1", 2)).toEqual({ id: 2, ok: true, bytes: "AAEC+v8=" });
    expect(forIpc({ id: 1, ok: true, value: "x" })).toEqual({ id: 1, ok: true, value: "x" });
    const big = new Uint8Array(0x8000 * 2 + 3).map((_, i) => i % 256);
    expect(atob(toBase64(big)).length).toBe(big.length);
  });

  it("sends the contact's frames to that window as events", async () => {
    const { open, request, answer, host, posts } = setup();
    await open(REF, LINK);
    request("app-1", { id: 1, type: "writing", args: [] });
    await answer("app-1", 1);
    const app = memoryAppId(LINK, REF);
    await vi.waitFor(() => expect(host.calls.some((c) => c.op === "chat.open")).toBe(true));
    await Promise.resolve();
    host.receive(LINK, { app, o: "open", v: "1.2.0" });
    host.receive(LINK, { app, d: { move: "e4" } });
    await vi.waitFor(() => expect(posts("app-1").filter((m) => "event" in m)).toEqual([
      { event: "chat.peer", data: { open: true, version: "1.2.0" } },
      { event: "chat.message", data: { move: "e4" } },
    ]));
  });

  it("closes the window when the app asks, and stops the app when its window closes", async () => {
    const { open, request, answer, calls, stops, closed, host } = setup();
    await open(REF, LINK);
    request("app-1", { id: 1, type: "writing", args: [] });
    await answer("app-1", 1);
    request("app-1", { id: 2, type: "close", args: [] });
    expect(await answer("app-1", 2)).toEqual({ id: 2, ok: true });
    expect(calls.filter((c) => c.command === "app_close")).toEqual([{ command: "app_close", args: { label: "app-1" } }]);
    expect(stops).toEqual(["closed"]);

    await open(REF, LINK);
    request("app-2", { id: 1, type: "writing", args: [] });
    await answer("app-2", 1);
    closed("app-2");
    expect(stops).toEqual(["closed", "stopped"]);
    await vi.waitFor(() => expect(host.calls.filter((c) => c.op === "chat.close")).toHaveLength(2));
  });

  it("tears down an app whose first word is not the runner's, and one that never starts", async () => {
    const { open, request, stops, calls } = setup();
    await open(REF, null);
    request("app-1", { id: 1, type: "context", args: [] });
    expect(stops).toEqual(["protocol"]);
    await open(REF, null);
    await vi.waitFor(() => expect(stops).toEqual(["protocol", "timeout"]));
    expect(calls.filter((c) => c.command === "app_close").map((c) => c.args.label)).toEqual(["app-1", "app-2"]);
  });

  it("holds a window's first requests until its label is known", async () => {
    const { hooks, open, request, answer } = setup();
    // Rust's `writing` can reach the Ghostly window before `app_open`'s answer does.
    hooks.opened = (label) => request(label, { id: 1, type: "writing", args: [] });
    await open(REF, null);
    expect(await answer("app-1", 1)).toEqual({ id: 1, ok: true });
  });
});
