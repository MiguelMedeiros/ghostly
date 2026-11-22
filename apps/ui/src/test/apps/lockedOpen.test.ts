import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopOpener, type DesktopOpenerOptions } from "../../lib/apps/desktopOpener";
import { memoryHost } from "../../lib/apps/memoryHost";
import { appsRunning, stopRunningApps } from "../../lib/apps/open";
import { webOpener } from "../../lib/apps/webOpener";
import type { AppEntry } from "../../lib/platform";

// covers: apps.desktop-sandbox

// The profile locks (the lock screen's `stopRunningApps`) while an Open is still on its way: the engine's `entry` (a
// needs-files app's bundle downloading), Rust's `app_open`, the web runner's check. Nothing is registered yet, so the
// lock stops nothing: the opener must not start the app once its waits end.
let runnerHeld: Promise<void> = Promise.resolve();
vi.mock("../../lib/apps/runnerCheck", () => ({ runnerAvailable: vi.fn(async () => true), runnerPolicy: vi.fn(async () => { await runnerHeld; return true; }), forgetRunnerCheck: () => {}, isRunnerPolicy: () => true }));
const started: string[] = [];
vi.mock("../../lib/apps/broker", async (actual) => ({
  ...(await actual<typeof import("../../lib/apps/broker")>()),
  startApp: ({ container, launch, onStop }: { container: HTMLElement; launch: { title: string }; onStop?: (reason: string) => void }) => {
    const frame = document.createElement("iframe");
    container.appendChild(frame);
    started.push(launch.title);
    let done = false;
    const stop = () => { if (done) return; done = true; frame.remove(); onStop?.("stopped"); };
    return { frame, phase: "running", stop };
  },
}));

const REF = "pubkeyalpha/notes";
const ENTRY = { ref: REF, digest: "d", version: "1.2.0", title: "Notes", permissions: ["chat"], entry: "<p>notes</p>" } satisfies AppEntry;

/** A wait the test ends when it says. */
function held() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function engine(entryHeld: Promise<void> = Promise.resolve()) {
  const host = memoryHost("ghostly-app://localhost/", "ghostly-app://localhost/");
  host.entry = async () => { await entryHeld; return ENTRY; };
  return host;
}

beforeEach(() => { started.length = 0; runnerHeld = Promise.resolve(); });
afterEach(() => {
  stopRunningApps();
  document.querySelectorAll("[data-place=alone]").forEach((node) => node.remove());
});

describe("an app opened just before the profile locks (Desktop)", () => {
  function desktop(entryHeld?: Promise<void>, windowHeld: Promise<void> = Promise.resolve()) {
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command === "app_focused") return true;
      if (command === "app_open") { await windowHeld; return "app-1"; }
      return undefined;
    }) as unknown as DesktopOpenerOptions["invoke"];
    const open = desktopOpener({ apps: () => engine(entryHeld), invoke, listen: async () => () => {}, nameIn: () => undefined, view: { theme: () => "light", locale: () => "en" }, startTimeoutMs: 60_000 });
    const did = (command: string) => calls.filter((c) => c.command === command);
    return { open, did };
  }

  it("locked while its files download: no window opens", async () => {
    const files = held();
    const { open, did } = desktop(files.promise);
    const opening = open(REF, null);
    stopRunningApps();
    files.release();
    await expect(opening).rejects.toThrow();
    expect(did("app_open")).toHaveLength(0);
    expect(appsRunning()).toBe(false);
  });

  it("locked while its window is made: the window closes and the app never starts", async () => {
    const window = held();
    const { open, did } = desktop(undefined, window.promise);
    const opening = open(REF, null);
    await vi.waitFor(() => expect(did("app_open")).toHaveLength(1));
    stopRunningApps();
    window.release();
    await expect(opening).rejects.toThrow();
    expect(did("app_close").map((c) => c.args)).toEqual([{ label: "app-1" }]);
    expect(did("app_post")).toHaveLength(0);
    expect(appsRunning()).toBe(false);
    // Opened again once unlocked: a new window, not the one that closed.
    await open(REF, null);
    expect(did("app_open")).toHaveLength(2);
    expect(appsRunning()).toBe(true);
  });

  it("not locked: it opens and runs", async () => {
    const { open, did } = desktop();
    await open(REF, null);
    expect(did("app_open")).toHaveLength(1);
    expect(did("app_close")).toHaveLength(0);
    expect(appsRunning()).toBe(true);
  });
});

describe("an app opened just before the profile locks (web)", () => {
  function web(entryHeld?: Promise<void>) {
    return webOpener({ apps: () => engine(entryHeld), nameIn: () => undefined, closeLabel: () => "Close" });
  }

  it("locked while its files download: it never starts", async () => {
    const files = held();
    const opening = web(files.promise)(REF, null);
    stopRunningApps();
    files.release();
    await expect(opening).rejects.toThrow();
    expect(started).toEqual([]);
    expect(document.querySelector("[data-place=alone]")).toBeNull();
    expect(appsRunning()).toBe(false);
  });

  it("locked while the runner is checked: it never starts", async () => {
    const runner = held();
    runnerHeld = runner.promise;
    const { runnerPolicy } = await import("../../lib/apps/runnerCheck");
    vi.mocked(runnerPolicy).mockClear();
    const opening = web()(REF, null);
    await vi.waitFor(() => expect(runnerPolicy).toHaveBeenCalled());
    stopRunningApps();
    runner.release();
    await expect(opening).rejects.toThrow();
    expect(started).toEqual([]);
    expect(document.querySelector("[data-place=alone]")).toBeNull();
    expect(appsRunning()).toBe(false);
  });

  it("not locked: it opens and runs", async () => {
    await web()(REF, null);
    expect(started).toEqual(["Notes"]);
    expect(document.querySelector("[data-place=alone]")).not.toBeNull();
    expect(appsRunning()).toBe(true);
  });
});
