import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  allowingViewerGuard,
  CLIPBOARD_GUARD_HASH,
  CLIPBOARD_GUARD_SCRIPT,
  guardViewerAnswer,
  utf8Decode,
  utf8Encode,
  VIEWER_GUARD_CSP,
  VIEWER_GUARD_HASH,
  VIEWER_GUARD_SCRIPT,
  WEBRTC_GUARD,
} from "../src/index";

// covers: services.web-open

const CLIPBOARD = { script: CLIPBOARD_GUARD_SCRIPT, hash: CLIPBOARD_GUARD_HASH };

async function read(body: AsyncIterable<Uint8Array>): Promise<string> {
  let text = "";
  for await (const chunk of body) text += utf8Decode(chunk);
  return text;
}

describe("the clipboard guard of a contact's app on the web", () => {
  it("is allowed by its hash, and the srcdoc copy it makes of itself is the same text", () => {
    const hash = createHash("sha256").update(CLIPBOARD_GUARD_SCRIPT).digest("base64");
    expect(CLIPBOARD_GUARD_HASH).toBe(`'sha256-${hash}'`);
    const fn = CLIPBOARD_GUARD_SCRIPT.slice(1, CLIPBOARD_GUARD_SCRIPT.lastIndexOf(")("));
    expect(`(${fn})(window)`).toBe(CLIPBOARD_GUARD_SCRIPT);
    expect(CLIPBOARD_GUARD_SCRIPT.startsWith("(function noClipboardWrites(w) {")).toBe(true);
    // An HTML page reads it inline: nothing that would change on the way.
    expect(CLIPBOARD_GUARD_SCRIPT).not.toMatch(/[\\`]|\$\{|<\/script/i);
    // It finds the WebRTC guard's srcdoc copy by its start, when both run.
    expect(`<script>${VIEWER_GUARD_SCRIPT}`.startsWith("<script>(function noWebRtc(")).toBe(true);
    for (const name of ["execCommand", "paste", "eventPhase", "isTrusted", "contentWindow", "contentDocument", "getSVGDocument", "attachShadow", "setHTMLUnsafe", "parseHTMLUnsafe", "writeln", "shadowrootmode", "appendChild", "insertAdjacentHTML", "outerHTML", "insertNode", "surroundContents"]) expect(CLIPBOARD_GUARD_SCRIPT).toContain(name);
  });

  it("goes first in a page with the WebRTC guard after it, and the contact's policy takes both hashes", async () => {
    expect(allowingViewerGuard("script-src 'self'", [CLIPBOARD_GUARD_HASH, VIEWER_GUARD_HASH])).toBe(`script-src 'self' ${CLIPBOARD_GUARD_HASH} ${VIEWER_GUARD_HASH}`);
    const both = await guardViewerAnswer(
      [["content-type", "text/html"], ["content-security-policy", "default-src 'self'"]],
      (async function* () { yield utf8Encode("<!doctype html><p>hi"); })(),
      "iframe",
      [CLIPBOARD, WEBRTC_GUARD],
    );
    expect(await read(both.body)).toBe(`<!doctype html><script>${CLIPBOARD_GUARD_SCRIPT}</script><script>${VIEWER_GUARD_SCRIPT}</script><p>hi`);
    expect(both.headers.filter(([name]) => name === "content-security-policy").map(([, value]) => value))
      .toEqual([`default-src 'self' ${CLIPBOARD_GUARD_HASH} ${VIEWER_GUARD_HASH}`, VIEWER_GUARD_CSP]);
    const alone = await guardViewerAnswer([["content-type", "text/html"]], (async function* () { yield utf8Encode("<p>hi"); })(), "iframe", [CLIPBOARD]);
    expect(await read(alone.body)).toBe(`<script>${CLIPBOARD_GUARD_SCRIPT}</script><p>hi`);
  });
});

/**
 * The guard's rule, run in a DOM: a copy or a cut counts only while a trusted tap is being dispatched, a paste never.
 * Real taps and real clipboards are the e2e's (e2e/web/services-web-clipboard.spec.ts).
 */
describe("the clipboard guard's rule", () => {
  it("refuses a copy, a cut and a paste outside a tap, and passes every other command on", () => {
    const calls: string[] = [];
    class Doc { execCommand(command: string) { calls.push(command); return true; } }
    class Ev { get eventPhase() { return 0; } }
    const listeners: string[] = [];
    const w = {
      Reflect, Object, String, TypeError,
      Document: Doc,
      Event: Ev,
      EventTarget: { prototype: { addEventListener(type: string) { listeners.push(type); } } },
      Element: { prototype: {} },
      DocumentFragment: { prototype: {} },
      NodeList: { prototype: { get length() { return 0; } } },
      MutationObserver: class { observe() {} },
      get length() { return 0; },
      document: null as unknown,
    };
    Object.defineProperty(Doc.prototype, "defaultView", { get() { return w; } });
    w.document = new Doc();
    new Function("window", CLIPBOARD_GUARD_SCRIPT)(w);
    const doc = w.document as Doc;
    expect(doc.execCommand("copy")).toBe(false);
    expect(doc.execCommand("CUT")).toBe(false);
    expect(doc.execCommand("paste")).toBe(false);
    expect(doc.execCommand("bold")).toBe(true);
    expect(calls).toEqual(["bold"]);
    expect(listeners).toEqual(expect.arrayContaining(["pointerdown", "click", "keydown", "touchend"]));
    // Fixed in place, and the document it watches marked: the bridge reads both to know the guard ran in the page.
    const fixed = Object.getOwnPropertyDescriptor(Doc.prototype, "execCommand")!;
    expect([fixed.writable, fixed.configurable]).toEqual([false, false]);
    expect(Object.getOwnPropertyDescriptor(doc, "ghostlyClipboardGuard")).toMatchObject({ value: true, writable: false, configurable: false });
    // A window kept from its first, empty page (a same-origin page loaded in it): the new document is watched and
    // marked, and the window's guard is the one already there.
    listeners.length = 0;
    w.document = new Doc();
    new Function("window", CLIPBOARD_GUARD_SCRIPT)(w);
    expect(Object.getOwnPropertyDescriptor(w.document as object, "ghostlyClipboardGuard")?.value).toBe(true);
    expect(listeners).toEqual(["load"]);
    expect(Doc.prototype.execCommand).toBe(fixed.value);
  });
});

/**
 * A fake window for the guard's rule: events carry an own `isTrusted` getter (as a browser's do, unforgeable), are
 * dispatched in phases (the guard's capture listener first, then the page's, then the default action with the phase
 * back at 0), and the tasks the guard queues to close a tap's window run only when the test ends the task. Time
 * passes only when the test says so (`spin`); an event's own `timeStamp` is the time it was dispatched unless given.
 */
function tapWindow(closers: { channel?: boolean; postTask?: boolean; frame?: boolean } = { channel: true }) {
  const tasks: (() => void)[] = [];
  const urgent: (() => void)[] = [];
  const frames: (() => void)[] = [];
  const listeners = new Map<string, ((event: Ev) => void)[]>();
  /** The `load` listeners of the window's document (the guard's sweep of its frames). */
  const sweeps: unknown[] = [];
  /** Whether `document.open()` takes the listeners away (a browser ignores it in some states: then nothing goes). */
  let clears = true;
  /** Whether the document has an insertion point (opened, not closed yet): a write then only adds to what is parsed. */
  let parsing = false;
  /** What a write gives, as the browser parses it: the scripts the page wrote run here. */
  let parse: (() => void) | null = null;
  /** Each write the browser was given, by its name. */
  const written: [string, string][] = [];
  /** How many listeners were asked for on the window, the ones already there too. */
  let asked = 0;
  // HTML's document open steps: every listener of the document and, for its window's own document, of the window.
  const openSteps = (doc: unknown) => {
    if (!clears || doc !== w.document) return;
    listeners.clear();
    sweeps.length = 0;
    parsing = true;
  };
  class Doc {
    execCommand(command: string) { return command !== ""; }
    open() { openSteps(this); return this; }
    close() { parsing = false; }
    // A write with no insertion point (the page has loaded) runs those same open steps itself, not `open()`.
    write(html: string) { this.parsed("write", html); }
    writeln(html: string) { this.parsed("writeln", html); }
    parsed(name: string, html: string) {
      if (!parsing) openSteps(this);
      written.push([name, html]);
      if (html !== "") parse?.();
    }
  }
  let now = 10_000;
  class Ev { phase = 0; stamp = now; get eventPhase() { return this.phase; } get timeStamp() { return this.stamp; } }
  class Port {
    other: Port | null = null;
    onmessage: (() => void) | null = null;
    postMessage() { const to = this.other!; tasks.push(() => to.onmessage?.()); }
  }
  class Channel {
    port1 = new Port();
    port2 = new Port();
    constructor() { this.port1.other = this.port2; this.port2.other = this.port1; }
  }
  const w: Record<string, unknown> = {
    Reflect, Object, String, TypeError,
    Document: Doc,
    Event: Ev,
    // As a browser's: a listener already there for that type is not added twice (the guard's are all capturing).
    EventTarget: { prototype: { addEventListener(this: unknown, type: string, listener: (event: Ev) => void) {
      if (this === w.document && type === "load" && !sweeps.includes(listener)) sweeps.push(listener);
      if (this !== w) return;
      asked++;
      const there = listeners.get(type) ?? [];
      if (!there.includes(listener)) listeners.set(type, [...there, listener]);
    } } },
    Element: { prototype: {} },
    DocumentFragment: { prototype: {} },
    NodeList: { prototype: { get length() { return 0; } } },
    MutationObserver: class { observe() {} },
    get length() { return 0; },
    document: null,
    performance: { now: () => now },
  };
  if (closers.channel) Object.assign(w, { MessageChannel: Channel, MessagePort: Port });
  if (closers.postTask) w.scheduler = { postTask(task: () => void, options: { priority?: string }) { if (options.priority === "user-blocking") urgent.push(task); return Promise.resolve(); } };
  if (closers.frame) w.requestAnimationFrame = (frame: () => void) => { frames.push(frame); return frames.length; };
  // A document of the window's own realm that is not its page (`createHTMLDocument`) has no window.
  Object.defineProperty(Doc.prototype, "defaultView", { get(this: unknown) { return this === w.document ? w : null; } });
  w.document = new Doc();
  new Function("window", CLIPBOARD_GUARD_SCRIPT)(w);
  const doc = w.document as Doc;
  const copy = () => doc.execCommand("copy");
  /** Dispatches one event; `copied` holds what a copy in the page's own listener (or in its default action) got. */
  const dispatch = (type: string, trusted: boolean, page?: () => void, then?: () => void, stamp = now) => {
    const event = new Ev();
    event.stamp = stamp;
    Object.defineProperty(event, "isTrusted", { get: () => trusted, enumerable: true });
    event.phase = 1;
    for (const listener of listeners.get(type) ?? []) listener(event);
    event.phase = 2;
    page?.();
    event.phase = 0;
    then?.();
  };
  const run = (queue: (() => void)[]) => { for (const task of queue.splice(0)) task(); };
  return {
    copy, dispatch, listeners,
    /** The page rewrites itself: `document.open()` as it calls it (the guard's, if it wrapped it), on `on`. */
    rewrite: (on: object = doc, clearing = true) => { clears = clearing; (Doc.prototype.open as (this: object) => unknown).call(on); clears = true; },
    sweeps,
    written,
    /**
     * The page rewrites itself with `document.write()` or `writeln()` (the guard's, if it wrapped them) after it loaded,
     * then `document.close()`; `during` runs as a script it wrote; `clearing` false: the browser ignores the write.
     */
    write: (name: "write" | "writeln" = "write", on: object = doc, during: (() => void) | null = null, clearing = true) => {
      parse = during;
      clears = clearing;
      (Doc.prototype[name] as (this: object, html: string) => unknown).call(on, "<p>new</p>");
      clears = true;
      parse = null;
      (on as Doc).close();
    },
    asked: () => asked,
    newDocument: () => new Doc(),
    /** The page keeps the thread for `ms` (a busy loop): time passes, no task runs. */
    spin: (ms: number) => { now += ms; },
    now: () => now,
    /** The page's own `requestAnimationFrame`: one frame's callbacks run in the order they were asked for. */
    requestFrame: (frame: () => void) => { frames.push(frame); },
    endTask: () => run(tasks),
    nextTask: () => tasks.shift()?.(),
    runUrgent: () => run(urgent),
    runFrame: () => run(frames),
  };
}

describe("the clipboard guard's taps and what a tap sets off", () => {
  it("listens for exactly the person's own inputs, and for a submit and a change", () => {
    const { listeners } = tapWindow();
    expect([...listeners.keys()].sort()).toEqual([
      "auxclick", "change", "click", "contextmenu", "dblclick", "keydown", "keypress", "keyup",
      "mousedown", "mouseup", "pointerdown", "pointerup", "submit", "touchend", "touchstart",
    ]);
  });

  it("lets a copy through in a double click and in the app's own context menu, as in a click", () => {
    const page = tapWindow();
    const got: Record<string, boolean> = {};
    for (const type of ["dblclick", "contextmenu", "click"]) page.dispatch(type, true, () => { got[type] = page.copy(); });
    expect(got).toEqual({ dblclick: true, contextmenu: true, click: true });
    // Fired by a script, neither counts.
    for (const type of ["dblclick", "contextmenu"]) page.dispatch(type, false, () => { got[type] = page.copy(); });
    expect(got).toMatchObject({ dblclick: false, contextmenu: false });
  });

  it("lets a copy through in a submit or a change that a tap's default action fires, in its dispatch only", () => {
    const page = tapWindow();
    const got: Record<string, boolean> = {};
    // A click on a submit button: the browser fires submit once the click's dispatch is over, in the same task.
    page.dispatch("click", true, undefined, () => page.dispatch("submit", true, () => { got.submit = page.copy(); }));
    page.endTask();
    // A checkbox's click fires its change the same way.
    page.dispatch("click", true, undefined, () => page.dispatch("change", true, () => { got.checkbox = page.copy(); }));
    page.endTask();
    // Enter in a field: the browser submits the form in the keypress's default action.
    page.dispatch("keypress", true, undefined, () => page.dispatch("submit", true, () => { got.enter = page.copy(); }));
    page.endTask();
    // requestSubmit() called in the click's own listener.
    page.dispatch("click", true, () => page.dispatch("submit", true, () => { got.inClick = page.copy(); }));
    page.endTask();
    expect(got).toEqual({ submit: true, checkbox: true, enter: true, inClick: true });
    // In the default action but outside the submit's dispatch, and a submit the script made itself: no.
    page.dispatch("click", true, undefined, () => {
      got.between = page.copy();
      page.dispatch("submit", false, () => { got.untrusted = page.copy(); });
    });
    page.endTask();
    expect(got).toMatchObject({ between: false, untrusted: false });
  });

  it("refuses a copy in a submit or a change a script fires outside a tap, or after the tap's task", async () => {
    const page = tapWindow();
    const got: Record<string, boolean> = {};
    // form.requestSubmit() or input.click() on load: both fire a trusted event, with no tap at all.
    page.dispatch("submit", true, () => { got.load = page.copy(); });
    page.dispatch("change", true, () => { got.loadChange = page.copy(); });
    // From a timer after a tap: the tap's window closed with its task.
    page.dispatch("pointerdown", true);
    page.endTask();
    page.dispatch("submit", true, () => { got.timer = page.copy(); });
    // From a promise after a tap.
    page.dispatch("click", true);
    page.endTask();
    await Promise.resolve();
    page.dispatch("change", true, () => { got.promise = page.copy(); });
    expect(got).toEqual({ load: false, loadChange: false, timer: false, promise: false });
  });

  it("closes the window at whichever closing task runs first, whichever tap queued it", () => {
    const urgent = tapWindow({ postTask: true, frame: true });
    let got: boolean | undefined;
    urgent.dispatch("click", true);
    urgent.runUrgent();
    urgent.dispatch("submit", true, () => { got = urgent.copy(); });
    expect(got).toBe(false);
    const frame = tapWindow({ postTask: true, frame: true });
    frame.dispatch("click", true);
    frame.runFrame();
    frame.dispatch("submit", true, () => { got = frame.copy(); });
    expect(got).toBe(false);
    // Two taps in one task (a key's keydown and keypress): no guard task runs between them, and the keypress's default
    // action (Enter's submit) is over before the first one does, so that first one closes the window.
    const page = tapWindow();
    page.dispatch("keydown", true);
    page.dispatch("keypress", true);
    page.nextTask();
    page.dispatch("submit", true, () => { got = page.copy(); });
    expect(got).toBe(false);
    page.nextTask();
    page.dispatch("submit", true, () => { got = page.copy(); });
    expect(got).toBe(false);
  });

  it("refuses a submit from an animation frame the page asks for in a click's pointerdown, though the click comes later", () => {
    // A click is five taps; the guard's frame callback at pointerdown runs ahead of the page's, and closes the window
    // the later taps of the same click opened.
    const page = tapWindow({ channel: true, postTask: true, frame: true });
    const got: Record<string, boolean> = {};
    page.dispatch("pointerdown", true, () => page.requestFrame(() => page.dispatch("submit", true, () => { got.frame = page.copy(); })));
    page.dispatch("mousedown", true);
    page.dispatch("pointerup", true);
    page.dispatch("mouseup", true);
    page.dispatch("click", true);
    page.runFrame();
    expect(got).toEqual({ frame: false });
  });

  it("lets a submit through from an animation frame the page asked for before the tap, in the frame right after it", () => {
    // Chromium runs the frame callbacks asked for before an input in the rendering step right after it, ahead of the
    // guard's own message and task: the window holds that step too (WISP 701), and closes at the guard's frame callback.
    const page = tapWindow({ channel: true, postTask: true, frame: true });
    const got: Record<string, boolean> = {};
    page.requestFrame(() => page.dispatch("submit", true, () => { got.before = page.copy(); }));
    page.dispatch("click", true, undefined, () => page.requestFrame(() => page.dispatch("submit", true, () => { got.after = page.copy(); })));
    page.runFrame();
    expect(got).toEqual({ before: true, after: false });
  });

  it("refuses a copy that comes long after the tap, though the page kept the tap's dispatch going all that time", () => {
    // Chromium lets execCommand("copy") write for seconds after a tap: a page that spins in its own click listener
    // keeps that click being dispatched, and the person may copy something of their own meanwhile.
    const page = tapWindow({ channel: true, postTask: true, frame: true });
    const got: Record<string, boolean> = {};
    page.dispatch("click", true, () => { page.spin(900); got.quick = page.copy(); });
    page.endTask();
    page.dispatch("click", true, () => { page.spin(3000); got.spun = page.copy(); });
    page.endTask();
    // A submit or a change the tap's default action fires counts from the tap, not from itself.
    page.dispatch("click", true, () => page.spin(3000), () => page.dispatch("submit", true, () => { got.submit = page.copy(); }));
    page.endTask();
    page.dispatch("pointerdown", true, () => page.spin(3000), undefined);
    page.dispatch("change", true, () => { got.change = page.copy(); });
    page.endTask();
    expect(got).toEqual({ quick: true, spun: false, submit: false, change: false });
  });

  it("counts from the input's own time when the page kept it waiting, and from its dispatch when that time is off", () => {
    const page = tapWindow();
    const got: Record<string, boolean> = {};
    // The person released the button while the page spun in its pointerdown: the click is dispatched 3 s late.
    page.dispatch("click", true, () => { got.late = page.copy(); }, undefined, page.now() - 3000);
    page.endTask();
    // A time on another clock (ahead of now): the dispatch's own start counts.
    page.dispatch("click", true, () => { got.ahead = page.copy(); }, undefined, page.now() + 1e12);
    page.endTask();
    page.dispatch("click", true, () => { page.spin(3000); got.aheadSpun = page.copy(); }, undefined, page.now() + 1e12);
    expect(got).toEqual({ late: false, ahead: true, aheadSpun: false });
  });

  it("counts no submit or change at all where it can queue no closing task", () => {
    const page = tapWindow({});
    let got: boolean | undefined;
    page.dispatch("click", true, () => { got = page.copy(); });
    expect(got).toBe(true);
    page.dispatch("click", true, undefined, () => page.dispatch("submit", true, () => { got = page.copy(); }));
    expect(got).toBe(false);
  });

  it("listens for the person's inputs again once the page rewrites itself with document.open()", () => {
    // document.open() takes every listener of the document and of its window away: a copy button of the rewritten page
    // copies on a tap again, a form of it on the submit a tap fires, and still nothing outside a tap.
    const page = tapWindow();
    const inputs = [...page.listeners.keys()].sort();
    page.rewrite();
    expect([...page.listeners.keys()].sort()).toEqual(inputs);
    expect(page.sweeps).toHaveLength(1);
    const got: Record<string, boolean> = {};
    page.dispatch("click", true, () => { got.click = page.copy(); });
    page.endTask();
    page.dispatch("click", true, undefined, () => page.dispatch("submit", true, () => { got.submit = page.copy(); }));
    page.endTask();
    page.dispatch("submit", true, () => { got.load = page.copy(); });
    page.dispatch("click", false, () => { got.untrusted = page.copy(); });
    expect(got).toEqual({ click: true, submit: true, load: false, untrusted: false });
  });

  it("adds its listeners back once for each document.open(), and none twice where that took none away", () => {
    const page = tapWindow();
    const each = page.asked();
    expect(each).toBe(15);
    page.rewrite();
    page.rewrite();
    expect(page.asked()).toBe(3 * each);
    for (const [type, kept] of page.listeners) expect(kept, type).toHaveLength(1);
    // One the browser ignores (called while the page is still parsed) takes nothing away: the guard asks for its own
    // again, and the browser keeps a listener already there once.
    page.rewrite(undefined, false);
    expect(page.listeners.size).toBe(15);
    for (const [type, kept] of page.listeners) expect(kept, type).toHaveLength(1);
    // A document of the window's realm that is not its page (no window of its own): nothing of the window's.
    const asked = page.asked();
    page.rewrite(page.newDocument());
    expect(page.asked()).toBe(asked);
    expect(page.listeners.size).toBe(15);
  });

  it("listens for the person's inputs again once the page rewrites itself with document.write() after it loaded", () => {
    // A write with no insertion point runs the document open steps without calling `document.open()`: the rewritten
    // page's copy button copies on a tap again, and still nothing outside one.
    for (const name of ["write", "writeln"] as const) {
      const page = tapWindow();
      const inputs = [...page.listeners.keys()].sort();
      expect(page.sweeps, name).toHaveLength(1);
      const sweep = page.sweeps[0];
      // A script the page wrote runs inside the write: the inputs and the document's sweep of its frames (which reaches
      // a frame it wrote as that frame's first load fires) are listened for already.
      let during: unknown[] = [];
      page.write(name, undefined, () => { during = [[...page.listeners.keys()].sort(), [...page.sweeps]]; });
      expect(during, name).toEqual([inputs, [sweep]]);
      expect([...page.listeners.keys()].sort(), name).toEqual(inputs);
      expect(page.sweeps, name).toEqual([sweep]);
      // The page's own text goes to the browser once, by the page's own call (`writeln` adds its newline to it only).
      expect(page.written, name).toEqual([["write", ""], [name, "<p>new</p>"]]);
      const got: Record<string, boolean> = {};
      page.dispatch("click", true, () => { got.click = page.copy(); });
      page.endTask();
      page.dispatch("submit", true, () => { got.load = page.copy(); });
      expect(got, name).toEqual({ click: true, load: false });
      for (const [type, kept] of page.listeners) expect(kept, type).toHaveLength(1);
      // One the browser ignores (a deferred script's, after the page was parsed) takes nothing away and adds nothing twice.
      page.write(name, undefined, null, false);
      expect(page.listeners.size, name).toBe(15);
      for (const [type, kept] of page.listeners) expect(kept, type).toHaveLength(1);
      expect(page.sweeps, name).toEqual([sweep]);
      // A document of the window's realm that is not its page: nothing of the window's.
      const asked = page.asked();
      page.write(name, page.newDocument());
      expect(page.asked(), name).toBe(asked);
    }
  });

  it("listens again in a frame's own window when the page writes that frame with document.open()", () => {
    // A frame's window runs a guard of its own, whose `document.open()` is the one `frame.contentDocument.open()`
    // calls: the frame's taps count again there, and the page's own window is left as it was.
    const page = tapWindow();
    const frame = tapWindow();
    const asked = page.asked();
    frame.rewrite();
    let got: boolean | undefined;
    frame.dispatch("click", true, () => { got = frame.copy(); });
    expect(got).toBe(true);
    expect(page.asked()).toBe(asked);
    expect(page.listeners.size).toBe(15);
  });
});

describe("the clipboard guard's Trusted Types default policy", () => {
  type Rules = Record<string, ((input: string, type: string, sink: string) => string | null) | undefined>;
  class Policy { constructor(readonly name: string, readonly rules: Rules) {} }
  class Factory {
    defaultPolicy: Policy | null = null;
    createPolicy(name: string, rules: Rules) {
      if (name === "default" && this.defaultPolicy) throw new TypeError(`Policy with name "default" already exists.`);
      const policy = new Policy(name, rules);
      if (name === "default") this.defaultPolicy = policy;
      return policy;
    }
  }
  /** A window with Trusted Types, the guard run in it; `html` and `navigate` are what the browser asks the default policy. */
  function guarded() {
    class Doc { execCommand() { return true; } }
    const types = new Factory();
    const w = {
      Reflect, Object, String, TypeError,
      Document: Doc,
      Event: class { get eventPhase() { return 0; } },
      EventTarget: { prototype: { addEventListener() {} } },
      Element: { prototype: {} },
      DocumentFragment: { prototype: {} },
      NodeList: { prototype: { get length() { return 0; } } },
      MutationObserver: class { observe() {} },
      get length() { return 0; },
      trustedTypes: types,
      document: null as unknown,
    };
    Object.defineProperty(Doc.prototype, "defaultView", { get() { return w; } });
    w.document = new Doc();
    new Function("window", CLIPBOARD_GUARD_SCRIPT)(w);
    const ask = (kind: string, input: string, sink: string) => types.defaultPolicy!.rules[kind]!(input, kind, sink);
    return {
      types,
      html: (input: string) => ask("createHTML", input, "Element innerHTML"),
      script: (input: string) => ask("createScript", input, "eval"),
      navigate: (url: string) => ask("createScript", url, "Location href"),
    };
  }

  it("passes every string but a javascript: URL on, while the app made no default policy of its own", () => {
    const page = guarded();
    expect(page.types.defaultPolicy?.name).toBe("default");
    expect(page.html("<b>hi</b>")).toBe("<b>hi</b>");
    expect(page.script("1 + 1")).toBe("1 + 1");
    expect(page.navigate("javascript:alert(1)")).toBeNull();
  });

  it("lets the app make its own, and hands it every string but a javascript: URL", () => {
    const page = guarded();
    const sinks: string[] = [];
    const own = page.types.createPolicy("default", {
      createHTML: (input, _type, sink) => { sinks.push(sink); return input.replace("<b>", "<i>"); },
      createScript: (input) => input,
    });
    expect(own).toBe(page.types.defaultPolicy);
    expect(own.name).toBe("default");
    expect(page.html("<b>hi</b>")).toBe("<i>hi</b>");
    expect(sinks).toEqual(["Element innerHTML"]);
    expect(page.script("1 + 1")).toBe("1 + 1");
    // The app's policy would pass it: the guard's refusal comes first.
    expect(page.navigate("javascript:alert(1)")).toBeNull();
    // Once, as in a browser; other names go to the browser's own.
    expect(() => page.types.createPolicy("default", {})).toThrow(/already exists/);
    expect(page.types.createPolicy("mine", {}).name).toBe("mine");
    expect(() => guarded().types.createPolicy("default", { createHTML: "no" as never })).toThrow(TypeError);
  });

  it("passes a string on as it is where the app's own policy has no rule for it, but a javascript: URL", () => {
    // The app sends no Trusted Types policy of its own: only Ghostly's asks its default policy at all, so a script
    // URL it never gave a rule for must load as it does outside the view.
    const page = guarded();
    page.types.createPolicy("default", { createHTML: (input) => input.replace("<b>", "") });
    expect(page.html("<b>hi")).toBe("hi");
    expect(page.types.defaultPolicy!.rules.createScriptURL!("/lib.js", "createScriptURL", "HTMLScriptElement src")).toBe("/lib.js");
    expect(page.script("1 + 1")).toBe("1 + 1");
    expect(page.navigate("javascript:alert(1)")).toBeNull();
  });
});

/**
 * The apps' origins under a services host share its site: a cookie one sets for the whole host would be read by every
 * other contact's app open at once. The guard keeps each one the page's script sets to the page's own host.
 */
describe("the clipboard guard's cookies", () => {
  /** A window whose `document.cookie` and `cookieStore` record every write, the guard run in it. */
  function guarded() {
    const writes: string[] = [];
    const changes: [string, unknown][] = [];
    class Doc { execCommand() { return true; } }
    Object.defineProperty(Doc.prototype, "cookie", {
      configurable: true,
      enumerable: true,
      get() { return writes.join("; "); },
      set(value: string) { writes.push(value); },
    });
    class Store {
      set(...args: unknown[]) { changes.push(["set", args.length > 1 ? args : { ...(args[0] as object) }]); return Promise.resolve(); }
      delete(options: unknown) { changes.push(["delete", typeof options === "object" ? { ...(options as object) } : options]); return Promise.resolve(); }
    }
    const w = {
      Reflect, Object, String, TypeError,
      Document: Doc,
      CookieStore: Store,
      cookieStore: new Store(),
      Event: class { get eventPhase() { return 0; } },
      EventTarget: { prototype: { addEventListener() {} } },
      Element: { prototype: {} },
      DocumentFragment: { prototype: {} },
      NodeList: { prototype: { get length() { return 0; } } },
      MutationObserver: class { observe() {} },
      get length() { return 0; },
      document: null as unknown,
    };
    Object.defineProperty(Doc.prototype, "defaultView", { get() { return w; } });
    w.document = new Doc();
    new Function("window", CLIPBOARD_GUARD_SCRIPT)(w);
    return { doc: w.document as { cookie: string }, store: w.cookieStore, writes, changes, Doc, Store };
  }

  it("leaves a Domain attribute out of a document.cookie write, whatever its case or spacing, and keeps the rest", () => {
    const { doc, writes } = guarded();
    doc.cookie = "a=1; Domain=svc.example; Path=/";
    doc.cookie = "b=2;domain=.svc.example;Secure;SameSite=None;Partitioned";
    doc.cookie = "c=3; \tDOMAIN = svc.example ";
    doc.cookie = "domain=4; Path=/x";
    doc.cookie = { toString: () => "e=5; Domain=svc.example" } as unknown as string;
    doc.cookie = "f=6;; Domain";
    expect(writes).toEqual(["a=1; Path=/", "b=2;Secure;SameSite=None;Partitioned", "c=3", "domain=4; Path=/x", "e=5", "f=6;"]);
  });

  it("does not split the cookie with a method the page can change after it ran", () => {
    const { doc, writes } = guarded();
    const real = String.prototype.split;
    const symbol = Object.getOwnPropertyDescriptor(String.prototype, Symbol.split);
    String.prototype.split = () => ["x"];
    Object.defineProperty(String.prototype, Symbol.split, { value: () => ["x"], configurable: true, writable: true });
    try {
      doc.cookie = "a=1; Domain=svc.example";
    } finally {
      String.prototype.split = real;
      if (symbol) Object.defineProperty(String.prototype, Symbol.split, symbol);
      else delete (String.prototype as unknown as Record<symbol, unknown>)[Symbol.split];
    }
    expect(writes).toEqual(["a=1"]);
  });

  it("leaves a domain out of cookieStore.set and cookieStore.delete, and passes the rest on", async () => {
    const { store, changes } = guarded();
    await store.set({ name: "a", value: "1", domain: "svc.example", path: "/", sameSite: "none", partitioned: true } as never);
    await store.set("b", "2");
    await store.delete({ name: "a", domain: "svc.example", path: "/" } as never);
    await store.delete("b");
    // A function is a dictionary too, to the browser.
    const callable = Object.defineProperties(() => {}, { name: { value: "c" }, value: { value: "3" }, domain: { value: "svc.example" } });
    await store.set(callable as never);
    expect(changes).toEqual([
      ["set", { name: "a", value: "1", path: "/", sameSite: "none", partitioned: true }],
      ["set", ["b", "2"]],
      ["delete", { name: "a", path: "/" }],
      ["delete", "b"],
      ["set", { name: "c", value: "3" }],
    ]);
  });

  it("reads each member of the options once, so a getter cannot hand the domain on after the guard looked", async () => {
    const { store, changes } = guarded();
    let reads = 0;
    const options = { name: "a", get value() { reads++; return "1"; }, domain: "svc.example" };
    await store.set(options as never);
    expect(reads).toBe(1);
    expect(changes).toEqual([["set", { name: "a", value: "1" }]]);
  });

  it("is fixed in place: the page cannot put the browser's setter or methods back", () => {
    const { Doc, Store } = guarded();
    const cookie = Object.getOwnPropertyDescriptor(Doc.prototype, "cookie")!;
    expect(cookie.configurable).toBe(false);
    for (const name of ["set", "delete"]) {
      expect(Object.getOwnPropertyDescriptor(Store.prototype, name)).toMatchObject({ writable: false, configurable: false });
    }
  });
});

/**
 * The guard looks over the page's frames as each insertion returns: what that costs must not grow with the frames it
 * cannot go into (another origin's, where each try threw a SecurityError) or has already guarded for good.
 */
describe("the clipboard guard's look over the frames", () => {
  /** A window of the page's own origin; `reads` counts the guard's runs in it (each reads its `Reflect` first). */
  function realm(frames: unknown[] = []) {
    class Doc { execCommand() { return true; } }
    class Node { appendChild<T>(child: T) { return child; } }
    const counted = { reads: 0 };
    const w: Record<string, unknown> = {
      Object, String, TypeError, WeakSet,
      Document: Doc,
      Node,
      Event: class { get eventPhase() { return 0; } },
      EventTarget: { prototype: { addEventListener() {} } },
      Element: { prototype: {} },
      DocumentFragment: { prototype: {} },
      NodeList: { prototype: { get length() { return 0; } } },
      MutationObserver: class { observe() {} },
      document: null,
    };
    Object.defineProperty(w, "Reflect", { get() { counted.reads++; return Reflect; } });
    Object.defineProperty(w, "length", { get() { return frames.length; } });
    frames.forEach((frame, i) => { w[i] = frame; });
    Object.defineProperty(Doc.prototype, "defaultView", { get() { return w; } });
    w.document = new Doc();
    return { w, Doc, Node, counted };
  }

  it("leaves a frame of another origin untouched, and runs once more only in a frame whose document is new", () => {
    let touched = 0;
    const other = new Proxy(Object.create(null) as object, {
      getPrototypeOf: () => null,
      get() { touched++; throw new Error("SecurityError"); },
    });
    const frame = realm();
    const page = realm([other, frame.w]);
    new Function("window", CLIPBOARD_GUARD_SCRIPT)(page.w);
    const insert = () => new page.Node().appendChild({});
    for (let i = 0; i < 20; i++) insert();
    expect(touched).toBe(0);
    // Its first run guarded it, the next found it so: no more after that, however many insertions.
    expect(frame.counted.reads).toBe(2);
    expect(Object.getOwnPropertyDescriptor(frame.Doc.prototype, "execCommand")?.configurable).toBe(false);
    // The frame loads another document in the same window: the next insertion's look watches it.
    frame.w.document = new frame.Doc();
    insert();
    expect(Object.getOwnPropertyDescriptor(frame.w.document as object, "ghostlyClipboardGuard")?.value).toBe(true);
    for (let i = 0; i < 20; i++) insert();
    expect(frame.counted.reads).toBe(4);
  });
});
