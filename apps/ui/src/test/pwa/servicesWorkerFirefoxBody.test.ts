import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_PAGE, MAX_REQUEST_BYTES } from "../../../../web/src/svc/protocol";

// covers: services.web-open

/**
 * What a contact's app sends, through the services worker (apps/web/src/svc/worker.ts), in a browser whose `Request`
 * has no `body` stream: Firefox's (`new Request("/x", { method: "POST", body: "z" }).body` is undefined there). The
 * body still reaches the contact, read whole, and within the same limit as where the worker reads it as a stream.
 */
const ORIGIN = `https://${"y".repeat(32)}.svc.ghostly.example`;

interface Client { id: string; url: string; frameType: string; postMessage: ReturnType<typeof vi.fn> }
type FetchListener = (event: { request: unknown; clientId: string; respondWith(response: Promise<Response> | Response): void }) => void;
interface Sent { method: string; path: string; headers: [string, string][]; body: ArrayBuffer | null }

let clients: Client[];
let onFetch: FetchListener;
let bridge: Client;

beforeEach(async () => {
  vi.resetModules();
  // The contact answers everything it is handed with an empty 200.
  const answer = (_message: unknown, transfer: Transferable[]) => {
    const port = transfer[0] as MessagePort;
    port.postMessage({ type: "head", status: 200, headers: [] });
    port.postMessage({ type: "end" });
  };
  bridge = { id: "bridge", url: `${ORIGIN}${BRIDGE_PAGE}`, frameType: "nested", postMessage: vi.fn(answer) };
  clients = [bridge, { id: "app", url: `${ORIGIN}/`, frameType: "nested", postMessage: vi.fn() }];
  const scope = {
    location: new URL(`${ORIGIN}/ghostly-services-sw.js`),
    skipWaiting: async () => {},
    clients: { claim: async () => {}, matchAll: async () => clients, get: async (id: string) => clients.find((client) => client.id === id) },
    addEventListener: (type: string, listener: FetchListener) => { if (type === "fetch") onFetch = listener; },
  };
  vi.stubGlobal("self", scope);
  vi.stubGlobal("__SERVICES_HOST__", "https://*.svc.ghostly.example");
  vi.stubGlobal("__SERVICES_APP_ORIGIN__", "https://app.ghostly.example");
  await import("../../../../web/src/svc/worker");
});

afterEach(() => vi.unstubAllGlobals());

interface Try { method?: string; path?: string; body?: BodyInit; type?: string; length?: number; navigate?: boolean; stream?: boolean }

/**
 * One request of the app's page through the worker's fetch handler, as Firefox hands it over: no `body`, only
 * `arrayBuffer()` (watched). A fetch of the app's script by default; `navigate` makes it a form the frame submits,
 * `type` and `length` its Content-Type and Content-Length, `stream` gives it the body stream Chromium has.
 */
function send(one: Try) {
  const method = one.method ?? "POST";
  const path = one.path ?? "/api/echo";
  const real = new Request(`${ORIGIN}${path}`, { method, body: one.body });
  const headers = new Headers(real.headers);
  if (one.type) headers.set("content-type", one.type);
  if (one.length !== undefined) headers.set("content-length", String(one.length));
  const arrayBuffer = vi.fn(() => real.arrayBuffer());
  const request = {
    url: real.url, method, headers, signal: new AbortController().signal, arrayBuffer,
    mode: one.navigate ? "navigate" : "cors", destination: one.navigate ? "iframe" : "", referrer: one.navigate ? `${ORIGIN}/form` : `${ORIGIN}/`,
    ...(one.stream ? { body: real.body } : {}),
  };
  let answer: Promise<Response> | null = null;
  onFetch({ request, clientId: "app", respondWith: (response) => { answer = Promise.resolve(response); } });
  expect(answer).not.toBeNull();
  return { response: answer! as Promise<Response>, arrayBuffer };
}

/** What the contact was handed, the last time. */
function sent(): Sent {
  const calls = bridge.postMessage.mock.calls;
  return calls[calls.length - 1][0] as Sent;
}

const text = (body: ArrayBuffer | null) => (body ? new TextDecoder().decode(body) : null);
const header = (message: Sent, name: string) => message.headers.find(([key]) => key === name)?.[1];

describe("a request body of a contact's app, where the browser's Request has no body stream", () => {
  it("reaches the contact from a fetch POST", async () => {
    const { response, arrayBuffer } = send({ body: JSON.stringify({ hello: "ghost" }) });
    expect((await response).status).toBe(200);
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
    expect(sent()).toMatchObject({ method: "POST", path: "/api/echo" });
    expect(text(sent().body)).toBe('{"hello":"ghost"}');
  });

  it("reaches the contact from a form POST, urlencoded and multipart, a file in it", async () => {
    // The bodies as the browser encodes the forms (written out: the test DOM's FormData is not one `Request` encodes).
    const { response } = send({ navigate: true, path: "/save", body: "a=1&b=two+words", type: "application/x-www-form-urlencoded" });
    expect((await response).status).toBe(200);
    expect(sent()).toMatchObject({ method: "POST", path: "/save" });
    expect(text(sent().body)).toBe("a=1&b=two+words");
    expect(header(sent(), "content-type")).toBe("application/x-www-form-urlencoded");

    const boundary = "----formboundary7MA4YWxk";
    const form = [`--${boundary}`, 'Content-Disposition: form-data; name="note"', "", "hi",
      `--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="a.txt"', "Content-Type: text/plain", "", "file bytes",
      `--${boundary}--`, ""].join("\r\n");
    const upload = send({ navigate: true, path: "/upload", body: form, type: `multipart/form-data; boundary=${boundary}` });
    expect((await upload.response).status).toBe(200);
    const message = sent();
    expect(message).toMatchObject({ method: "POST", path: "/upload" });
    expect(header(message, "content-type")).toMatch(/^multipart\/form-data; boundary=/);
    // The contact reads the same form back from what it was handed.
    const back = await new Response(message.body, { headers: { "content-type": header(message, "content-type")! } }).formData();
    expect(back.get("note")).toBe("hi");
    expect(await (back.get("file") as File).text()).toBe("file bytes");
  });

  it("is none for a GET or a HEAD, unread, and for a POST that sends nothing, as where the stream is null", async () => {
    for (const method of ["GET", "HEAD"]) {
      const { response, arrayBuffer } = send({ method, path: "/page" });
      expect((await response).status).toBe(200);
      expect(arrayBuffer).not.toHaveBeenCalled();
      expect(sent()).toMatchObject({ method, path: "/page", body: null });
    }
    const empty = send({});
    expect((await empty.response).status).toBe(200);
    expect(sent()).toMatchObject({ method: "POST", body: null });
  });

  it("is refused unread past the limit when its declared length says so, as the stream's would be", async () => {
    const { response, arrayBuffer } = send({ body: new Uint8Array(MAX_REQUEST_BYTES + 1), length: MAX_REQUEST_BYTES + 1 });
    const refused = await response;
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(bridge.postMessage).not.toHaveBeenCalled();
    expect(refused.status).toBe(413);
    expect(await refused.text()).toBe("The request body is too large.");
  });

  it("is refused after reading past the limit when no length was declared: the same answer as the stream's", async () => {
    const { response, arrayBuffer } = send({ body: new Uint8Array(MAX_REQUEST_BYTES + 1) });
    const refused = await response;
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
    expect(bridge.postMessage).not.toHaveBeenCalled();
    // Chromium's way, the body as a stream, gives the very same refusal.
    const streamed = await send({ body: new Uint8Array(MAX_REQUEST_BYTES + 1), stream: true }).response;
    expect(bridge.postMessage).not.toHaveBeenCalled();
    for (const one of [refused, streamed]) {
      expect(one.status).toBe(413);
      expect(one.headers.get("content-type")).toBe(streamed.headers.get("content-type"));
      expect(await one.text()).toBe("The request body is too large.");
    }
  });

  it("goes whole at exactly the limit, its length declared or not", async () => {
    for (const length of [MAX_REQUEST_BYTES, undefined]) {
      const bytes = new Uint8Array(MAX_REQUEST_BYTES).fill(7);
      const { response } = send({ body: bytes, length });
      expect((await response).status, String(length)).toBe(200);
      const body = sent().body!;
      expect(body.byteLength, String(length)).toBe(MAX_REQUEST_BYTES);
      expect(new Uint8Array(body)[MAX_REQUEST_BYTES - 1]).toBe(7);
    }
  });
});
