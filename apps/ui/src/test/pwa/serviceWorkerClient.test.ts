import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyUpdate, askForShare, buildGone, followNewVersion, forwardShare, listenForShares, onBuildGone, openedForShare, prepareUpdate } from "../../../../web/src/pwa/serviceWorker";
import { carryIncomingShare, incomingShare, resetIncomingShare } from "../../lib/incomingShare";

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

  it("a worker that does not finish installing in time: a plain reload, nothing told to skip waiting", async () => {
    const next = new FakeWorker("installing");
    registration.update.mockImplementation(async () => { registration.installing = next; });
    const reload = vi.fn();
    await applyUpdate({ timeoutMs: 20, reload });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(next.posted).toEqual([]);
    expect(registration.active!.posted).toEqual([]);
  });

  it("the newest worker already controls the page (another tab took the update): it reloads at once", async () => {
    // The other tab's Reload activated it and it claimed this page too: nothing is waiting, nothing installs.
    const newest = new FakeWorker("activated");
    registration.active = newest;
    container.controller = newest;
    const reload = vi.fn();
    void applyUpdate({ reload });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 500 });
    expect(newest.posted).toEqual([]);
  });

  it("no worker at all (a browser without them): a plain reload", async () => {
    Reflect.deleteProperty(navigator, "serviceWorker");
    const reload = vi.fn();
    await applyUpdate({ reload });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("another tab took a new version", () => {
  /** The new worker activates and takes every open page of the app (`clients.claim()` in sw.ts). */
  const takenBy = (worker: FakeWorker) => {
    container.controller = worker;
    container.dispatchEvent(new Event("controllerchange"));
  };

  it("a tab running the app reloads into it as soon as the new worker takes it", async () => {
    const reload = vi.fn();
    const mayStart = followNewVersion({ reload });
    await mayStart(async () => {});
    expect(reload).not.toHaveBeenCalled();
    takenBy(new FakeWorker("activated"));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a tab waiting for the lock does not start the old build: it reloads once the lock is its own and the tab that pressed Reload asked for it again", async () => {
    const reload = vi.fn();
    const mayStart = followNewVersion({ reload });
    takenBy(new FakeWorker("activated"));
    // Waiting on "already open in another tab": nothing runs, so nothing reloads yet; its place for the lock stays.
    expect(reload).not.toHaveBeenCalled();
    let askedAgain = () => {};
    const handOver = vi.fn(() => new Promise<void>((resolve) => { askedAgain = resolve; }));
    let started = false;
    void mayStart(handOver).then(() => { started = true; });
    await vi.waitFor(() => expect(handOver).toHaveBeenCalledTimes(1));
    expect(reload).not.toHaveBeenCalled();
    askedAgain();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(started).toBe(false);
  });

  it("the first worker of all, taking a page that had none, replaces nothing", async () => {
    container.controller = null;
    const reload = vi.fn();
    const mayStart = followNewVersion({ reload });
    takenBy(registration.active!);
    const handOver = vi.fn(async () => {});
    await mayStart(handOver);
    expect(handOver).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("the tab that pressed Reload reloads once, by its own update", async () => {
    const reload = vi.fn();
    void followNewVersion({ reload })(async () => {});
    const next = new FakeWorker("installed");
    registration.waiting = next;
    const applied = vi.fn();
    const applying = applyUpdate({ reload: applied });
    await vi.waitFor(() => expect(next.posted).toEqual([{ type: "skip-waiting" }]));
    takenBy(next);
    await applying;
    expect(applied).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
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
    expect(incomingShare()).toMatchObject(item);
    expect(window.location.hash).toBe("#/shared");
    container.dispatchEvent(Object.assign(new Event("message"), { data: { type: "something else" } }));
    expect(incomingShare()).toMatchObject(item);
  });

  it("still in the picker when the page restarts (a profile switch), it goes back to the worker for the next page", () => {
    listenForShares();
    const item = { title: "", text: "", url: "", files: [new File(["hi"], "note.txt", { type: "text/plain" })] };
    container.dispatchEvent(Object.assign(new Event("message"), { data: { type: "share", item } }));
    expect(carryIncomingShare()).toBe(true);
    expect(registration.active!.posted).toEqual([{ type: "share-keep", item }]);

    // No worker controls the page: nothing can keep it.
    container.controller = null;
    expect(carryIncomingShare()).toBe(false);
  });

  it("a build-gone message tells the app to look for the update now, and the page remembers it", () => {
    listenForShares();
    let told = 0;
    const stop = onBuildGone(() => { told++; });
    expect(buildGone()).toBe(false);
    container.dispatchEvent(Object.assign(new Event("message"), { data: { type: "build-gone" } }));
    expect(told).toBe(1);
    // Remembered for the page's life: every check from now on counts a redeploy of this version as an update.
    expect(buildGone()).toBe(true);
    // Fetching the new worker is the check's, once it finds the deploy (prepareUpdate): not a second time here.
    expect(registration.update).not.toHaveBeenCalled();
    stop();
    container.dispatchEvent(Object.assign(new Event("message"), { data: { type: "build-gone" } }));
    expect(told).toBe(1);
  });
});
