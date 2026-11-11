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
    for (const name of ["execCommand", "paste", "eventPhase", "isTrusted", "contentWindow", "contentDocument", "getSVGDocument", "attachShadow", "setHTMLUnsafe", "parseHTMLUnsafe", "writeln", "shadowrootmode"]) expect(CLIPBOARD_GUARD_SCRIPT).toContain(name);
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
 * back at 0), and the tasks the guard queues to close a tap's window run only when the test ends the task.
 */
function tapWindow(closers: { channel?: boolean; postTask?: boolean; frame?: boolean } = { channel: true }) {
  const tasks: (() => void)[] = [];
  const urgent: (() => void)[] = [];
  const frames: (() => void)[] = [];
  class Doc { execCommand(command: string) { return command !== ""; } }
  class Ev { phase = 0; get eventPhase() { return this.phase; } }
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
  const listeners = new Map<string, ((event: Ev) => void)[]>();
  const w: Record<string, unknown> = {
    Reflect, Object, String, TypeError,
    Document: Doc,
    Event: Ev,
    EventTarget: { prototype: { addEventListener(this: unknown, type: string, listener: (event: Ev) => void) {
      if (this === w) listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    } } },
    Element: { prototype: {} },
    DocumentFragment: { prototype: {} },
    NodeList: { prototype: { get length() { return 0; } } },
    MutationObserver: class { observe() {} },
    get length() { return 0; },
    document: null,
  };
  if (closers.channel) Object.assign(w, { MessageChannel: Channel, MessagePort: Port });
  if (closers.postTask) w.scheduler = { postTask(task: () => void, options: { priority?: string }) { if (options.priority === "user-blocking") urgent.push(task); return Promise.resolve(); } };
  if (closers.frame) w.requestAnimationFrame = (frame: () => void) => { frames.push(frame); return frames.length; };
  Object.defineProperty(Doc.prototype, "defaultView", { get() { return w; } });
  w.document = new Doc();
  new Function("window", CLIPBOARD_GUARD_SCRIPT)(w);
  const doc = w.document as Doc;
  const copy = () => doc.execCommand("copy");
  /** Dispatches one event; `copied` holds what a copy in the page's own listener (or in its default action) got. */
  const dispatch = (type: string, trusted: boolean, page?: () => void, then?: () => void) => {
    const event = new Ev();
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

  it("counts no submit or change at all where it can queue no closing task", () => {
    const page = tapWindow({});
    let got: boolean | undefined;
    page.dispatch("click", true, () => { got = page.copy(); });
    expect(got).toBe(true);
    page.dispatch("click", true, undefined, () => page.dispatch("submit", true, () => { got = page.copy(); }));
    expect(got).toBe(false);
  });
});
