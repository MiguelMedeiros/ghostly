import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

// covers: apps.desktop-sandbox

// Desktop's runner (`RUNNER` in apps/desktop/src/app_sandbox.rs), run here with Tauri played: every answer and event
// reaches the app window as its JSON text, which the runner parses. A JSON object evaluated as a JavaScript literal is
// not JSON: a `__proto__` member sets the object's prototype (or is dropped), so a contact's message could carry
// members the app cannot see as its own. Parsed, it stays a key, as on the web (the broker's jsonValueOf).

const source = readFileSync(resolve(__dirname, "../../../../desktop/src/app_sandbox.rs"), "utf8");
const runner = /const RUNNER: &str = r#"[\s\S]*?<script>\n([\s\S]*?)<\/script>/.exec(source)![1]!;

type Json = Record<string, unknown>;
type Window = Json & {
  ghostly: {
    chat: { on(event: string, listener: (data: Json) => void): void };
    storage: { get(key: string): Promise<Json>; set(key: string, value: unknown): Promise<unknown> };
  };
  __ghostlyEvent(text: unknown): void;
};

/** The window's `Document`: its `execCommand` edits, as a browser's does (the runner keeps it for every other command). */
class Document {
  execCommand(): boolean { return true; }
  open(): void {}
  write(): void {}
  writeln(): void {}
}

/** The runner in a window of its own; `answer` is the JSON text of Rust's answer to a request. */
function open(answer: (request: { type: string; id?: number }) => string, clock = { t: 1_000 }, sent: unknown[] = []) {
  const written: string[] = [];
  /** The window's events, a class per window: `stopImmediatePropagation` marks the event, so a test sees it was called. */
  class Event {
    stopped = false;
    stopImmediatePropagation(): void { this.stopped = true; }
  }
  /** The window's listeners, by event: the runner's own are the only ones here. */
  const listeners: Record<string, (event: { isTrusted: boolean }) => void> = {};
  /** Whether each was added for the capture phase. */
  const capture: Record<string, unknown> = {};
  const addEventListener = (type: string, listener: (event: { isTrusted: boolean }) => void, options?: unknown) => {
    listeners[type] = listener;
    capture[type] = options;
  };
  const window = {
    origin: "null",
    atob,
    setTimeout,
    Date: { now: () => clock.t },
    addEventListener,
    EventTarget: { prototype: { addEventListener } },
    Event,
    TextEncoder,
    // A document of its own class, as WebKit's is: the runner wraps `Document.prototype.execCommand` before any app code.
    Document,
    document: Object.assign(Object.create(Document.prototype) as object, {
      documentElement: { setAttribute() {}, textContent: "" }, open() {}, write: (html: string) => written.push(html), close() {},
    }),
    __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "app-1" } },
      // Rust sends the answer's JSON text as a JSON string (`json_response`), which Tauri evaluates into the window
      // (`runCallback(id, <body>)`): the call gets that text.
      invoke: async (_command: string, { request }: { request: { type: string; id?: number } }): Promise<unknown> => {
        sent.push(request);
        return runInNewContext(`(${JSON.stringify(answer(request))})`, window);
      },
    },
  } as unknown as Window;
  window.window = window;
  window.self = window;
  runInNewContext(runner, window);
  return { window, written, listeners, capture, Event };
}

const settle = () => new Promise((done) => setTimeout(done, 0));

it("hands a peer message with a __proto__ member to the app as a key, not as the object's prototype", async () => {
  const { window, written } = open((request) => (request.type === "start" ? `"<p>chess</p>"` : `{"id":${request.id},"ok":true,"value":null}`));
  await settle();
  expect(written).toEqual(["<p>chess</p>"]);
  const seen: Json[] = [];
  window.ghostly.chat.on("message", (data) => seen.push(data));
  // What `event_script` makes of {"event":"chat.message","data":{"move":"e4","__proto__":{"admin":true}}} (its Rust test).
  runInNewContext(
    String.raw`window.__ghostlyEvent("{\"data\":{\"__proto__\":{\"admin\":true},\"move\":\"e4\"},\"event\":\"chat.message\"}")`,
    window,
  );
  expect(seen).toHaveLength(1);
  const data = seen[0]!;
  expect(Object.keys(data).sort()).toEqual(["__proto__", "move"]);
  expect(Object.getPrototypeOf(data)).toBe(runInNewContext("Object.prototype", window));
  expect(data.admin).toBeUndefined();
  // Not JSON, or not a string: nothing reaches the app.
  window.__ghostlyEvent({ event: "chat.message", data: 1 });
  window.__ghostlyEvent("{");
  expect(seen).toHaveLength(1);
});

it("says `activity` for the person's taps and keys, at most every 5 seconds, and never for an event the app made", async () => {
  const clock = { t: 1_000 };
  const asked: string[] = [];
  const { listeners } = open((request) => {
    asked.push(request.type);
    return request.type === "start" ? `"<p>chess</p>"` : `{"id":${request.id},"ok":true}`;
  }, clock);
  await settle();
  const said = () => asked.filter((type) => type === "activity").length;
  listeners.pointerdown!({ isTrusted: true });
  expect(said()).toBe(1);
  clock.t += 4_000;
  listeners.keydown!({ isTrusted: true });
  expect(said()).toBe(1);
  clock.t += 1_000;
  listeners.keydown!({ isTrusted: false });
  expect(said()).toBe(1);
  listeners.keydown!({ isTrusted: true });
  expect(said()).toBe(2);
});

// A document opened again (`document.open` with no close, or a write once the page is parsed) erases the window's
// listeners, and the app runs on: the runner's taps-and-keys listener goes back on as it opens, through what the runner
// took before the app's code ran, so the lock screen still counts the person's input in the app.
it("listens for the person's taps and keys again whenever the app opens its document again", async () => {
  const clock = { t: 1_000 };
  const asked: string[] = [];
  const { window, listeners, capture } = open((request) => {
    asked.push(request.type);
    return request.type === "start" ? `"<p>chess</p>"` : `{"id":${request.id},"ok":true}`;
  }, clock);
  await settle();
  const said = () => asked.filter((type) => type === "activity").length;
  runInNewContext("addEventListener = function () {}; Reflect.apply = function () {};", window);
  for (const name of ["open", "write", "writeln"]) {
    delete listeners.pointerdown;
    delete listeners.keydown;
    runInNewContext(`Document.prototype.${name}.call(document)`, window);
    expect([name, capture.pointerdown, capture.keydown, typeof listeners.pointerdown, typeof listeners.keydown]).toEqual([name, true, true, "function", "function"]);
    const before = said();
    clock.t += 5_000;
    listeners.pointerdown!({ isTrusted: true });
    expect(said(), name).toBe(before + 1);
  }
});

// The person's copy or cut in the app window puts on the clipboard what they selected: the app's own listeners, which
// could set other text in its place, never hear it. The runner's capture listener on the window runs before any of the
// app's and stops the event there, through what it took before the app's code ran.
it("stops the person's copy and cut before any of the app's listeners, whatever the app changed", async () => {
  const { window, listeners, capture, Event } = open((request) => (request.type === "start" ? `"<p>bc1qREALADDRESS</p>"` : `{"id":${request.id},"ok":true}`));
  await settle();
  runInNewContext("Event.prototype.stopImmediatePropagation = function () {}; Reflect.apply = function () {};", window);
  for (const type of ["copy", "cut"]) {
    expect(capture[type], type).toBe(true);
    const person = Object.assign(new Event(), { isTrusted: true });
    listeners[type]!(person);
    expect(person.stopped, type).toBe(true);
    // One the app made puts nothing on the clipboard: it goes on to the app's listeners.
    const made = Object.assign(new Event(), { isTrusted: false });
    listeners[type]!(made);
    expect(made.stopped, type).toBe(false);
  }
  // A document opened again erases the window's listeners: the runner's go back on as it opens.
  for (const name of ["open", "write", "writeln"]) {
    delete listeners.copy;
    delete listeners.cut;
    runInNewContext(`Document.prototype.${name}.call(document)`, window);
    expect([name, capture.copy, capture.cut, typeof listeners.copy, typeof listeners.cut]).toEqual([name, true, true, "function", "function"]);
  }
});

it("gives the app an answer with a __proto__ member as a key", async () => {
  const { window } = open((request) =>
    request.type === "start" ? `"<p>chess</p>"` : `{"id":${request.id},"ok":true,"value":{"__proto__":{"admin":true},"board":"e4"}}`,
  );
  await settle();
  const value = await window.ghostly.storage.get("game");
  expect(Object.keys(value).sort()).toEqual(["__proto__", "board"]);
  expect(value.admin).toBeUndefined();
  expect(Object.getOwnPropertyDescriptor(value, "__proto__")!.value).toEqual({ admin: true });
});

// Tauri drops an app window's message far over the broker's 64 KiB unread (`message_limit`), so the runner refuses a
// request over 64 KiB itself: the app gets "too-large", and the request never leaves the window.
it("refuses a request over 64 KiB without sending it", async () => {
  const sent: unknown[] = [];
  const { window } = open((request) => (request.type === "start" ? `"<p>chess</p>"` : `{"id":${request.id},"ok":true,"value":null}`), undefined, sent);
  await settle();
  sent.length = 0;
  // The request as JSON, {"id":2,"type":"storage.set","args":["k","x…"]}, is 64 KiB and then a byte more; "é" is two
  // bytes in UTF-8.
  const around = JSON.stringify({ id: 2, type: "storage.set", args: ["k", ""] }).length;
  await expect(window.ghostly.storage.set("k", "x".repeat(64 * 1024 - around))).resolves.toBeNull();
  expect(sent).toHaveLength(1);
  await expect(window.ghostly.storage.set("k", "x".repeat(64 * 1024 - around + 1))).rejects.toThrow("too-large");
  await expect(window.ghostly.storage.set("k", "é".repeat(32 * 1024))).rejects.toThrow("too-large");
  await expect(window.ghostly.storage.set("k", new Array(8 * 1024 * 1024).fill(0))).rejects.toThrow("too-large");
  expect(sent).toHaveLength(1);
});
