import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const page = vi.hoisted(() => ({ calls: 0 }));
// The detector's module as the page would load it: evaluating the real one blocks the page about half a second.
vi.mock("@qvac/langdetect-text", () => ({
  detectMultiple: () => { page.calls++; return [{ code: "page", probability: 1 }]; },
}));

// covers: app.i18n

/** A worker the test answers for. */
class FakeWorker extends EventTarget {
  static made: FakeWorker[] = [];
  static refuse = false;
  posted: { id: number; text: string }[] = [];
  terminated = false;
  constructor(readonly url: URL | string, readonly options?: WorkerOptions) {
    super();
    if (FakeWorker.refuse) throw new Error("no workers here");
    FakeWorker.made.push(this);
  }
  postMessage(message: { id: number; text: string }) { this.posted.push(message); }
  terminate() { this.terminated = true; }
  answer(id: number, code: string) { this.dispatchEvent(new MessageEvent("message", { data: { id, guesses: [{ code, probability: 0.9 }] } })); }
}

const load = async () => (await import("../../lib/translateDetector")).loadDetector;

beforeEach(() => {
  vi.resetModules();
  page.calls = 0;
  FakeWorker.made = [];
  FakeWorker.refuse = false;
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubEnv("VITE_TRANSLATE", "1");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("the language detector runs off the page", () => {
  it("in one worker for every caller, and the page detects nothing itself", async () => {
    const loadDetector = await load();
    const [one, two] = await Promise.all([loadDetector(), loadDetector()]);
    void one!("Olá, tudo bem?");
    void two!("Hello there");
    expect(FakeWorker.made).toHaveLength(1);
    expect(FakeWorker.made[0]!.options).toEqual({ type: "module" });
    expect(FakeWorker.made[0]!.posted.map((m) => m.text)).toEqual(["Olá, tudo bem?", "Hello there"]);
    expect(page.calls).toBe(0);
  });

  it("starts nothing in a build without translation", async () => {
    vi.stubEnv("VITE_TRANSLATE", "");
    expect(await (await load())()).toBeNull();
    expect(FakeWorker.made).toHaveLength(0);
  });

  it("gives each text its own answer, whichever comes first", async () => {
    const detect = (await (await load())())!;
    const first = detect("um");
    const second = detect("dois");
    const worker = FakeWorker.made[0]!;
    expect(worker.posted.map((m) => m.text)).toEqual(["um", "dois"]);
    worker.answer(worker.posted[1]!.id, "b");
    worker.answer(worker.posted[0]!.id, "a");
    await expect(first).resolves.toEqual([{ code: "a", probability: 0.9 }]);
    await expect(second).resolves.toEqual([{ code: "b", probability: 0.9 }]);
  });

  it("falls back to the page where no worker starts", async () => {
    FakeWorker.refuse = true;
    const detect = (await (await load())())!;
    expect(await detect("oi")).toMatchObject([{ code: "page" }]);
    expect(page.calls).toBe(1);
  });

  it("gives no guess for what a silent worker never answers", async () => {
    vi.useFakeTimers();
    try {
      const { DETECT_PATIENCE_MS, loadDetector } = await import("../../lib/translateDetector");
      const detect = (await loadDetector())!;
      const waiting = detect("oi");
      await vi.advanceTimersByTimeAsync(DETECT_PATIENCE_MS);
      await expect(waiting).resolves.toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it("answers on the page what a worker that failed had not, and asks it nothing more", async () => {
    const detect = (await (await load())())!;
    const waiting = detect("oi");
    const worker = FakeWorker.made[0]!;
    worker.dispatchEvent(new Event("error"));
    await expect(waiting).resolves.toMatchObject([{ code: "page" }]);
    expect(worker.terminated).toBe(true);
    await expect(detect("de novo")).resolves.toMatchObject([{ code: "page" }]);
    expect(worker.posted).toHaveLength(1);
  });
});
