import { describe, expect, it } from "vitest";
import { CLIPBOARD_GUARD_SCRIPT, VIEWER_GUARD_SCRIPT } from "../src/index";

// covers: services.web-open

/**
 * A fake window both guards run in: a blob store behind `URL`, and `Worker` / `SharedWorker` that only say what they
 * were started from. Real workers under Trusted Types are the probe's (headless Chromium, the same page plain and
 * guarded): a blob worker there runs `importScripts` and `eval` only once the guard started it.
 */
function workerWindow({ trustedTypes = true } = {}) {
  const store = new Map<string, Blob>();
  const revoked: string[] = [];
  const started: { maker: string; url: string; options: unknown }[] = [];
  const timers: { run: () => void; after: number }[] = [];
  let next = 0;
  const URLs = {
    createObjectURL(object: unknown) {
      if (!(object instanceof Blob)) throw new TypeError("Not a blob");
      const url = `blob:https://app.test/${++next}`;
      store.set(url, object);
      return url;
    },
    revokeObjectURL(url: unknown) {
      revoked.push(String(url));
      store.delete(String(url));
    },
  };
  class Worker { constructor(url: unknown, options?: unknown) { started.push({ maker: "Worker", url: String(url), options }); } }
  class SharedWorker { constructor(url: unknown, options?: unknown) { started.push({ maker: "SharedWorker", url: String(url), options }); } }
  class TrustedTypes { defaultPolicy = null; createPolicy() { return {}; } }
  class Doc { execCommand() { return true; } open() {} write() {} writeln() {} querySelectorAll() { return []; } }
  class Ev { get eventPhase() { return 0; } get timeStamp() { return 0; } }
  const w: Record<string, unknown> = {
    Reflect, Object, String, TypeError, JSON,
    Document: Doc,
    Event: Ev,
    EventTarget: { prototype: { addEventListener() {} } },
    Element: { prototype: { getAttribute() { return null; }, setAttribute() {}, removeAttribute() {} } },
    DocumentFragment: { prototype: { querySelectorAll() { return []; } } },
    NodeList: { prototype: { get length() { return 0; } } },
    MutationObserver: class { observe() {} },
    get length() { return 0; },
    open() {},
    document: null,
    URL: URLs,
    Blob,
    Worker,
    SharedWorker,
    setTimeout: (run: () => void, after: number) => timers.push({ run, after }),
  };
  if (trustedTypes) w.trustedTypes = new TrustedTypes();
  Object.defineProperty(Doc.prototype, "defaultView", { get() { return w; } });
  w.document = new Doc();
  const run = (script: string) => new Function("window", script)(w);
  /** The text of the script a worker was started from. */
  const text = (url: string) => store.get(url)!.text();
  const page = w as unknown as { URL: typeof URLs; Worker: Maker; SharedWorker: Maker };
  return { w: page, run, store, revoked, started, timers, text, Worker, SharedWorker };
}

/** `Worker` or `SharedWorker` as the page sees it. */
type Maker = { new (url: unknown, options?: unknown): object; (url: unknown): object; name: string };

const POLICY = "createPolicy('default', { createHTML: (s) => s, createScript: (s) => s, createScriptURL: (s) => s })";

describe.each([
  ["the WebRTC guard", [VIEWER_GUARD_SCRIPT]],
  ["the clipboard guard", [CLIPBOARD_GUARD_SCRIPT]],
  ["both guards, the clipboard's first", [CLIPBOARD_GUARD_SCRIPT, VIEWER_GUARD_SCRIPT]],
])("a contact's app's blob: worker under %s", (_, scripts) => {
  it("starts from a script that makes a pass-through Trusted Types default policy first, then runs the app's", async () => {
    const lab = workerWindow();
    for (const script of scripts) lab.run(script);
    const blob = new Blob(['"use strict"; importScripts("/lib.js"); eval("1")'], { type: "text/javascript" });
    const url = lab.w.URL.createObjectURL(blob);
    const worker = new lab.w.Worker(url);
    expect(worker).toBeInstanceOf(lab.w.Worker);
    expect(worker).toBeInstanceOf(lab.Worker);
    expect(worker.constructor).toBe(lab.w.Worker);
    expect(lab.w.Worker.name).toBe("Worker");
    // A worker made from a blob takes the page's policy, `require-trusted-types-for` too, and no guard runs in it:
    // started from the app's blob as it is, its every `importScripts` and `eval` is refused.
    const [classic] = lab.started;
    expect(classic.url).not.toBe(url);
    const said = await lab.text(classic.url);
    expect(said).toContain(POLICY);
    // The app's script is run as it was, after the policy (its own `"use strict"` first in it still counts): from a
    // URL of the guard's, so the app may revoke its own at once.
    const inner = /importScripts\(("[^"]+")\);$/.exec(said)![1];
    expect(said.indexOf(POLICY)).toBeLessThan(said.indexOf("importScripts("));
    expect(lab.store.get(JSON.parse(inner))).toBe(blob);
    expect(JSON.parse(inner)).not.toBe(url);
    // Exactly one wrapper, with both guards in the page.
    expect(said.split("importScripts(").length).toBe(2);

    // A module worker: the policy in a module of its own, imported before the app's (a static import runs first).
    new lab.w.Worker(url, { type: "module" });
    const module = await lab.text(lab.started[1].url);
    const [policy, app] = [...module.matchAll(/import ("[^"]+");/g)].map(([, at]) => JSON.parse(at));
    expect(module).toBe(`import ${JSON.stringify(policy)}; import ${JSON.stringify(app)};`);
    expect(await lab.text(policy)).toContain(POLICY);
    expect(app).toBe(JSON.parse(inner));
    expect(lab.started[1].options).toEqual({ type: "module" });

    // A shared worker made twice from one blob is one worker: the same script both times.
    new lab.w.SharedWorker(url, "a");
    new lab.w.SharedWorker(url, { name: "a" });
    expect(lab.started.slice(2).map((s) => [s.maker, s.url, s.options])).toEqual([["SharedWorker", classic.url, "a"], ["SharedWorker", classic.url, { name: "a" }]]);
    new lab.w.Worker(url);
    expect(lab.started[4].url).toBe(classic.url);
  });

  it("passes any other worker on as it is, and drops its own URLs a minute after the app revokes its blob's", async () => {
    const lab = workerWindow();
    for (const script of scripts) lab.run(script);
    for (const url of ["/worker.js", "https://app.test/w.js", "data:text/javascript,1", "blob:https://app.test/elsewhere"]) new lab.w.Worker(url);
    expect(lab.started.map((s) => s.url)).toEqual(["/worker.js", "https://app.test/w.js", "data:text/javascript,1", "blob:https://app.test/elsewhere"]);
    expect(() => lab.w.Worker("/worker.js")).toThrow(TypeError);
    lab.started.length = 0;

    const url = lab.w.URL.createObjectURL(new Blob(["1"]));
    new lab.w.Worker(url);
    new lab.w.Worker(url, { type: "module" });
    const policy = /import ("[^"]+");/.exec(await lab.text(lab.started[1].url))![1];
    const ours = [...lab.store.keys()].filter((at) => at !== url && at !== JSON.parse(policy));
    expect(ours).toHaveLength(3);
    lab.w.URL.revokeObjectURL(url);
    expect(lab.revoked).toEqual([url]);
    // The app often revokes its URL just after `new Worker`: the worker has yet to load the app's script from the guard's.
    expect(lab.timers.map((t) => t.after)).toEqual([60_000]);
    lab.timers[0].run();
    expect([...lab.revoked].sort()).toEqual([url, ...ours].sort());
    // The policy's module stays, for the next module worker.
    expect([...lab.store.keys()]).toEqual([JSON.parse(policy)]);
    // A blob already revoked runs as it would: refused by the browser, not by the guard.
    new lab.w.Worker(url);
    expect(lab.started.at(-1)!.url).toBe(url);
  });
});

describe("a worker where there is no Trusted Types", () => {
  it("is left as it was", () => {
    // covers: services.web-open
    for (const script of [VIEWER_GUARD_SCRIPT, CLIPBOARD_GUARD_SCRIPT]) {
      const lab = workerWindow({ trustedTypes: false });
      lab.run(script);
      expect(lab.w.Worker).toBe(lab.Worker);
      expect(lab.w.SharedWorker).toBe(lab.SharedWorker);
    }
  });
});
