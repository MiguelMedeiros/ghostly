import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyUpdate, askForShare, forwardShare, listenForShares, openedForShare, prepareUpdate } from "../../../web/src/pwa/serviceWorker";
import { incomingShare, resetIncomingShare } from "../../lib/incomingShare";

// covers: app.pwa.update, app.pwa.share-target

/** A service worker as the page sees one: its state moves when the test says so. */
class FakeWorker extends EventTarget {
  posted: unknown[] = [];
  constructor(public state: string) { super(); }
  postMessage(message: unknown) { this.posted.push(message); }
  become(state: string) { this.state = state; this.dispatchEvent(new Event("statechange")); }
}

class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  active: FakeWorker | null = new FakeWorker("activated");
  update = vi.fn(async () => {});
}

class FakeContainer extends EventTarget {
  controller: FakeWorker | null;
  started = false;
  constructor(public registration: FakeRegistration) { super(); this.controller = registration.active; }
  getRegistration = vi.fn(async () => this.registration);
  get ready() { return Promise.resolve(this.registration); }
  startMessages() { this.started = true; }
}

let registration: FakeRegistration;
let container: FakeContainer;

beforeEach(() => {
  registration = new FakeRegistration();
  container = new FakeContainer(registration);
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  resetIncomingShare();
  window.location.hash = "";
});
afterEach(() => {
  Reflect.deleteProperty(navigator, "serviceWorker");
  Reflect.deleteProperty(window, "isSecureContext");
  window.location.hash = "";
});

describe("Reload on a new version", () => {
  it("a deploy found: the browser fetches the new worker at once", async () => {
    prepareUpdate();
    await vi.waitFor(() => expect(registration.update).toHaveBeenCalled());
  });

  it("the waiting worker is told to take over, and the page reloads once it has", async () => {
    const next = new FakeWorker("installed");
    registration.waiting = next;
    const reload = vi.fn();
    const applying = applyUpdate({ reload });
    await vi.waitFor(() => expect(next.posted).toEqual([{ type: "skip-waiting" }]));
    expect(reload).not.toHaveBeenCalled();
    container.controller = next;
    container.dispatchEvent(new Event("controllerchange"));
    await applying;
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a worker still installing is waited for", async () => {
    const next = new FakeWorker("installing");
    registration.update.mockImplementation(async () => {
      registration.installing = next;
      registration.dispatchEvent(new Event("updatefound"));
    });
    const reload = vi.fn();
    const applying = applyUpdate({ reload });
    await vi.waitFor(() => expect(registration.update).toHaveBeenCalled());
    expect(next.posted).toEqual([]);
    registration.installing = null;
    registration.waiting = next;
    next.become("installed");
    await vi.waitFor(() => expect(next.posted).toEqual([{ type: "skip-waiting" }]));
    container.dispatchEvent(new Event("controllerchange"));
    await applying;
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("no newer worker in time: a plain reload, nothing told to skip waiting", async () => {
    const reload = vi.fn();
    await applyUpdate({ timeoutMs: 20, reload });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(registration.active!.posted).toEqual([]);
  });

  it("no worker at all (a browser without them): a plain reload", async () => {
    Reflect.deleteProperty(navigator, "serviceWorker");
    const reload = vi.fn();
    await applyUpdate({ reload });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("a share, on the page's side", () => {
  it("the page opened for it asks the worker for it", async () => {
    window.location.hash = "#/shared";
    expect(openedForShare()).toBe(true);
    askForShare();
    await vi.waitFor(() => expect(registration.active!.posted).toEqual([{ type: "share-ready" }]));
  });

  it("a page that waits for another tab has it forwarded there", async () => {
    window.location.hash = "#/shared";
    forwardShare();
    await vi.waitFor(() => expect(registration.active!.posted).toEqual([{ type: "share-forward" }]));
  });

  it("a page not opened for one asks for nothing", async () => {
    askForShare();
    forwardShare();
    await Promise.resolve();
    expect(registration.active!.posted).toEqual([]);
  });

  it("what the worker hands over goes to the picker", () => {
    listenForShares();
    expect(container.started).toBe(true);
    const item = { title: "", text: "hi", url: "", files: [] };
    container.dispatchEvent(Object.assign(new Event("message"), { data: { type: "share", item } }));
    expect(incomingShare()).toEqual(item);
    expect(window.location.hash).toBe("#/shared");
    container.dispatchEvent(Object.assign(new Event("message"), { data: { type: "something else" } }));
    expect(incomingShare()).toEqual(item);
  });
});
