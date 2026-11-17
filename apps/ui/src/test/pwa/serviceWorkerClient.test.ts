import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHARE_FORWARD_AFTER_MS, applyUpdate, askForShare, buildGone, followNewVersion, forwardShare, handShareOver, listenForShares, listenForTaps, onBuildGone, openedForShare, prepareUpdate } from "../../../../web/src/pwa/serviceWorker";
import { carryIncomingShare, dropIncomingShare, incomingShare, resetIncomingShare, sendShareTo, takeShareFor } from "../../lib/incomingShare";
import { activeProfileId, createProfile, unregisterProfile } from "../../lib/profiles";

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
  unregister = vi.fn(async () => true);
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

describe("Reload when the new worker cannot install", () => {
  // The page runs 1.13.0 build aaa; the server's `/version.json` answers what each test says.
  const versionFile = vi.fn<(url: string) => Promise<Response>>();
  const answers = (feed: object) => versionFile.mockImplementation(async () => new Response(JSON.stringify(feed), { status: 200 }));
  const asked = () => versionFile.mock.calls.filter(([url]) => String(url).endsWith("/version.json")).length;
  /** What happened, in order: the worker unregistered, the page reloaded. */
  let steps: string[];
  const reload = () => { steps.push("reload"); };

  beforeEach(() => {
    vi.stubGlobal("__APP_VERSION__", "1.13.0");
    vi.stubGlobal("__APP_BUILD__", "aaa");
    vi.stubGlobal("fetch", versionFile);
    versionFile.mockReset();
    steps = [];
    registration.unregister.mockImplementation(async () => { steps.push("unregister"); return true; });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  /** A deploy's worker starts installing at `update()`, then its install fails (a precache file missing, storage full). */
  const installFails = () => {
    const next = new FakeWorker("installing");
    registration.update.mockImplementation(async () => {
      registration.installing = next;
      setTimeout(() => { registration.installing = null; next.become("redundant"); }, 0);
    });
    return next;
  };

  it("a new build is out: the old worker is unregistered before the reload, so the page loads the new build", async () => {
    answers({ version: "1.13.1", build: "bbb" });
    const next = installFails();
    await applyUpdate({ reload });
    expect(steps).toEqual(["unregister", "reload"]);
    expect(asked()).toBe(1);
    expect(next.posted).toEqual([]);
  });

  it("a redeploy of the same version (another build) counts as a new build too", async () => {
    answers({ version: "1.13.0", build: "ccc" });
    installFails();
    await applyUpdate({ reload });
    expect(steps).toEqual(["unregister", "reload"]);
  });

  it("not installed in time: the same, once the server says a new build is out", async () => {
    answers({ version: "1.13.1", build: "bbb" });
    registration.update.mockImplementation(async () => { registration.installing = new FakeWorker("installing"); });
    await applyUpdate({ timeoutMs: 20, reload });
    expect(steps).toEqual(["unregister", "reload"]);
  });

  it("the new worker's script refused (update() rejects) while a new build is out: the same", async () => {
    answers({ version: "1.13.1", build: "bbb" });
    registration.update.mockImplementation(async () => { throw new TypeError("Failed to update a ServiceWorker: 404"); });
    await applyUpdate({ reload });
    expect(steps).toEqual(["unregister", "reload"]);
  });

  it("the server still has this build: the worker stays, a plain reload", async () => {
    answers({ version: "1.13.0", build: "aaa" });
    installFails();
    await applyUpdate({ reload });
    expect(asked()).toBe(1);
    expect(steps).toEqual(["reload"]);
    expect(registration.unregister).not.toHaveBeenCalled();
  });

  it("offline (the version file does not answer): the worker stays, so the reload still opens the app", async () => {
    versionFile.mockImplementation(async () => { throw new TypeError("Failed to fetch"); });
    installFails();
    await applyUpdate({ reload });
    expect(asked()).toBe(1);
    expect(steps).toEqual(["reload"]);
    expect(registration.unregister).not.toHaveBeenCalled();
  });

  it("the server answers with an error or something else: the worker stays", async () => {
    versionFile.mockImplementation(async () => new Response("<html>bad gateway</html>", { status: 502 }));
    installFails();
    await applyUpdate({ reload });
    versionFile.mockImplementation(async () => new Response("<html>a captive portal</html>", { status: 200 }));
    installFails();
    await applyUpdate({ reload });
    expect(asked()).toBe(2);
    expect(steps).toEqual(["reload", "reload"]);
    expect(registration.unregister).not.toHaveBeenCalled();
  });

  it("nothing newer to install (another tab's Reload already put the new worker in place): never unregistered", async () => {
    answers({ version: "1.13.1", build: "bbb" });
    await applyUpdate({ reload });
    expect(steps).toEqual(["reload"]);
    expect(registration.unregister).not.toHaveBeenCalled();
  });

  it("the new worker installs: it takes over as before, nothing unregistered", async () => {
    answers({ version: "1.13.1", build: "bbb" });
    const next = new FakeWorker("installed");
    registration.waiting = next;
    const applying = applyUpdate({ reload });
    await vi.waitFor(() => expect(next.posted).toEqual([{ type: "skip-waiting" }]));
    container.dispatchEvent(new Event("controllerchange"));
    await applying;
    expect(steps).toEqual(["reload"]);
    expect(registration.unregister).not.toHaveBeenCalled();
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

  it("the page opened for it asks for it once it is the app, even after a link took its address while it waited", async () => {
    window.location.hash = "#/shared";
    const opened = openedForShare();
    // The tab that was the app closed before the wait was over, with an invite in this tab's address by then.
    window.location.hash = "#/invite/abc";
    askForShare(opened);
    await vi.waitFor(() => expect(registration.active!.posted).toEqual([{ type: "share-ready" }]));
  });

  it("a page that waits for another tab has it forwarded there", async () => {
    window.location.hash = "#/shared";
    forwardShare();
    // To this profile's tab only: the worker gives it to no other profile's.
    await vi.waitFor(() => expect(registration.active!.posted).toEqual([{ type: "share-forward", profile: activeProfileId() }]));
  });

  describe("a tab opened for it while another tab is the app", () => {
    beforeEach(() => { vi.useFakeTimers(); window.location.hash = "#/shared"; });
    afterEach(() => { vi.useRealTimers(); });
    const forwards = () => registration.active!.posted.filter((message) => (message as { type: string }).type === "share-forward");
    const say = (type: string) => container.dispatchEvent(Object.assign(new Event("message"), { data: { type } }));

    it("forwards it after the wait, and says it went only once the worker answers", () => {
      const answered = vi.fn();
      handShareOver(() => false, answered);
      vi.advanceTimersByTime(SHARE_FORWARD_AFTER_MS - 1);
      expect(forwards()).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(forwards()).toEqual([{ type: "share-forward", profile: activeProfileId() }]);
      expect(answered).not.toHaveBeenCalled();
      say("share-forwarded");
      expect(answered).toHaveBeenCalledWith("shared");
    });

    it("closed before the wait is over, it forwards at once as it goes, and only once", () => {
      handShareOver(() => false, () => {});
      window.dispatchEvent(new Event("pagehide"));
      // Said as the page goes: nothing later of it runs.
      expect(forwards()).toEqual([{ type: "share-forward", profile: activeProfileId() }]);
      vi.advanceTimersByTime(SHARE_FORWARD_AFTER_MS);
      expect(forwards()).toHaveLength(1);
    });

    it("nothing held to forward: it says so, not that it went", () => {
      const answered = vi.fn();
      handShareOver(() => false, answered);
      vi.advanceTimersByTime(SHARE_FORWARD_AFTER_MS);
      say("share-none");
      expect(answered).toHaveBeenCalledWith("shareNone");
    });

    it("a link reaches the tab before the wait is over: the share is still forwarded, after the wait and as it goes", () => {
      handShareOver(() => false, () => {});
      // The link takes the address, then leaves it for the app's home once the tab that is the app took it.
      window.location.hash = "#/invite/abc";
      vi.advanceTimersByTime(SHARE_FORWARD_AFTER_MS);
      expect(forwards()).toEqual([{ type: "share-forward", profile: activeProfileId() }]);
      registration.active!.posted.length = 0;
      window.location.hash = "#/shared";
      handShareOver(() => false, () => {});
      window.location.hash = "#/";
      window.dispatchEvent(new Event("pagehide"));
      expect(forwards()).toEqual([{ type: "share-forward", profile: activeProfileId() }]);
    });

    it("the tab took over meanwhile: it asks for the share itself, nothing is forwarded", () => {
      const answered = vi.fn();
      handShareOver(() => true, answered);
      vi.advanceTimersByTime(SHARE_FORWARD_AFTER_MS);
      window.dispatchEvent(new Event("pagehide"));
      expect(forwards()).toEqual([]);
    });
  });

  it("the page that takes shares tells the worker its profile, when it starts and whenever it comes to the front", async () => {
    listenForShares();
    await vi.waitFor(() => expect(registration.active!.posted).toEqual([{ type: "share-here", profile: activeProfileId() }]));
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(registration.active!.posted).toHaveLength(2));
    expect(registration.active!.posted[1]).toEqual({ type: "share-here", profile: activeProfileId() });
  });

  it("asked by a worker that restarted with a share to forward, it says it takes shares again, without coming to the front", async () => {
    listenForShares();
    await vi.waitFor(() => expect(registration.active!.posted).toHaveLength(1));
    container.dispatchEvent(Object.assign(new Event("message"), { data: { type: "share-where" } }));
    await vi.waitFor(() => expect(registration.active!.posted).toHaveLength(2));
    expect(registration.active!.posted[1]).toEqual({ type: "share-here", profile: activeProfileId() });
  });

  it("says how Web Locks names it as its peer lock's holder, which the worker checks before it forwards a share here", async () => {
    const query = vi.fn(async () => ({ held: [{ name: "ghostly-peer-work", clientId: "other-tab", mode: "exclusive" }, { name: "ghostly-peer", clientId: "this-tab", mode: "exclusive" }] }));
    Object.defineProperty(navigator, "locks", { configurable: true, value: { query } });
    try {
      listenForShares("ghostly-peer");
      await vi.waitFor(() => expect(registration.active!.posted).toEqual([{ type: "share-here", profile: activeProfileId(), lock: "this-tab" }]));
      window.dispatchEvent(new Event("focus"));
      // (Pages of the tests before listen too: only this one's say the lock.)
      await vi.waitFor(() => expect(registration.active!.posted.filter((message) => (message as { lock?: string }).lock === "this-tab")).toHaveLength(2));
      // Asked once: the page holds that lock for as long as it lives.
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(navigator, "locks");
    }
  });

  it("the app's page on its way out tells the worker, so no share is forwarded to it", async () => {
    listenForShares();
    await vi.waitFor(() => expect(registration.active!.posted).toHaveLength(1));
    window.dispatchEvent(new Event("pagehide"));
    expect(registration.active!.posted.slice(1)).toEqual([{ type: "share-away" }]);
  });

  it("a share never replaces one waiting in the picker: it is offered once that one is put aside", () => {
    listenForShares();
    const mine = { title: "", text: "mine", url: "", files: [] };
    container.dispatchEvent(Object.assign(new Event("message"), { data: { type: "share", item: mine } }));
    window.location.hash = "#/chat/abc";
    for (const text of ["a page's", "two", "three"]) {
      container.dispatchEvent(Object.assign(new Event("message"), { data: { type: "share", item: { title: "", text, url: "", files: [] } } }));
    }
    expect(incomingShare()).toMatchObject(mine);
    // The person left the picker for a chat with it still waiting: a new share opens the picker again, on the one
    // waiting, never behind one that nothing shows.
    expect(window.location.hash).toBe("#/shared");
    dropIncomingShare();
    expect(incomingShare()).toMatchObject({ text: "a page's" });
    dropIncomingShare();
    expect(incomingShare()).toMatchObject({ text: "two" });
    // Three at most: the newest past that was dropped.
    dropIncomingShare();
    expect(incomingShare()).toBeNull();
  });

  it("a share sent to a chat with more waiting: a later share opens the picker on the next one waiting", () => {
    listenForShares();
    const say = (text: string) => container.dispatchEvent(Object.assign(new Event("message"), { data: { type: "share", item: { title: "", text, url: "", files: [] } } }));
    say("one");
    say("two");
    expect(window.location.hash).toBe("#/shared");
    sendShareTo("chat1");
    expect(incomingShare()).toMatchObject({ text: "two" });
    // The person went to a chat anyway (the back button): the share that waits is not on screen.
    window.location.hash = "#/chat/chat1";
    say("three");
    expect(window.location.hash).toBe("#/shared");
    expect(incomingShare()).toMatchObject({ text: "two" });
    dropIncomingShare();
    expect(incomingShare()).toMatchObject({ text: "three" });
  });

  it("a share sent to a chat whose composer has not taken it yet goes back to the worker with the page, ahead of those waiting", () => {
    listenForShares();
    const one = { title: "", text: "one", url: "", files: [] };
    const two = { title: "", text: "two", url: "", files: [] };
    for (const item of [one, two]) container.dispatchEvent(Object.assign(new Event("message"), { data: { type: "share", item } }));
    sendShareTo("chat1");
    window.dispatchEvent(new Event("pagehide"));
    const kept = registration.active!.posted.filter((message) => (message as { type: string }).type === "share-keep");
    expect(kept).toEqual([{ type: "share-keep", item: one }, { type: "share-keep", item: two }]);
    expect(takeShareFor("chat1")).toBeNull();
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

  it("a share given back to the worker takes the count of those that could not be kept with it, the worker's and the picker's", () => {
    listenForShares();
    const say = (text: string, dropped?: number) => container.dispatchEvent(Object.assign(new Event("message"), { data: { type: "share", item: { title: "", text, url: "", files: [] }, ...(dropped && { dropped }) } }));
    say("shown", 2);
    for (const text of ["second", "third", "fourth"]) say(text);
    expect(incomingShare()).toMatchObject({ text: "shown", dropped: 3 });
    expect(carryIncomingShare()).toBe(true);
    const kept = registration.active!.posted.filter((message) => (message as { type: string }).type === "share-keep");
    expect(kept).toEqual([
      { type: "share-keep", item: { title: "", text: "shown", url: "", files: [] }, dropped: 3 },
      { type: "share-keep", item: { title: "", text: "second", url: "", files: [] } },
      { type: "share-keep", item: { title: "", text: "third", url: "", files: [] } },
    ]);
  });

  it("a share into the same window replaces the page: the shares in its picker go back to the worker, once, ahead of the new one", async () => {
    listenForShares();
    await vi.waitFor(() => expect(registration.active!.posted).toHaveLength(1));
    const shown = { title: "", text: "shown", url: "", files: [] };
    const behind = { title: "", text: "behind", url: "", files: [] };
    for (const item of [shown, behind]) container.dispatchEvent(Object.assign(new Event("message"), { data: { type: "share", item } }));
    const kept = () => registration.active!.posted.filter((message) => (message as { type: string }).type === "share-keep");
    window.dispatchEvent(new Event("pagehide"));
    expect(kept()).toEqual([{ type: "share-keep", item: shown }, { type: "share-keep", item: behind }]);
    // Handed back, they are the next page's: a profile switch that carried them already, then the page going, gives them once.
    expect(incomingShare()).toBeNull();
    expect(carryIncomingShare()).toBe(false);
    window.dispatchEvent(new Event("pagehide"));
    expect(kept()).toHaveLength(2);
  });

  it("the shares the worker could not keep are said with the share shown", () => {
    listenForShares();
    container.dispatchEvent(Object.assign(new Event("message"), { data: { type: "share", item: { title: "", text: "one", url: "", files: [] }, dropped: 2 } }));
    expect(incomingShare()).toMatchObject({ text: "one", dropped: 2 });
  });

  it("a wake-up's chat is not this listener's: a tab hears taps before it takes shares (listenForTaps)", () => {
    listenForShares();
    container.dispatchEvent(Object.assign(new Event("message"), { data: { type: "open-chat", path: "/chat/abc", profile: activeProfileId() } }));
    expect(window.location.hash).toBe("");
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

describe("a wake-up notification tapped, on the page's side", () => {
  /** The push worker's `open-ask`, and what this page answers on the port sent with it. */
  const ask = () => {
    const port = { postMessage: vi.fn() };
    container.dispatchEvent(Object.assign(new Event("message"), { data: { type: "open-ask" }, ports: [port] }));
    return port.postMessage.mock.calls;
  };

  it("every tab says which profile it runs and whether it holds the peer, from the moment it loads", () => {
    let peer = false;
    listenForTaps(() => peer);
    expect(container.started).toBe(true);
    expect(ask()).toEqual([[{ profile: activeProfileId(), peer: false }]]);
    peer = true;
    expect(ask()).toEqual([[{ profile: activeProfileId(), peer: true }]]);
  });

  it("the tab that runs the profile opens the chat", () => {
    listenForTaps(() => true);
    container.dispatchEvent(Object.assign(new Event("message"), { data: { type: "open-chat", path: "/chat/abc", profile: activeProfileId() } }));
    expect(window.location.hash).toBe("#/chat/abc");
  });

  it("a tab waiting behind another keeps the chat for when it takes over, instead of dropping it", () => {
    listenForTaps(() => false);
    container.dispatchEvent(Object.assign(new Event("message"), { data: { type: "open-chat", path: "/chat/abc", profile: activeProfileId() } }));
    expect(window.location.hash).toBe("#/chat/abc");
  });

  describe("told on a guess (it said nothing in time: frozen or busy)", () => {
    /** A `silent` open-chat for `profile`: whether this page switched, and what it answered on the port. */
    const guess = (profile: string) => {
      const port = { postMessage: vi.fn() };
      const switched: string[] = [];
      const heard = (event: Event) => switched.push((event as CustomEvent<{ id: string }>).detail.id);
      addEventListener("profile-switching", heard);
      container.dispatchEvent(Object.assign(new Event("message"), { data: { type: "open-chat", path: "/chat/abc", profile, silent: true }, ports: [port] }));
      removeEventListener("profile-switching", heard);
      return { switched, answered: port.postMessage.mock.calls };
    };
    let other: string;
    // A switch restarts the page a moment later: that moment never comes here.
    beforeEach(() => { vi.useFakeTimers(); other = createProfile("Work").id; });
    afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); sessionStorage.clear(); unregisterProfile(other); });

    it("running another profile's peer, it stays that profile and hands the chat back", () => {
      listenForTaps(() => true);
      const { switched, answered } = guess(other);
      expect(switched).toEqual([]);
      expect(window.location.hash).toBe("");
      expect(answered).toEqual([[{ taken: false }]]);
    });

    it("its own profile's frozen window takes it", () => {
      listenForTaps(() => true);
      const { answered } = guess(activeProfileId());
      expect(window.location.hash).toBe("#/chat/abc");
      expect(answered).toEqual([[{ taken: true }]]);
    });

    it("a tab that runs nothing yet (waiting behind another) switches to the notice's profile, as before", () => {
      listenForTaps(() => false);
      const { switched, answered } = guess(other);
      expect(switched).toEqual([other]);
      expect(answered).toEqual([[{ taken: true }]]);
    });
  });
});
