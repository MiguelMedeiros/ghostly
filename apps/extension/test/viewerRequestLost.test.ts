import { beforeEach, describe, expect, it, vi } from "vitest";
import { fire, type FakeWorld } from "./fakeChrome";
import { engineControl, okResponse, resetEngine, type EngineResponse } from "./fakeEngine";
import { PEER, SERVICE, TAG, bodyText, bootExtension, engine, openViewer, pauseRequest } from "./extension";

// covers: services.open

vi.mock("@ghostly/browser/engine/server", async () => (await import("./fakeEngine")).engineServerModule);

let world: FakeWorld;

beforeEach(async () => {
  resetEngine();
  world = await bootExtension();
});

const url = `https://${SERVICE}.${PEER}.${TAG}.invalid/`;

/** Every request a peer sent to the contact, across every peer the worker started. */
const toContact = () => engineControl().servers.flatMap((s) => s.requests.map((r) => `${r.init.method} ${r.init.path}`));

/**
 * The first request reaches the contact and its answer never comes (the contact's app is slow); any later one is
 * answered at once.
 */
function firstAnswerNeverComes(): void {
  let first = true;
  engineControl().respond = () => {
    if (first) {
      first = false;
      return new Promise<EngineResponse>(() => {});
    }
    return Promise.resolve(okResponse("answered", 200, [["content-type", "text/plain"]]));
  };
}

/** Pauses `request` in the tab, and returns what the worker told DevTools once it answered. */
async function answerOf(tabId: number, request: { method: string; path: string; postData?: string }, meanwhile: () => Promise<void>) {
  const requestId = `${request.method}-${request.path}`;
  const before = world.callsTo("debugger.sendCommand").length;
  const answered = () => world.callsTo("debugger.sendCommand").slice(before).find(([, , p]) => (p as { requestId?: string })?.requestId === requestId);
  fire(world.chrome.debugger.onEvent, { tabId }, "Fetch.requestPaused", {
    requestId,
    resourceType: "XHR",
    request: { url: `${url}${request.path.slice(1)}`, method: request.method, headers: { "content-type": "application/json" }, ...(request.postData ? { postData: request.postData } : {}) },
  });
  await meanwhile();
  await vi.waitFor(() => expect(answered()).toBeDefined(), { timeout: 10_000 });
  const [, method, params] = answered()!;
  return { method: method as string, params: params as Record<string, unknown> };
}

const header = (params: Record<string, unknown>, name: string) =>
  (params.responseHeaders as { name: string; value: string }[]).find((h) => h.name === name)?.value;

describe("a contact's app's request cut off by the peer's document going away", () => {
  it("a POST the peer already took is not sent to the contact again: the tab gets its error page", async () => {
    const tabId = await openViewer(world);
    firstAnswerNeverComes();
    const answer = await answerOf(tabId, { method: "POST", path: "/api/order", postData: '{"qty":1}' }, async () => {
      await vi.waitFor(() => expect(toContact()).toEqual(["POST /api/order"]));
      // A renderer crash, or the document ended from Chrome's task manager, while the contact answers.
      world.endOffscreen();
    });
    // Sent once, and only once: the next peer does not send it again.
    expect(toContact()).toEqual(["POST /api/order"]);
    expect(answer.method).toBe("Fetch.fulfillRequest");
    expect(answer.params.responseCode).toBe(502);
    expect(header(answer.params, "x-ghostly-error")).toBe("error");
  });

  it("a GET the peer already took is asked again of the next peer, and the tab gets its answer", async () => {
    const tabId = await openViewer(world);
    firstAnswerNeverComes();
    const answer = await answerOf(tabId, { method: "GET", path: "/api/items" }, async () => {
      await vi.waitFor(() => expect(toContact()).toEqual(["GET /api/items"]));
      world.endOffscreen();
    });
    expect(toContact()).toEqual(["GET /api/items", "GET /api/items"]);
    expect(answer.method).toBe("Fetch.fulfillRequest");
    expect(answer.params.responseCode).toBe(200);
    expect(bodyText(answer.params)).toBe("answered");
  });

  it("a POST with no document to take it starts a peer and goes to the contact once", async () => {
    const tabId = await openViewer(world);
    world.endOffscreen();
    resetEngine();
    engineControl().respond = async () => okResponse("ordered", 200, [["content-type", "text/plain"]]);
    const answer = await pauseRequest(world, tabId, { url: `${url}api/order`, method: "POST", postData: '{"qty":1}' });
    expect(world.offscreenDocument).toBe(true);
    expect(toContact()).toEqual(["POST /api/order"]);
    expect(answer.method).toBe("Fetch.fulfillRequest");
    expect(answer.params.responseCode).toBe(200);
    expect(bodyText(answer.params)).toBe("ordered");
  });

  it("a POST whose document went away before taking it is asked of the next peer", async () => {
    const tabId = await openViewer(world);
    // The document has the ask but waits on its peer's start: nothing went to the contact yet.
    const held = engine();
    Object.defineProperty(held, "ready", { value: new Promise<void>(() => {}) });
    engineControl().respond = async () => okResponse("ordered", 200, [["content-type", "text/plain"]]);
    const answer = await answerOf(tabId, { method: "POST", path: "/api/order", postData: '{"qty":1}' }, async () => {
      await vi.waitFor(() => expect(world.callsTo("runtime.connect")).toContainEqual(["viewer"]));
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(toContact()).toEqual([]);
      world.endOffscreen();
    });
    expect(held.requests).toEqual([]);
    expect(toContact()).toEqual(["POST /api/order"]);
    expect(answer.params.responseCode).toBe(200);
    expect(bodyText(answer.params)).toBe("ordered");
  });
});
