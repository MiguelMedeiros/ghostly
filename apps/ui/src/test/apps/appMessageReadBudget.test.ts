import { afterEach, describe, expect, it, vi } from "vitest";
import { OVER_BUDGET, READ_MS_PER_SECOND, readWithin, startApp, type AppStopReason, type RunningApp } from "../../lib/apps/broker";
import { memoryHost } from "../../lib/apps/memoryHost";

/**
 * The page reads each of a running app's messages (`event.data`, a structured clone) on its own thread before the
 * broker checks anything, so an app posting large or object-heavy values could hold the page for seconds while staying
 * under the rate stop and the watchdog. Past `READ_MS_PER_SECOND` of reading in one second the app is stopped.
 */
describe("the time the page spends reading an app's messages", () => {
  let running: RunningApp | null = null;
  afterEach(() => {
    running?.stop();
    running = null;
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("a reader answers OVER_BUDGET past the budget in one second, and forgets reads older than a second", () => {
    const clock = { t: 0 };
    const reading = readWithin(200, () => clock.t);
    const slow = (ms: number, value: unknown) => () => { clock.t += ms; return value; };
    expect(reading(slow(150, "a"))).toBe("a");
    clock.t += 1000;
    expect(reading(slow(150, "b"))).toBe("b");
    expect(reading(slow(40, "c"))).toBe("c");
    expect(reading(slow(20, "d"))).toBe(OVER_BUDGET);
  });

  /** A running app, the runner's end of its port, and the page's end, whose messages the test hands in itself. */
  async function runningApp(stops: AppStopReason[]) {
    const channels: MessageChannel[] = [];
    const Real = MessageChannel;
    vi.stubGlobal("MessageChannel", class extends Real { constructor() { super(); channels.push(this); } });
    const container = document.createElement("div");
    document.body.appendChild(container);
    running = startApp({
      container, host: memoryHost(), view: { theme: () => "dark", locale: () => "en" },
      launch: { ref: "pubkeyalpha/chess", digest: "d", version: "1.0.0", title: "Chess", permissions: [], entry: "<p>app</p>", chat: null },
      onStop: (reason) => stops.push(reason),
    });
    const { frame } = running;
    let runner: MessagePort | null = null;
    const runnerWindow = { postMessage: (_message: unknown, _origin: string, transfer?: Transferable[]) => { runner = transfer?.[0] as MessagePort; } };
    vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockReturnValue(runnerWindow as unknown as Window);
    frame.dispatchEvent(new Event("load"));
    const answers: Record<string, unknown>[] = [];
    runner!.onmessage = (event) => answers.push(event.data as Record<string, unknown>);
    runner!.postMessage({ id: 0, type: "writing", args: [] });
    await vi.waitFor(() => expect(answers).toContainEqual({ id: 0, ok: true }));
    frame.dispatchEvent(new Event("load"));
    expect(running.phase).toBe("running");
    const page = channels[0]!.port1;
    return { answers, page };
  }

  it("stops an app whose messages take the page more than the budget to read in one second", async () => {
    const stops: AppStopReason[] = [];
    const { page } = await runningApp(stops);
    let t = 0;
    vi.spyOn(performance, "now").mockImplementation(() => t);
    // Each message costs the page 30 ms to clone, well within the rate and far short of the watchdog.
    const heavy = (id: number) => ({ get data() { t += 30; return { id, type: "storage.keys", args: [] }; } }) as MessageEvent;
    const reads = Math.floor(READ_MS_PER_SECOND / 30) + 1;
    for (let id = 1; id <= reads; id++) page.onmessage!(heavy(id));
    expect(stops).toEqual(["protocol"]);
    expect(running!.phase).toBe("stopped");
  });

  it("keeps an app whose messages are quick to read running", async () => {
    const stops: AppStopReason[] = [];
    const { page, answers } = await runningApp(stops);
    let t = 0;
    vi.spyOn(performance, "now").mockImplementation(() => t);
    const light = (id: number) => ({ get data() { t += 0.5; return { id, type: "storage.keys", args: [] }; } }) as MessageEvent;
    for (let id = 1; id <= 20; id++) page.onmessage!(light(id));
    await vi.waitFor(() => expect(answers).toContainEqual(expect.objectContaining({ id: 20, ok: true })));
    expect(stops).toEqual([]);
    expect(running!.phase).toBe("running");
  });
});
