import { describe, expect, it, vi } from "vitest";
import { MINI_APP_LIMITS } from "@ghostly/core/miniApp";
import { BROKER_REQUESTS, createBroker, isJsonValue, type AppLaunch, type AppStopReason } from "../../lib/apps/broker";
import { memoryAppId, memoryHost } from "../../lib/apps/memoryHost";

// covers: apps.web-sandbox

/**
 * The broker (WISP 1200, "The runner and the broker"): the app is known by its port, the frame may load once more
 * after `writing` and never again, and requests are bounded in size and rate. The runner and the frame are the e2e's
 * (e2e/web/apps-sandbox.spec.ts); here the protocol alone, on an in-memory host.
 */
const REF = "pubkeyalpha/chess";
const LINK = "link-1";

function setup(launch: Partial<AppLaunch> = {}, clock = { t: 1_000 }) {
  const host = memoryHost();
  const posted: { message: Record<string, unknown>; transfer?: Transferable[] }[] = [];
  const stops: AppStopReason[] = [];
  const broker = createBroker({
    host,
    launch: { ref: REF, version: "1.0.0", title: "Chess", permissions: ["chat"], entry: "<p>app</p>", chat: { linkId: LINK, name: "Ana" }, ...launch },
    view: { theme: () => "dark", locale: () => "pt-BR" },
    post: (message, transfer) => posted.push({ message: message as Record<string, unknown>, transfer }),
    stopped: (reason) => stops.push(reason),
    now: () => clock.t,
  });
  let next = 1;
  const ask = async (type: string, args: unknown[] = [], extra: Record<string, unknown> = {}) => {
    const id = next++;
    broker.message({ id, type, args, ...extra });
    await vi.waitFor(() => expect(posted.some((p) => p.message.id === id)).toBe(true));
    return posted.find((p) => p.message.id === id)!.message;
  };
  /** The runner's start: the first load, `writing`, then the load of the written app. */
  const run = () => {
    broker.load();
    broker.message({ id: 0, type: "writing", args: [] });
    broker.load();
  };
  return { host, posted, stops, broker, ask, run, clock };
}

describe("the start, and the loads of the frame", () => {
  it("one load, `writing`, then exactly one more load: the app runs", () => {
    const { broker, posted, stops } = setup();
    broker.load();
    expect(broker.phase).toBe("starting");
    broker.message({ id: 0, type: "writing", args: [] });
    expect(posted[0]!.message).toEqual({ id: 0, ok: true });
    expect(broker.phase).toBe("writing");
    broker.load();
    expect(broker.phase).toBe("running");
    expect(stops).toEqual([]);
  });

  it("a load before `writing` is a navigation: the app is torn down", () => {
    const { broker, stops } = setup();
    broker.load();
    broker.load();
    expect(stops).toEqual(["navigated"]);
    expect(broker.phase).toBe("stopped");
  });

  it("a third load (a reload, a link, a meta refresh, document.open) is a navigation", () => {
    const { broker, run, stops } = setup();
    run();
    broker.load();
    expect(stops).toEqual(["navigated"]);
  });

  it("anything but `writing` first is not the runner: torn down", () => {
    for (const first of [{ id: 0, type: "context", args: [] }, { id: 0, type: "writing", args: ["x"] }, "writing", null]) {
      const { broker, stops } = setup();
      broker.load();
      broker.message(first);
      expect(stops, JSON.stringify(first)).toEqual(["protocol"]);
    }
  });

  it("`writing` again, once the app runs, is torn down", () => {
    const { broker, run, stops } = setup();
    run();
    broker.message({ id: 5, type: "writing", args: [] });
    expect(stops).toEqual(["protocol"]);
  });

  it("nothing is read before the first load", () => {
    const { broker, posted, stops } = setup();
    broker.message({ id: 0, type: "writing", args: [] });
    expect(posted).toEqual([]);
    expect(stops).toEqual([]);
    expect(broker.phase).toBe("loading");
  });

  it("stops once, and answers nothing after", async () => {
    const { broker, run, stops, posted } = setup();
    run();
    broker.stop();
    broker.stop("closed");
    const before = posted.length;
    broker.message({ id: 9, type: "context", args: [] });
    await new Promise((r) => setTimeout(r, 10));
    expect(stops).toEqual(["stopped"]);
    expect(posted.length).toBe(before);
  });
});

describe("the app is its port: nothing it says names it", () => {
  it("storage goes to this app in this chat, whatever the request claims", async () => {
    const { host, run, ask } = setup();
    run();
    await host.storage.set("someone/else", LINK, "secret", "theirs");
    const forged = { ref: "someone/else", app: "someone/else", scope: "alone", linkId: "other", window: "app-0" };
    expect(await ask("storage.get", ["secret"], forged)).toEqual({ id: expect.any(Number), ok: true });
    expect(await ask("storage.set", ["k", { v: 1 }], forged)).toMatchObject({ ok: true });
    expect(await ask("storage.keys", [], forged)).toMatchObject({ ok: true, value: ["k"] });
    const mine = host.calls.filter((c) => c.op.startsWith("storage.") && c.ref !== "someone/else" || c.scope !== LINK);
    expect(host.calls.filter((c) => c.op.startsWith("storage.")).slice(1).every((c) => c.ref === REF && c.scope === LINK)).toBe(true);
    expect(mine.every((c) => c.ref === REF)).toBe(true);
    expect(host.stored.get(`someone/else ${LINK}`)?.get("secret")).toBe("theirs");
  });

  it("an app opened alone keeps its data apart from the same app in a chat", async () => {
    const { host, run, ask } = setup({ chat: null });
    run();
    await ask("storage.set", ["k", 1]);
    expect(host.stored.get(`${REF} alone`)?.get("k")).toBe(1);
    expect(host.stored.get(`${REF} ${LINK}`)).toBeUndefined();
  });

  it("storage keys and values are bounded", async () => {
    const { run, ask } = setup();
    run();
    expect(await ask("storage.get", ["k".repeat(257)])).toMatchObject({ ok: false, error: "bad-key" });
    expect(await ask("storage.get", [""])).toMatchObject({ ok: false, error: "bad-key" });
    expect(await ask("storage.get", [7])).toMatchObject({ ok: false, error: "bad-key" });
    expect(await ask("storage.set", ["k", "x".repeat(MINI_APP_LIMITS.storageValueBytes)])).toMatchObject({ ok: false, error: "too-large" });
  });
});

describe("requests", () => {
  it("the whole API and nothing more: an unknown type is refused", async () => {
    const { run, ask } = setup();
    run();
    expect(BROKER_REQUESTS).toEqual(["context", "file", "storage.get", "storage.set", "storage.delete", "storage.keys", "chat.send", "close"]);
    for (const type of ["start", "app_broker", "eval", "storage.clear", "chat.peer", "__proto__"]) expect(await ask(type)).toMatchObject({ ok: false, error: "unknown-type" });
  });

  it("refuses what is not a request", async () => {
    const { broker, run, ask, posted } = setup();
    run();
    expect(await ask("context", [() => 1] as unknown[])).toMatchObject({ ok: false, error: "bad-request" });
    expect(await ask("context", [new Uint8Array(2)] as unknown[])).toMatchObject({ ok: false, error: "bad-request" });
    expect(await ask("context", [Number.NaN])).toMatchObject({ ok: false, error: "bad-request" });
    broker.message({ type: "context", args: [] });
    broker.message({ id: -1, type: "context", args: [] });
    broker.message({ id: 1.5, type: "context", args: [] });
    await new Promise((r) => setTimeout(r, 10));
    expect(posted.filter((p) => p.message.id === undefined || (p.message.id as number) < 0)).toEqual([]);
  });

  it("refuses a request over 64 KiB before anything sees it", async () => {
    const { host, run, ask } = setup();
    run();
    const before = host.calls.length;
    expect(await ask("storage.set", ["k", "x".repeat(MINI_APP_LIMITS.requestBytes)])).toMatchObject({ ok: false, error: "too-large" });
    expect(host.calls.length).toBe(before);
  });

  it("answers at most 50 requests a second, malformed ones counted", async () => {
    const { broker, host, run, posted, clock } = setup();
    run();
    clock.t += 1_001;
    for (let i = 0; i < 10; i++) broker.message({ junk: i });
    for (let id = 1; id <= 50; id++) broker.message({ id, type: "storage.keys", args: [] });
    await vi.waitFor(() => expect(posted.filter((p) => typeof p.message.id === "number" && p.message.id >= 1).length).toBe(50));
    const answers = posted.filter((p) => (p.message.id as number) >= 1).map((p) => p.message);
    expect(answers.filter((a) => a.ok === true).length).toBe(40);
    expect(answers.filter((a) => a.error === "too-fast").length).toBe(10);
    expect(host.calls.filter((c) => c.op === "storage.keys").length).toBe(40);
    clock.t += 1_001;
    broker.message({ id: 99, type: "storage.keys", args: [] });
    await vi.waitFor(() => expect(posted.find((p) => p.message.id === 99)?.message).toMatchObject({ ok: true }));
  });

  it("context: the version, the chat, the client's theme and language, the name only with its permission", async () => {
    const named = setup({ permissions: ["chat", "name"] });
    named.run();
    expect((await named.ask("context")).value).toEqual({ version: "1.0.0", inChat: true, peer: null, theme: "dark", locale: "pt-BR", name: "Ana" });
    const plain = setup();
    plain.run();
    expect((await plain.ask("context")).value).toEqual({ version: "1.0.0", inChat: true, peer: null, theme: "dark", locale: "pt-BR" });
  });

  it("file: the bundle's bytes as an ArrayBuffer, handed over", async () => {
    const { host, run, ask, posted } = setup();
    run();
    host.files.set(REF, new Map([["board.svg", new Uint8Array([1, 2, 3])]]));
    const answer = await ask("file", ["board.svg"]);
    expect(new Uint8Array(answer.value as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
    expect(posted[posted.length - 1]!.transfer).toEqual([answer.value]);
    expect(await ask("file", ["../other/app"])).toMatchObject({ ok: false });
    expect(host.calls.filter((c) => c.op === "file").every((c) => c.ref === REF)).toBe(true);
  });

  it("close ends the app, and closes it in the chat", async () => {
    const { host, run, ask, stops } = setup();
    run();
    await ask("close");
    await vi.waitFor(() => expect(stops).toEqual(["closed"]));
    await vi.waitFor(() => expect(host.calls.some((c) => c.op === "chat.close" && c.ref === REF && c.linkId === LINK)).toBe(true));
  });
});

describe("chat", () => {
  const peerOpen = (host: ReturnType<typeof memoryHost>, app = memoryAppId(LINK, REF), linkId = LINK) => host.receive(linkId, { app, o: "open", v: "1.2.0" });

  it("opens the app in its chat when it starts, and sends what the app sends", async () => {
    const { host, run, ask } = setup();
    run();
    await vi.waitFor(() => expect(host.calls).toContainEqual({ op: "chat.open", ref: REF, linkId: LINK }));
    expect(await ask("chat.send", [{ move: "e2e4" }])).toMatchObject({ ok: true });
    expect(host.sent).toEqual([{ linkId: LINK, ref: REF, data: { move: "e2e4" } }]);
  });

  it("refuses chat without the permission, and alone", async () => {
    for (const launch of [{ permissions: [] }, { chat: null }]) {
      const { host, run, ask } = setup(launch);
      run();
      expect(await ask("chat.send", [1])).toMatchObject({ ok: false, error: "not-allowed" });
      expect(host.calls.some((c) => c.op === "chat.open")).toBe(false);
    }
  });

  it("refuses a value over 32 KiB, and passes on why the engine did not send", async () => {
    const { host, run, ask } = setup();
    run();
    expect(await ask("chat.send", ["x".repeat(MINI_APP_LIMITS.chatDataBytes)])).toMatchObject({ ok: false, error: "too-large" });
    host.sendResult = "offline";
    expect(await ask("chat.send", [1])).toMatchObject({ ok: false, error: "offline" });
  });

  it("hears the contact's app only: its chat, its id; data once the contact's app is open", async () => {
    const { host, run, posted } = setup();
    run();
    await vi.waitFor(() => expect(host.calls.some((c) => c.op === "chat.open")).toBe(true));
    await Promise.resolve();
    const app = memoryAppId(LINK, REF);
    host.receive(LINK, { app, d: "too early" });
    host.receive("link-2", { app, o: "open", v: "9.9.9" });
    host.receive(LINK, { app: memoryAppId(LINK, "someone/else"), o: "open", v: "9.9.9" });
    peerOpen(host);
    host.receive(LINK, { app, d: { move: "e7e5" } });
    host.receive(LINK, { app, o: "close" });
    const events = posted.filter((p) => "event" in p.message).map((p) => p.message);
    expect(events).toEqual([
      { event: "chat.peer", data: { open: true, version: "1.2.0" } },
      { event: "chat.message", data: { move: "e7e5" } },
      { event: "chat.peer", data: { open: false } },
    ]);
  });

  it("knows a contact's app that was open before this one started", async () => {
    const { host, run, ask } = setup();
    peerOpen(host);
    run();
    await vi.waitFor(() => expect(host.calls.some((c) => c.op === "chat.open")).toBe(true));
    await vi.waitFor(async () => expect((await ask("context")).value).toMatchObject({ peer: { version: "1.2.0" } }));
  });
});

it("isJsonValue takes plain JSON only", () => {
  expect(isJsonValue({ a: [1, "x", null, true, { b: 2 }] })).toBe(true);
  for (const bad of [undefined, Number.POSITIVE_INFINITY, () => 1, new Date(), new Map(), Symbol("x"), 1n]) expect(isJsonValue(bad)).toBe(false);
  let deep: unknown = 1;
  for (let i = 0; i < 100; i++) deep = [deep];
  expect(isJsonValue(deep)).toBe(false);
});
