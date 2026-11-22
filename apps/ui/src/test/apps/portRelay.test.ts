import { afterEach, describe, expect, it, vi } from "vitest";
import { STOP_REQUESTS_PER_SECOND } from "../../lib/apps/broker";
import { FLOODED, relayAppPort, type RelayStart } from "../../lib/apps/portRelay";
import { relayedChannel } from "../../lib/apps/relayedChannel";

// covers: apps.web-sandbox

/**
 * A running app's port is relayed by a worker that counts what the app sends on a thread of its own: where the frame
 * shares the page's thread (Firefox, WebKit), an app sending in a loop reaches the page a dozen messages a second and
 * the broker's own count never sees the flood. The e2e (e2e/web/apps-sandbox.spec.ts, "keeps sending far past the
 * request rate") runs it in the browsers; here the relay alone, on ports the test drives.
 */
interface FakePort {
  onmessage: ((event: { data: unknown }) => void) | null;
  onmessageerror: (() => void) | null;
  posted: { data: unknown; transfer?: Transferable[] }[];
  closed: boolean;
  postMessage(data: unknown, transfer?: Transferable[]): void;
  close(): void;
}

function fakePort(): FakePort {
  return {
    onmessage: null,
    onmessageerror: null,
    posted: [],
    closed: false,
    postMessage(data, transfer) { if (this.closed) return; this.posted.push({ data, transfer }); },
    close() { this.closed = true; },
  };
}

function relay(perSecond = 5) {
  const app = fakePort();
  const page = fakePort();
  const clock = { t: 1_000 };
  const flooded = vi.fn();
  relayAppPort({ app, page, perSecond } as unknown as RelayStart, flooded, () => clock.t);
  const send = (data: unknown) => app.onmessage!({ data });
  return { app, page, clock, flooded, send };
}

describe("relayAppPort", () => {
  it("passes what the app sends to the page, and the page's answers back, a buffer moved rather than copied", () => {
    const { app, page, send } = relay();
    send({ id: 1, type: "storage.get", args: ["k"] });
    expect(page.posted.map((p) => p.data)).toEqual([{ id: 1, type: "storage.get", args: ["k"] }]);
    const buffer = new ArrayBuffer(8);
    page.onmessage!({ data: { id: 1, ok: true, value: buffer } });
    page.onmessage!({ data: { event: "ping", data: 3 } });
    expect(app.posted).toEqual([{ data: { id: 1, ok: true, value: buffer }, transfer: [buffer] }, { data: { event: "ping", data: 3 }, transfer: [] }]);
  });

  it("closes both ports and says so past the limit in one second, before the page sees the message over it", () => {
    const { app, page, flooded, send } = relay(5);
    for (let i = 0; i < 5; i++) send({ junk: i });
    expect(flooded).not.toHaveBeenCalled();
    send({ junk: 5 });
    expect(flooded).toHaveBeenCalledOnce();
    expect(app.closed && page.closed).toBe(true);
    expect(page.posted).toHaveLength(5);
    // Nothing more is read or passed on, either way.
    send({ junk: 6 });
    page.onmessage!({ data: { event: "ping", data: 1 } });
    expect(page.posted).toHaveLength(5);
    expect(app.posted).toHaveLength(0);
    expect(flooded).toHaveBeenCalledOnce();
  });

  it("counts by the second, and counts what could not be read", () => {
    const { page, clock, flooded, send, app } = relay(5);
    for (let i = 0; i < 5; i++) send({ i });
    clock.t += 1_000;
    for (let i = 0; i < 5; i++) app.onmessageerror!();
    expect(page.posted.slice(5).map((p) => p.data)).toEqual([null, null, null, null, null]);
    expect(flooded).not.toHaveBeenCalled();
    app.onmessageerror!();
    expect(flooded).toHaveBeenCalledOnce();
  });
});

describe("relayedChannel", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("hands the ports to the worker once it runs, and stops the app on the worker's word", async () => {
    const workers: { posted: { data: unknown; transfer?: Transferable[] }[]; terminated: boolean; onmessage: ((event: MessageEvent) => void) | null }[] = [];
    vi.stubGlobal("Worker", class {
      posted: { data: unknown; transfer?: Transferable[] }[] = [];
      terminated = false;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() { workers.push(this); }
      postMessage(data: unknown, transfer?: Transferable[]) { this.posted.push({ data, transfer }); }
      terminate() { this.terminated = true; }
    });
    const flooded = vi.fn();
    const relay = relayedChannel(STOP_REQUESTS_PER_SECOND, flooded);
    const [worker] = workers;
    expect(worker!.posted).toEqual([]);
    worker!.onmessage!({ data: "ready" } as MessageEvent);
    const start = worker!.posted[0]!.data as RelayStart;
    expect(start.perSecond).toBe(STOP_REQUESTS_PER_SECOND);
    const [first, second] = worker!.posted[0]!.transfer!;
    expect(first === start.app && second === start.page).toBe(true);
    // The broker's end and the frame's are neither of the worker's.
    expect([start.app, start.page].some((port) => port === relay.port1 || port === relay.port2)).toBe(false);
    worker!.onmessage!({ data: FLOODED } as MessageEvent);
    expect(flooded).toHaveBeenCalledOnce();
    relay.end();
    expect(worker!.terminated).toBe(true);
  });

  it("relays on the page where no worker starts, and stops a flood there too", async () => {
    vi.stubGlobal("Worker", undefined);
    const flooded = vi.fn();
    const relay = relayedChannel(STOP_REQUESTS_PER_SECOND, flooded);
    const got: unknown[] = [];
    relay.port1.onmessage = (event) => got.push(event.data);
    relay.port2.postMessage({ id: 1, type: "storage.get", args: ["k"] });
    await vi.waitFor(() => expect(got).toEqual([{ id: 1, type: "storage.get", args: ["k"] }]));
    for (let i = 0; i < STOP_REQUESTS_PER_SECOND; i++) relay.port2.postMessage({ junk: i });
    await vi.waitFor(() => expect(flooded).toHaveBeenCalledOnce());
    expect(got.length).toBeLessThanOrEqual(STOP_REQUESTS_PER_SECOND);
    relay.end();
  });
});
