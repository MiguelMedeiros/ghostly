import { beforeEach, describe, expect, it, vi } from "vitest";
import { fire, settle, type FakeWorld } from "./fakeChrome";
import { engineControl, okResponse, resetEngine } from "./fakeEngine";
import { OTHER_PEER, PEER, SERVICE, bodyText, bootExtension, engine, openViewer, pauseRequest } from "./extension";

vi.mock("@ghostly/browser/engine/server", async () => (await import("./fakeEngine")).engineServerModule);

let world: FakeWorld;

beforeEach(async () => {
  resetEngine();
  world = await bootExtension();
});

const send = (message: unknown) => world.chrome.runtime.sendMessage(message);

/** The error class of the modules the extension loaded (fresh per boot), so `instanceof` holds in there. */
async function httpError(code: string, message: string): Promise<Error> {
  const { GhostlyHttpError } = await import("@ghostly/core");
  return new GhostlyHttpError(code, message);
}

describe("the service worker keeps one peer", () => {
  it("creates the offscreen document once, however many pages ask at the same time", async () => {
    const replies = await Promise.all([1, 2, 3].map(() => send({ target: "background", type: "ensure-engine" })));
    expect(replies).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(world.callsTo("offscreen.createDocument")).toEqual([
      [{ url: "offscreen.html", reasons: ["WEB_RTC"], justification: expect.stringContaining("WebRTC") }],
    ]);
    expect(engine().options).toEqual({ platform: "extension" });

    // Later asks find the document and only check that the peer answers.
    expect(await send({ target: "background", type: "ensure-engine" })).toEqual({ ok: true });
    expect(world.callsTo("offscreen.createDocument")).toHaveLength(1);
  });

  it("starts the peer when the browser starts or the extension is installed", async () => {
    fire(world.chrome.runtime.onStartup);
    await settle();
    expect(world.callsTo("offscreen.createDocument")).toHaveLength(1);
    fire(world.chrome.runtime.onInstalled);
    await settle();
    expect(world.callsTo("offscreen.createDocument")).toHaveLength(1);
  });

  it("says so when the peer never answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      // The document is created but its script never listens.
      world.onCreateDocument = async () => {};
      const reply = send({ target: "background", type: "ensure-engine" });
      await vi.advanceTimersByTimeAsync(100 * 50 + 1000);
      expect(await reply).toEqual({ ok: false, error: expect.stringContaining("did not start") });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for the peer to be ready before saying the engine is there", async () => {
    let ready!: () => void;
    engineControl().ready = new Promise<void>((resolve) => (ready = resolve));
    let answered = false;
    const reply = send({ target: "background", type: "ensure-engine" }).then((r) => ((answered = true), r));
    await settle();
    expect(answered).toBe(false);
    ready();
    expect(await reply).toEqual({ ok: true });
  });
});

describe("messages nobody should act on", () => {
  it.each([
    ["an unknown background type", { target: "background", type: "reload-everything" }],
    ["an unknown engine type", { target: "engine", type: "export-keys" }],
    ["an unknown target", { target: "wallet", type: "ensure-engine" }],
    ["no target", { type: "ensure-engine" }],
    ["null", null],
    ["a string", "ensure-engine"],
    ["a number", 42],
  ])("%s gets no answer and does nothing", async (_, message) => {
    await expect(send(message)).rejects.toThrow("message port closed");
    expect(world.callsTo("offscreen.createDocument")).toEqual([]);
    expect(world.callsTo("tabs.create")).toEqual([]);
  });

  it("nothing outside the extension is heard: no external listeners at all", async () => {
    await send({ target: "background", type: "ensure-engine" });
    expect(world.chrome.runtime.onMessageExternal.hasListeners()).toBe(false);
    expect(world.chrome.runtime.onConnectExternal.hasListeners()).toBe(false);
  });
});

describe("open-payment-link", () => {
  it.each([
    "lightning:lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq",
    "lightning:LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS",
    "bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq?amount=0.0001&label=Coffee&lightning=lnbc1x",
    "bitcoin:BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ?ark=tark1q",
  ])("hands %s to the system's wallet", async (uri) => {
    expect(await send({ target: "background", type: "open-payment-link", uri })).toEqual({ ok: true });
    expect(world.callsTo("tabs.create")).toEqual([[uri]]);
  });

  it.each([
    "https://evil.example/pay",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "chrome://settings",
    "file:///etc/passwd",
    "lightning:",
    "LIGHTNING:LNBC1",
    "lightning:lnbc1 x",
    "lightning:lnbc1\n",
    "lightning:lnbc1<script>",
    "bitcoin:bc1q?label=a#fragment",
    "bitcoin:bc1q/../../x",
    `lightning:${"a".repeat(4097)}`,
    "",
    42,
    null,
    // Coerced to "lightning:lnbc1" by a regex test, were the type not checked first.
    ["lightning:lnbc1"],
    { href: "lightning:lnbc1" },
  ])("refuses %s without opening anything", async (uri) => {
    expect(await send({ target: "background", type: "open-payment-link", uri })).toEqual({ ok: false, error: "Not a payment link" });
    expect(world.callsTo("tabs.create")).toEqual([]);
  });
});

describe("the page and the peer talk over the 'ui' port", () => {
  it("connects through the host: engine first, then a port the peer attaches to", async () => {
    const { extensionHost } = await world.load("page", () => import("../src/host.ts"));
    const received: unknown[] = [];
    let disconnected = false;
    const connection = await extensionHost.connect(
      (message) => received.push(message),
      () => (disconnected = true),
    );
    const server = engine();
    expect(world.callsTo("runtime.sendMessage")[0]).toEqual([{ target: "background", type: "ensure-engine" }]);
    expect(server.attached).toHaveLength(1);

    connection.send({ id: 1, method: "getState", params: [] } as never);
    await settle();
    expect(server.handled.map((h) => h.request)).toEqual([{ id: 1, method: "getState", params: [] }]);
    expect(server.handled[0].client).toBe(server.attached[0]);

    server.attached[0].post({ kind: "state", state: { links: [] } } as never);
    await settle();
    expect(received).toEqual([{ kind: "state", state: { links: [] } }]);

    // The peer's end closes (the offscreen document went away): the page hears it.
    expect(disconnected).toBe(false);
    world.ports[0].receiver.disconnect();
    await settle();
    expect(disconnected).toBe(true);
  });

  it("detaches the page when its port closes", async () => {
    await send({ target: "background", type: "ensure-engine" });
    const port = world.chrome.runtime.connect({ name: "ui" });
    const server = engine();
    expect(server.attached).toHaveLength(1);
    port.disconnect();
    await settle();
    expect(server.detached).toEqual(server.attached);
  });

  it("ignores ports by any other name", async () => {
    await send({ target: "background", type: "ensure-engine" });
    const port = world.chrome.runtime.connect({ name: "devtools" });
    port.postMessage({ id: 1, method: "exportIdentity", params: [] });
    await settle();
    expect(engine().attached).toEqual([]);
    expect(engine().handled).toEqual([]);
  });

  it("fails the page's connect when the peer cannot start", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      world.onCreateDocument = async () => {};
      const { extensionHost } = await world.load("page", () => import("../src/host.ts"));
      const connecting = extensionHost.connect(() => {}, () => {});
      const failed = expect(connecting).rejects.toThrow("did not start");
      await vi.advanceTimersByTimeAsync(6000);
      await failed;
      expect(world.callsTo("runtime.connect")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("viewer tabs", () => {
  it("opens one tab bound to one contact's service, intercepting only the virtual origin", async () => {
    const tabId = await openViewer(world);
    expect(world.callsTo("tabs.create")).toEqual([["about:blank"]]);
    expect(world.session.get(`viewer:${tabId}`)).toEqual({ peerPubKeyZ32: PEER, serviceId: SERVICE });
    expect(world.callsTo("debugger.attach")).toEqual([[{ tabId }, "1.3"]]);
    expect(world.callsTo("debugger.sendCommand").map(([, method, params]) => [method, params])).toEqual([
      ["Fetch.enable", { patterns: [{ urlPattern: "https://*.invalid/*", requestStage: "Request" }] }],
      ["Page.enable", undefined],
    ]);
    expect(world.tabs.get(tabId)!.url).toBe(`https://${SERVICE}.${PEER}.invalid/`);
  });

  it.each([
    ["a peer key that is not z-base-32", "l".repeat(52), SERVICE],
    ["a short peer key", PEER.slice(1), SERVICE],
    ["a service id with a dot", PEER, "atlas.evil"],
    ["an upper-case service id", PEER, "Atlas"],
    ["a host injection", `${PEER}.invalid/@evil.example`, SERVICE],
  ])("refuses %s before opening a tab", async (_, peer, service) => {
    const reply = await send({ target: "background", type: "open-service", peerPubKeyZ32: peer, serviceId: service });
    expect(reply).toEqual({ ok: false, error: "Invalid service" });
    expect(world.callsTo("tabs.create")).toEqual([]);
    expect(world.callsTo("debugger.attach")).toEqual([]);
  });

  it("closes the tab and forgets it when DevTools cannot attach", async () => {
    world.failDebuggerAttach = "Another debugger is already attached to the tab.";
    const reply = await send({ target: "background", type: "open-service", peerPubKeyZ32: PEER, serviceId: SERVICE });
    expect(reply).toEqual({ ok: false, error: "Another debugger is already attached to the tab." });
    const [[tabId]] = world.callsTo("tabs.remove") as [[number]];
    expect(world.tabs.has(tabId)).toBe(false);
    await settle();
    expect(world.session.has(`viewer:${tabId}`)).toBe(false);
  });

  it("serves the tab's own origin from the peer, with method, path, headers and body", async () => {
    const tabId = await openViewer(world);
    engineControl().respond = async () => okResponse("<h1>atlas</h1>", 201, [["content-type", "text/html"]]);
    const answer = await pauseRequest(world, tabId, {
      url: `https://${SERVICE}.${PEER}.invalid/api/items?limit=5`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      postData: '{"name":"ç"}',
    });
    expect(answer.method).toBe("Fetch.fulfillRequest");
    expect(answer.params).toMatchObject({ responseCode: 201, responseHeaders: [{ name: "content-type", value: "text/html" }] });
    expect(bodyText(answer.params)).toBe("<h1>atlas</h1>");

    const [request] = engine().requests;
    expect(request.peer).toBe(PEER);
    expect(request.service).toBe(SERVICE);
    expect(request.init).toMatchObject({ method: "POST", path: "/api/items?limit=5", headers: [["Content-Type", "application/json"]] });
    expect(new TextDecoder().decode(request.init.body!)).toBe('{"name":"ç"}');
    expect(request.init.maxResponseBytes).toBe(32 * 1024 * 1024);
  });

  it("joins a body DevTools hands over in several pieces", async () => {
    const tabId = await openViewer(world);
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    await pauseRequest(world, tabId, {
      url: `https://${SERVICE}.${PEER}.invalid/upload`,
      method: "PUT",
      postDataEntries: [{ bytes: b64("part one, ") }, {}, { bytes: b64("part two") }],
    });
    expect(new TextDecoder().decode(engine().requests[0].init.body!)).toBe("part one, part two");
  });

  it("refuses another contact's origin, another service, or anything else in the tab", async () => {
    const tabId = await openViewer(world);
    for (const url of [
      `https://${SERVICE}.${OTHER_PEER}.invalid/`,
      `https://notes.${PEER}.invalid/`,
      `https://${SERVICE}.${PEER}.invalid:8443/`,
      `http://${SERVICE}.${PEER}.invalid/`,
      `https://x.${SERVICE}.${PEER}.invalid/`,
      "https://example.com/",
    ]) {
      const answer = await pauseRequest(world, tabId, { url });
      expect(answer, url).toEqual({ method: "Fetch.failRequest", params: { requestId: expect.any(String), errorReason: "BlockedByClient" } });
    }
    expect(engine().requests).toEqual([]);
  });

  it("refuses requests from a tab it never bound, or one that was closed", async () => {
    const tabId = await openViewer(world);
    const url = `https://${SERVICE}.${PEER}.invalid/`;
    expect((await pauseRequest(world, 9999, { url })).method).toBe("Fetch.failRequest");
    await world.chrome.tabs.remove(tabId);
    await settle();
    expect(world.session.has(`viewer:${tabId}`)).toBe(false);
    expect((await pauseRequest(world, tabId, { url })).method).toBe("Fetch.failRequest");
    expect(engine().requests).toEqual([]);
  });

  it("does not let a peer's Set-Cookie widen its domain", async () => {
    const tabId = await openViewer(world);
    engineControl().respond = async () =>
      okResponse("", 200, [
        ["Set-Cookie", `sid=1; Domain=${PEER}.invalid; Path=/\nother=2; path=/; domain = .invalid; HttpOnly`],
        ["X-Domain", "Domain=kept"],
      ]);
    const answer = await pauseRequest(world, tabId, { url: `https://${SERVICE}.${PEER}.invalid/` });
    expect(answer.params.responseHeaders).toEqual([
      { name: "Set-Cookie", value: "sid=1; Path=/\nother=2; path=/; HttpOnly" },
      { name: "X-Domain", value: "Domain=kept" },
    ]);
  });

  it("answers 503 when the contact is gone and 502 with an escaped reason otherwise", async () => {
    const tabId = await openViewer(world);
    const url = `https://${SERVICE}.${PEER}.invalid/`;
    const offline = await httpError("offline", "offline");
    engineControl().respond = async () => {
      throw offline;
    };
    const gone = await pauseRequest(world, tabId, { url });
    expect(gone.params).toMatchObject({
      responseCode: 503,
      responseHeaders: expect.arrayContaining([{ name: "x-ghostly-error", value: "offline" }, { name: "cache-control", value: "no-store" }]),
    });
    expect(bodyText(gone.params)).toContain("This service is not reachable");

    engineControl().respond = async () => {
      throw new Error('<img src=x onerror="alert(1)">');
    };
    const failed = await pauseRequest(world, tabId, { url });
    expect(failed.params).toMatchObject({ responseCode: 502 });
    expect(failed.params.responseHeaders).toContainEqual({ name: "x-ghostly-error", value: "error" });
    const html = bodyText(failed.params);
    expect(html).not.toContain("<img");
    expect(html).toContain("&#60;img src=x onerror=&#34;alert(1)&#34;&#62;");
  });

  it("stops intercepting once the tab leaves the virtual origin, and only then", async () => {
    const tabId = await openViewer(world);
    const navigate = (frame: { url: string; parentId?: string }) =>
      fire(world.chrome.debugger.onEvent, { tabId }, "Page.frameNavigated", { frame });
    navigate({ url: "about:blank" });
    navigate({ url: `https://${SERVICE}.${PEER}.invalid/page` });
    navigate({ url: "https://example.com/", parentId: "frame-1" });
    await settle();
    expect(world.callsTo("debugger.detach")).toEqual([]);
    navigate({ url: "https://example.com/" });
    await settle();
    expect(world.callsTo("debugger.detach")).toEqual([[{ tabId }]]);
  });

  it("ignores debugger events that do not come from a tab", async () => {
    fire(world.chrome.debugger.onEvent, { extensionId: "x" }, "Fetch.requestPaused", {
      requestId: "1",
      request: { url: `https://${SERVICE}.${PEER}.invalid/`, method: "GET", headers: {} },
    });
    await settle();
    expect(world.callsTo("debugger.sendCommand")).toEqual([]);
  });
});

describe("the toolbar button", () => {
  it("opens the app once, then brings that tab back", async () => {
    fire(world.chrome.action.onClicked);
    await settle();
    const appUrl = world.chrome.runtime.getURL("app.html");
    expect(world.callsTo("tabs.create")).toEqual([[appUrl]]);
    const [tab] = [...world.tabs.values()];

    fire(world.chrome.action.onClicked);
    await settle();
    expect(world.callsTo("tabs.create")).toHaveLength(1);
    expect(world.callsTo("tabs.update")).toEqual([[tab.id, { active: true }]]);
    expect(world.callsTo("windows.update")).toEqual([[tab.windowId, { focused: true }]]);
  });
});

describe("the offscreen peer", () => {
  it("says goodbye to its peers when the page goes away", async () => {
    await send({ target: "background", type: "ensure-engine" });
    world.page.dispatchEvent(new Event("pagehide"));
    expect(engine().shutdowns).toBe(1);
  });

  it("answers an http-request only once it is ready, and reports a failure as a code", async () => {
    await send({ target: "background", type: "ensure-engine" });
    const tooLarge = await httpError("too-large", "Response too large");
    engineControl().respond = async () => {
      throw tooLarge;
    };
    const reply = await send({
      target: "engine",
      type: "http-request",
      peerPubKeyZ32: PEER,
      serviceId: SERVICE,
      method: "GET",
      path: "/",
      headers: [],
      bodyB64: null,
    });
    expect(reply).toEqual({ ok: false, code: "too-large", message: "Response too large" });
    expect(engine().requests[0].init.body).toBeNull();
  });
});
