import { describe, expect, it, vi } from "vitest";
import { MINI_APP_LIMITS } from "@ghostly/core/miniApp";
import { BROKER_REQUESTS, createBroker, PICK_AFTER_CANCEL_MS, STOP_REQUESTS_PER_SECOND, isJsonValue, jsonValueOf, runnerFor, type AppLaunch, type AppStopReason } from "../../lib/apps/broker";
import { memoryAppId, memoryHost } from "../../lib/apps/memoryHost";

// covers: apps.web-sandbox

/**
 * The broker (WISP 1200, "The runner and the broker"): the app is known by its port, the frame may load once more
 * after `writing` and never again, and requests are bounded in size and rate. The runner and the frame are the e2e's
 * (e2e/web/apps-sandbox.spec.ts); here the protocol alone, on an in-memory host.
 */
const REF = "pubkeyalpha/chess";
const LINK = "link-1";

function setup(launch: Partial<AppLaunch> = {}, clock = { t: 1_000 }, { byReference = false } = {}) {
  const host = memoryHost();
  const posted: { message: Record<string, unknown>; transfer?: Transferable[] }[] = [];
  const stops: AppStopReason[] = [];
  const broker = createBroker({
    host,
    launch: { ref: REF, digest: "d", version: "1.0.0", title: "Chess", permissions: ["chat"], entry: "<p>app</p>", chat: { linkId: LINK, name: "Ana" }, ...launch },
    view: { theme: () => "dark", locale: () => "pt-BR" },
    post: (message, transfer) => posted.push({ message: message as Record<string, unknown>, transfer }),
    stopped: (reason) => stops.push(reason),
    byReference,
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

  it("an engine refusal reaches the app by its code: a full storage is `full`, a missing file `no-file`", async () => {
    // The engine's errors cross its RPC as "<code>: words" (engine/apps.ts). The app saw "failed" for all of them, so it
    // could not tell its 5 MiB were used up (and make room) from a passing failure.
    const { host, run, ask } = setup();
    run();
    vi.spyOn(host.storage, "set").mockRejectedValueOnce(new Error("full: This app's storage in this chat is full (5 MiB)"));
    expect(await ask("storage.set", ["k", "v"])).toMatchObject({ ok: false, error: "full" });
    vi.spyOn(host, "file").mockRejectedValueOnce(new Error("no-file: No such file in this app"));
    expect(await ask("file", ["nope.txt"])).toMatchObject({ ok: false, error: "no-file" });
    // A version a store removed, or its publisher revoked, since it started: cut off (WISP 1200 § Takedowns).
    vi.spyOn(host.storage, "set").mockRejectedValueOnce(new Error("stopped: Removed by Ghostly Store: Malware"));
    expect(await ask("storage.set", ["k", "v"])).toMatchObject({ ok: false, error: "stopped" });
    // Anything else stays "failed": the words, and codes an app has no use for, are not passed on.
    vi.spyOn(host.storage, "get").mockRejectedValueOnce(new Error("bad-scope: Not a chat of this profile"));
    expect(await ask("storage.get", ["k"])).toMatchObject({ ok: false, error: "failed" });
    vi.spyOn(host.storage, "get").mockRejectedValueOnce(new Error("IndexedDB went away"));
    expect(await ask("storage.get", ["k"])).toMatchObject({ ok: false, error: "failed" });
  });
});

describe("requests", () => {
  it("the whole API and nothing more: an unknown type is refused", async () => {
    const { run, ask } = setup();
    run();
    expect(BROKER_REQUESTS).toEqual(["context", "file", "storage.get", "storage.set", "storage.delete", "storage.keys", "chat.send", "files.pick", "files.list", "files.read", "files.forget", "close"]);
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

  it("refuses a huge or binary request without writing it as JSON first", () => {
    // A structured clone carries what JSON.stringify takes seconds to write (a 16 MiB Uint8Array took 1.6 s on the
    // page's thread): it is refused from a count that stops at 64 KiB, and binary data from its type alone.
    const { broker, posted, run } = setup();
    run();
    // Counted by hand: a spy would keep (and print) what it was called with.
    const stringify = JSON.stringify;
    let written = 0;
    JSON.stringify = ((...args: Parameters<typeof stringify>) => { written++; return stringify(...args); }) as typeof stringify;
    const wide: Record<string, number> = {};
    for (let i = 0; i < 20_000; i++) wide[`k${i}`] = i;
    const requests: [unknown[], Record<string, unknown>, string][] = [
      [[new Uint8Array(16 * 1024 * 1024)], {}, "bad-request"],
      [[new Float64Array(8)], {}, "bad-request"],
      [[new ArrayBuffer(16 * 1024 * 1024)], {}, "bad-request"],
      [[], { extra: new DataView(new ArrayBuffer(1024 * 1024)) }, "bad-request"],
      [[new Array(1_000_000)], {}, "too-large"],
      [["x".repeat(64 * 1024 * 1024)], {}, "too-large"],
      [[wide], {}, "too-large"],
      // A String object is no JSON: its 10 million index keys are not listed one by one (1.5 s), nor 30 million (threw).
      [[new String("x".repeat(10_000_000))], {}, "bad-request"],
      [[{ a: new String("x".repeat(30_000_000)) }], {}, "bad-request"],
      [[], { extra: new String("x".repeat(30_000_000)) }, "bad-request"],
    ];
    try {
      requests.forEach(([args, extra], i) => broker.message({ id: 100 + i, type: "storage.get", args, ...extra }));
    } finally {
      JSON.stringify = stringify;
    }
    expect(written).toBe(0);
    expect(posted.slice(-requests.length).map((p) => p.message)).toEqual(requests.map(([, , error], i) => ({ id: 100 + i, ok: false, error })));
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

  it("stops an app that sends ten times the rate: nothing more of it is read or answered", async () => {
    const { broker, host, run, posted, stops, clock } = setup();
    run();
    clock.t += 1_001;
    for (let id = 1; id <= STOP_REQUESTS_PER_SECOND; id++) broker.message({ id, type: "storage.keys", args: [] });
    expect(stops).toEqual([]);
    expect(broker.phase).toBe("running");
    // The one over: read by nothing (a getter on it would throw), the app stopped, its chat closed.
    const unread = Object.defineProperty({}, "id", { enumerable: true, get() { throw new Error("read"); } });
    broker.message(unread);
    expect(stops).toEqual(["protocol"]);
    expect(broker.phase).toBe("stopped");
    const before = posted.length;
    for (let id = 1_000; id < 2_000; id++) broker.message({ id, type: "storage.keys", args: [] });
    await new Promise((done) => setTimeout(done, 0));
    expect(posted.length).toBe(before);
    expect(posted.filter((p) => p.message.error === "too-fast").length).toBe(STOP_REQUESTS_PER_SECOND - MINI_APP_LIMITS.requestsPerSecond);
    expect(host.calls.filter((c) => c.op === "storage.keys").length).toBe(MINI_APP_LIMITS.requestsPerSecond);
    expect(host.calls.filter((c) => c.op === "chat.close").length).toBe(1);
    expect(stops).toEqual(["protocol"]);
  });

  it("keeps an app that bursts under ten times the rate, second after second", async () => {
    const { broker, run, stops, clock, ask } = setup();
    run();
    for (let second = 0; second < 5; second++) {
      clock.t += 1_001;
      for (let i = 0; i < STOP_REQUESTS_PER_SECOND; i++) broker.message({ junk: i });
    }
    expect(stops).toEqual([]);
    clock.t += 1_001;
    expect(await ask("storage.keys")).toMatchObject({ ok: true });
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

  it("file: the host's copy is handed over as it is, not copied again; a view on a larger buffer is copied", async () => {
    // The engine's file() is already a fresh copy: copying it again doubled what a read cost the page.
    const { host, run, ask } = setup();
    run();
    const whole = new Uint8Array([1, 2, 3]);
    vi.spyOn(host, "file").mockResolvedValueOnce(whole);
    expect((await ask("file", ["a.bin"])).value).toBe(whole.buffer);
    const shared = new Uint8Array([9, 4, 5, 6, 9]);
    vi.spyOn(host, "file").mockResolvedValueOnce(shared.subarray(1, 4));
    const part = (await ask("file", ["b.bin"])).value as ArrayBuffer;
    expect(part).not.toBe(shared.buffer);
    expect(new Uint8Array(part)).toEqual(new Uint8Array([4, 5, 6]));
  });

  it("file: the in-memory host answers a copy, so a transfer leaves its files whole", async () => {
    const host = memoryHost();
    const stored = new Uint8Array([1, 2, 3]);
    host.files.set(REF, new Map([["a.bin", stored]]));
    const read = await host.file(REF, "a.bin");
    expect(read).toEqual(stored);
    expect(read.buffer).not.toBe(stored.buffer);
  });

  it("file by reference (Desktop): where the bytes lie instead of the bytes, with the same checks and budget", async () => {
    const { host, broker, run, ask, posted, clock } = setup({}, { t: 1_000 }, { byReference: true });
    run();
    const MiB = 1024 * 1024;
    host.files.set(REF, new Map([["big.bin", new Uint8Array(6 * MiB)], ["icon.png", new Uint8Array([9])]]));
    const where = { space: "ghostly-a", id: "app-d", offset: 4096, length: 6 * MiB, sha256: "h" };
    const asked: string[] = [];
    host.fileAt = async (ref, path) => { asked.push(`${ref} ${path}`); return path === "big.bin" ? where : null; };
    const read = vi.spyOn(host, "file");
    const answer = await ask("file", ["big.bin"]);
    expect(answer).toEqual({ id: answer.id, ok: true, file: where });
    expect(posted[posted.length - 1]!.transfer).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    // Where the host cannot say (the icon, kept in memory), the bytes as before.
    expect(new Uint8Array((await ask("file", ["icon.png"])).value as ArrayBuffer)).toEqual(new Uint8Array([9]));
    expect(asked).toEqual([`${REF} big.bin`, `${REF} icon.png`]);
    expect(await ask("file", ["../other/app"])).toMatchObject({ ok: false });
    // The bytes it names count toward the 16 MiB a second as bytes carried do.
    clock.t += 1_001;
    for (let id = 50; id < 54; id++) broker.message({ id, type: "file", args: ["big.bin"] });
    await vi.waitFor(() => expect(posted.filter((p) => (p.message.id as number) >= 50).length).toBe(4));
    expect(posted.filter((p) => (p.message.id as number) >= 50).map((p) => p.message.ok === true ? "ok" : p.message.error)).toEqual(["ok", "ok", "ok", "too-fast"]);
  });

  it("file: at most a bundle's worth of bytes a second, read one file at a time", async () => {
    // 50 reads a second of a 16 MiB file made the page copy 800 MB a second and stall for most of a second.
    const { host, broker, run, posted, clock } = setup();
    run();
    const big = new Uint8Array(6 * 1024 * 1024);
    host.files.set(REF, new Map([["big.bin", big], ["small.txt", new Uint8Array([7])]]));
    let reading = 0;
    let most = 0;
    const file = host.file;
    host.file = async (ref, path) => {
      most = Math.max(most, ++reading);
      try { return await file(ref, path); } finally { reading--; }
    };
    clock.t += 1_001;
    for (let id = 1; id <= 10; id++) broker.message({ id, type: "file", args: ["big.bin"] });
    await vi.waitFor(() => expect(posted.filter((p) => (p.message.id as number) >= 1).length).toBe(10));
    const answers = (from: number) => posted.filter((p) => (p.message.id as number) >= from).map((p) => p.message);
    // 6 + 6 + 6 MiB: the third read starts under 16 MiB and is answered whole; the rest are refused unread.
    expect(answers(1).filter((a) => a.ok === true).length).toBe(3);
    expect(answers(1).filter((a) => a.error === "too-fast").length).toBe(7);
    expect(host.calls.filter((c) => c.op === "file").length).toBe(3);
    expect(most).toBe(1);
    expect(MINI_APP_LIMITS.fileBytesPerSecond).toBe(16 * 1024 * 1024);
    // A second later the budget is whole again.
    clock.t += 1_001;
    broker.message({ id: 100, type: "file", args: ["small.txt"] });
    await vi.waitFor(() => expect(posted.find((p) => p.message.id === 100)?.message).toMatchObject({ ok: true }));
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

  it("answers context only once the chat open has: a contact already open reads as open from the first call", async () => {
    // The contact opened the app before this side did (heard before this app ran). Before, `context` answered at once,
    // ahead of the chat open, with peer null: Chess waited for a contact who was there.
    const { host, run, ask } = setup();
    host.receive(LINK, { app: memoryAppId(LINK, REF), o: "open", v: "1.2.0" });
    run();
    expect((await ask("context")).value).toMatchObject({ peer: { version: "1.2.0" } });
  });

  it("takes a value as JSON.stringify writes it: undefined members left out, undefined in a list as null", async () => {
    // Chess saved and sent `{ ...game, d: undefined }`: refused, so no move was ever sent or kept.
    const { host, run, ask } = setup();
    run();
    await vi.waitFor(() => expect(host.calls).toContainEqual({ op: "chat.open", ref: REF, linkId: LINK }));
    host.receive(LINK, { app: memoryAppId(LINK, REF), o: "open", v: "1.2.0" });
    expect(await ask("storage.set", ["game", { m: ["e2e4"], d: undefined, x: [1, undefined] }])).toMatchObject({ ok: true });
    expect(host.stored.get(`${REF} ${LINK}`)?.get("game")).toEqual({ m: ["e2e4"], x: [1, null] });
    expect(Object.keys(host.stored.get(`${REF} ${LINK}`)!.get("game") as object)).toEqual(["m", "x"]);
    expect(await ask("chat.send", [{ k: "move", m: "e2e4", d: undefined }])).toMatchObject({ ok: true });
    expect(host.sent[host.sent.length - 1]).toEqual({ linkId: LINK, ref: REF, data: { k: "move", m: "e2e4" } });
    // Anything else that is not JSON is still refused.
    for (const bad of [new Date(), new Map(), Number.NaN]) expect(await ask("storage.set", ["k", { bad }])).toMatchObject({ ok: false, error: "bad-request" });
  });

  it("keeps a member named __proto__ as JSON.stringify does, at the top and nested", async () => {
    // A key typed by a person ("__proto__" in a shared dictionary) set the copy's prototype: storage.set was refused as
    // too-large, and chat.send and a flat storage.set lost the member without a word.
    const { host, run, ask } = setup();
    run();
    await vi.waitFor(() => expect(host.calls).toContainEqual({ op: "chat.open", ref: REF, linkId: LINK }));
    peerOpen(host);
    const nested = JSON.parse('{"words":{"__proto__":{"n":1},"cat":{"n":2}}}') as unknown;
    const flat = JSON.parse('{"__proto__":5,"b":1}') as unknown;
    expect(await ask("storage.set", ["dict", nested])).toMatchObject({ ok: true });
    expect(await ask("storage.set", ["flat", flat])).toMatchObject({ ok: true });
    expect(await ask("chat.send", [nested])).toMatchObject({ ok: true });
    const stored = host.stored.get(`${REF} ${LINK}`)!;
    expect(JSON.stringify(stored.get("dict"))).toBe(JSON.stringify(nested));
    expect(JSON.stringify(stored.get("flat"))).toBe(JSON.stringify(flat));
    expect(JSON.stringify(host.sent[host.sent.length - 1]!.data)).toBe(JSON.stringify(nested));
    // Plain JSON still, with no prototype of the app's anywhere in it.
    expect(isJsonValue(stored.get("dict"))).toBe(true);
    expect(Object.getPrototypeOf((stored.get("dict") as { words: object }).words)).toBe(Object.prototype);
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

it("jsonValueOf writes a value as JSON.stringify does, or refuses it", () => {
  expect(jsonValueOf({ a: 1, b: undefined, c: [undefined, { d: undefined }] })).toEqual({ a: 1, c: [null, {}] });
  const proto = JSON.parse('{"__proto__":{"x":1},"y":[{"__proto__":2}]}') as unknown;
  expect(JSON.stringify(jsonValueOf(proto))).toBe(JSON.stringify(proto));
  for (const bad of [Number.POSITIVE_INFINITY, () => 1, new Date(), new Map(), Symbol("x"), 1n, { a: new Uint8Array(1) }]) expect(typeof jsonValueOf(bad)).toBe("symbol");
  let deep: unknown = 1;
  for (let i = 0; i < 100; i++) deep = [deep];
  expect(typeof jsonValueOf(deep)).toBe("symbol");
});

describe("the runner, from what the person granted", () => {
  it("the network runner only for an app granted internet, and none where the client has no network runner", () => {
    const host = memoryHost();
    expect(runnerFor(host, { permissions: [] })).toBe("/app-frame.html");
    expect(runnerFor(host, { permissions: ["chat", "name"] })).toBe("/app-frame.html");
    expect(runnerFor(host, { permissions: ["internet"] })).toBe("/app-frame-net.html");
    expect(() => runnerFor(memoryHost("/app-frame.html", null), { permissions: ["internet"] })).toThrow(/internet/);
  });

  it("an app cannot ask its way into the network: nothing it sends changes the runner it is in", async () => {
    const { run, ask } = setup({ permissions: [] });
    run();
    for (const type of ["internet", "permissions", "runner"]) expect(await ask(type, ["internet"])).toMatchObject({ ok: false, error: "unknown-type" });
  });
});

it("asks the engine as the version it runs: every call goes to the platform of its entry's digest", async () => {
  const platform = memoryHost();
  const bound = memoryHost();
  const digests: string[] = [];
  platform.running = (digest) => { digests.push(digest); return bound; };
  const broker = createBroker({
    host: platform,
    launch: { ref: REF, digest: "digest-7", version: "1.0.0", title: "Chess", permissions: ["chat"], entry: "<p>app</p>", chat: { linkId: LINK } },
    view: { theme: () => "dark", locale: () => "en" },
    post: () => {},
    stopped: () => {},
  });
  broker.load();
  broker.message({ id: 0, type: "writing", args: [] });
  broker.load();
  broker.message({ id: 1, type: "storage.set", args: ["k", 1] });
  broker.message({ id: 2, type: "chat.send", args: [1] });
  await vi.waitFor(() => expect(bound.calls.map((c) => c.op)).toEqual(expect.arrayContaining(["chat.open", "storage.set", "chat.send"])));
  expect(digests).toEqual(["digest-7"]);
  expect(platform.calls).toEqual([]);
});

describe("linked files (WISP 1200 · Linked files)", () => {
  const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

  it("are only for an app granted `files`, in a client that keeps them", async () => {
    const { ask, run, host } = setup();
    run();
    for (const [type, args] of [["files.pick", []], ["files.list", []], ["files.read", ["a".repeat(22), { offset: 0, length: 1 }]], ["files.forget", ["all"]]] as const) {
      expect(await ask(type, [...args])).toMatchObject({ ok: false, error: "not-allowed" });
    }
    expect(host.calls.some((c) => c.op.startsWith("files."))).toBe(false);
    const granted = setup({ permissions: ["chat", "files"] });
    delete (granted.host as { linkedFiles?: unknown }).linkedFiles;
    granted.run();
    expect(await granted.ask("files.list")).toMatchObject({ ok: false, error: "not-allowed" });
  });

  it("pick asks the person through the client, keeps the links per app, and list gives them back", async () => {
    const { ask, run, host } = setup({ permissions: ["files"], title: "Cinema" });
    run();
    host.nextPick = [{ path: "Films/Up.mp4", bytes: bytes(10), modified: 5 }, { path: "Films/Up.srt", bytes: bytes(3) }];
    const picked = await ask("files.pick", [{ folder: true, accept: ["mp4", "srt"] }]);
    expect(picked).toMatchObject({ ok: true, value: [{ path: "Films/Up.mp4", size: 10, modified: 5, available: true }, { path: "Films/Up.srt", size: 3 }] });
    expect(host.calls.find((c) => c.op === "files.pick")).toEqual({ op: "files.pick", ref: REF, key: "folder mp4,srt" });
    expect(await ask("files.list")).toMatchObject({ ok: true, value: [{ path: "Films/Up.mp4" }, { path: "Films/Up.srt" }] });
    // Another app keeps none of them.
    expect(await host.linkedFiles!.list("other/app", "Other")).toEqual([]);
  });

  it("pick: the person picked nothing is `cancelled`, and options other than the call's are refused", async () => {
    const { ask, run, host } = setup({ permissions: ["files"] });
    run();
    expect(await ask("files.pick")).toMatchObject({ ok: false, error: "cancelled" });
    for (const options of [{ folder: "yes" }, { accept: "mp4" }, { accept: [".mp4"] }, { accept: ["MP4"] }, { accept: Array.from({ length: MINI_APP_LIMITS.filesAccept + 1 }, (_, i) => `e${i}`) }, [true], 1]) {
      expect(await ask("files.pick", [options]), JSON.stringify(options)).toMatchObject({ ok: false, error: "bad-request" });
    }
    expect(host.calls.filter((c) => c.op === "files.pick")).toHaveLength(1);
  });

  it("pick: one at a time, while the person is still deciding", async () => {
    const { ask, run, host } = setup({ permissions: ["files"] });
    run();
    let decide!: () => void;
    const pick = host.linkedFiles!.pick;
    host.linkedFiles!.pick = (...a) => new Promise((resolve, reject) => { decide = () => pick(...a).then(resolve, reject); });
    host.nextPick = [{ path: "a.mp4", bytes: bytes(1) }];
    const first = ask("files.pick");
    await vi.waitFor(() => expect(decide).toBeTypeOf("function"));
    expect(await ask("files.pick")).toMatchObject({ ok: false, error: "too-fast" });
    decide();
    expect(await first).toMatchObject({ ok: true });
  });

  it("pick: after the person cancels, the app waits before it may ask again", async () => {
    const { ask, run, host, clock } = setup({ permissions: ["files"] });
    run();
    expect(await ask("files.pick")).toMatchObject({ ok: false, error: "cancelled" });
    // Asking again at once would put the picker back in front of the person each time they close it.
    expect(await ask("files.pick")).toMatchObject({ ok: false, error: "too-fast" });
    clock.t += PICK_AFTER_CANCEL_MS - 1;
    expect(await ask("files.pick")).toMatchObject({ ok: false, error: "too-fast" });
    expect(host.calls.filter((c) => c.op === "files.pick")).toHaveLength(1);
    clock.t += 1;
    host.nextPick = [{ path: "a.mp4", bytes: bytes(1) }];
    expect(await ask("files.pick")).toMatchObject({ ok: true });
    // A pick that answered holds nothing off.
    expect(await ask("files.pick")).toMatchObject({ ok: false, error: "cancelled" });
    expect(host.calls.filter((c) => c.op === "files.pick")).toHaveLength(3);
  });

  it("read: a range of a linked file as an ArrayBuffer, handed over, by an id the client gave", async () => {
    const { ask, run, host, posted } = setup({ permissions: ["files"] });
    run();
    const data = Uint8Array.from({ length: 100 }, (_, i) => i);
    host.nextPick = [{ path: "film.mp4", bytes: data }];
    const id = ((await ask("files.pick")).value as { id: string }[])[0]!.id;
    const answer = await ask("files.read", [id, { offset: 10, length: 5 }]);
    expect(new Uint8Array(answer.value as ArrayBuffer)).toEqual(Uint8Array.from([10, 11, 12, 13, 14]));
    expect(posted.find((p) => p.message === answer)!.transfer).toEqual([answer.value]);
    // The end of the file: fewer bytes.
    expect((await ask("files.read", [id, { offset: 98, length: 50 }])).value).toHaveProperty("byteLength", 2);
    expect(host.calls.filter((c) => c.op === "files.read").every((c) => c.ref === REF)).toBe(true);
  });

  it("read: bad ids and ranges are refused before the client reads; a changed or gone file says so", async () => {
    const { ask, run, host } = setup({ permissions: ["files"] });
    run();
    host.nextPick = [{ path: "film.mp4", bytes: bytes(100) }];
    const id = ((await ask("files.pick")).value as { id: string }[])[0]!.id;
    for (const args of [["../etc/passwd", { offset: 0, length: 1 }], [id], [id, { offset: -1, length: 1 }], [id, { offset: 0, length: 0 }], [id, { offset: 0.5, length: 1 }], [id, { offset: 2 ** 53, length: 1 }]]) {
      expect(await ask("files.read", args), JSON.stringify(args)).toMatchObject({ ok: false, error: "bad-request" });
    }
    expect(await ask("files.read", [id, { offset: 0, length: MINI_APP_LIMITS.filesReadBytes + 1 }])).toMatchObject({ ok: false, error: "too-large" });
    expect(host.calls.filter((c) => c.op === "files.read")).toHaveLength(0);
    host.linked.get(REF)!.get(id)!.bytes = bytes(101);
    expect(await ask("files.read", [id, { offset: 0, length: 1 }])).toMatchObject({ ok: false, error: "changed" });
    host.linked.get(REF)!.get(id)!.bytes = null;
    expect(await ask("files.read", [id, { offset: 0, length: 1 }])).toMatchObject({ ok: false, error: "gone" });
    expect(await ask("files.read", ["b".repeat(22), { offset: 0, length: 1 }])).toMatchObject({ ok: false, error: "gone" });
  });

  it("read shares `file`'s 16 MiB a second", async () => {
    const { ask, run, host, clock } = setup({ permissions: ["files"] });
    run();
    host.nextPick = [{ path: "big.bin", bytes: bytes(MINI_APP_LIMITS.fileBytesPerSecond) }];
    const id = ((await ask("files.pick")).value as { id: string }[])[0]!.id;
    host.files.set(REF, new Map([["board.svg", bytes(MINI_APP_LIMITS.fileBytesPerSecond - 1)]]));
    expect(await ask("file", ["board.svg"])).toMatchObject({ ok: true });
    expect(await ask("files.read", [id, { offset: 0, length: 1 }])).toMatchObject({ ok: true });
    expect(await ask("files.read", [id, { offset: 0, length: 1 }])).toMatchObject({ ok: false, error: "too-fast" });
    clock.t += 1000;
    expect(await ask("files.read", [id, { offset: 0, length: 1 }])).toMatchObject({ ok: true });
  });

  it("list shares the 16 MiB a second too: 100 000 links answer once a second, not 50 times", async () => {
    // Each answer of 100 000 library-like paths (95 characters) is about 17 MB as JSON: 50 a second made the page copy
    // 758 MB a second.
    const { ask, run, host, broker, posted, clock } = setup({ permissions: ["files"] });
    run();
    const entries = Array.from({ length: MINI_APP_LIMITS.filesEntries }, (_, i) => ({ id: "a".repeat(22), path: `Music/Artist ${i % 500}/Album ${i % 40}/${String(i).padStart(6, "0")} A song with a long enough title.flac`.padEnd(95, "x"), size: 30_000_000, modified: 1_790_000_000_000, available: true }));
    host.linkedFiles!.list = async () => entries;
    host.files.set(REF, new Map([["board.svg", bytes(1)]]));
    clock.t += 1_001;
    const lists = Array.from({ length: MINI_APP_LIMITS.requestsPerSecond - 1 }, (_, i) => 1_000 + i);
    for (const id of lists) broker.message({ id, type: "files.list", args: [] });
    await vi.waitFor(() => expect(posted.filter((p) => lists.includes(p.message.id as number))).toHaveLength(lists.length));
    const answers = posted.filter((p) => lists.includes(p.message.id as number)).map((p) => p.message);
    expect(answers.filter((a) => a.ok === true)).toHaveLength(1);
    expect(answers.filter((a) => a.error === "too-fast")).toHaveLength(lists.length - 1);
    // The list spent what `file` and `files.read` may still answer that second.
    expect(await ask("file", ["board.svg"])).toMatchObject({ ok: false, error: "too-fast" });
    clock.t += 1_000;
    expect(await ask("files.list")).toMatchObject({ ok: true });
  });

  it("list: a small one is counted too, by its bytes", async () => {
    const { ask, run, host } = setup({ permissions: ["files"] });
    run();
    host.nextPick = [{ path: "Films/Up.mp4", bytes: bytes(1) }];
    await ask("files.pick");
    host.files.set(REF, new Map([["big.bin", bytes(MINI_APP_LIMITS.fileBytesPerSecond - 50)], ["board.svg", bytes(1)]]));
    expect(await ask("file", ["big.bin"])).toMatchObject({ ok: true });
    // Under the budget when it starts: answered whole, and it passes the budget.
    expect(await ask("files.list")).toMatchObject({ ok: true, value: [{ path: "Films/Up.mp4" }] });
    expect(await ask("file", ["board.svg"])).toMatchObject({ ok: false, error: "too-fast" });
  });

  it("forget drops one link, or all of the app's", async () => {
    const { ask, run, host } = setup({ permissions: ["files"] });
    run();
    host.nextPick = [{ path: "a.mp4", bytes: bytes(1) }, { path: "b.mp4", bytes: bytes(1) }];
    const [a] = (await ask("files.pick")).value as { id: string }[];
    expect(await ask("files.forget", [a!.id])).toEqual({ id: expect.any(Number), ok: true });
    expect(((await ask("files.list")).value as unknown[])).toHaveLength(1);
    expect(await ask("files.forget", ["all"])).toMatchObject({ ok: true });
    expect(await ask("files.list")).toMatchObject({ ok: true, value: [] });
    expect(await ask("files.forget", ["../x"])).toMatchObject({ ok: false, error: "bad-request" });
  });
});
