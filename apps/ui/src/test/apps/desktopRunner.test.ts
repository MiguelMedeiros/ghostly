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
  ghostly: { chat: { on(event: string, listener: (data: Json) => void): void }; storage: { get(key: string): Promise<Json> } };
  __ghostlyEvent(text: unknown): void;
};

/** The runner in a window of its own; `answer` is the JSON text of Rust's answer to a request. */
function open(answer: (request: { type: string; id?: number }) => string) {
  const written: string[] = [];
  const window = {
    origin: "null",
    atob,
    setTimeout,
    document: { documentElement: { setAttribute() {}, textContent: "" }, open() {}, write: (html: string) => written.push(html), close() {} },
    __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "app-1" } },
      // Rust sends the answer's JSON text as a JSON string (`json_response`), which Tauri evaluates into the window
      // (`runCallback(id, <body>)`): the call gets that text.
      invoke: async (_command: string, { request }: { request: { type: string; id?: number } }): Promise<unknown> =>
        runInNewContext(`(${JSON.stringify(answer(request))})`, window),
    },
  } as unknown as Window;
  window.window = window;
  window.self = window;
  runInNewContext(runner, window);
  return { window, written };
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
