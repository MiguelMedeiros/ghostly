import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopOpener, type DesktopOpenerOptions } from "../../lib/apps/desktopOpener";
import { memoryHost } from "../../lib/apps/memoryHost";
import { appsRunning, readingApps, stopRunningApps, stopTakenDown } from "../../lib/apps/open";
import { webOpener } from "../../lib/apps/webOpener";
import type { AppEntry } from "../../lib/platform";

// covers: apps.desktop-sandbox

// The installed apps are read again (an update check, an uninstall in another tab) while an Open is still on its way:
// the engine's `entry`, Rust's `app_open`, the web runner's check. Nothing is registered yet, so `stopTakenDown` stops
// nothing of it: the opener must not start a version that read found revoked, removed, or no longer installed.
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
const REVOKED = [{ ref: REF, digest: "d", run: { status: "revoked" } }];
const REMOVED = [{ ref: REF, digest: "d", run: { status: "removed", by: [{ name: "Main store" }] } }];
const UNINSTALLED: typeof REVOKED = [];
const FINE = [{ ref: REF, digest: "d", run: { status: "ok" } }];

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

describe("an app taken down or uninstalled while it opens (web)", () => {
  function web(entryHeld?: Promise<void>) {
    return webOpener({ apps: () => engine(entryHeld), nameIn: () => undefined, closeLabel: () => "Close" });
  }

  it("revoked while its files download: it never starts", async () => {
    const files = held();
    const opening = web(files.promise)(REF, null);
    stopTakenDown(REVOKED);
    files.release();
    await expect(opening).rejects.toThrow(/^revoked: /);
    expect(started).toEqual([]);
    expect(document.querySelector("[data-place=alone]")).toBeNull();
    expect(appsRunning()).toBe(false);
  });

  it("uninstalled (another tab) while the runner is checked: it never starts", async () => {
    const runner = held();
    runnerHeld = runner.promise;
    const { runnerPolicy } = await import("../../lib/apps/runnerCheck");
    vi.mocked(runnerPolicy).mockClear();
    const opening = web()(REF, null);
    await vi.waitFor(() => expect(runnerPolicy).toHaveBeenCalled());
    stopTakenDown(UNINSTALLED);
    runner.release();
    await expect(opening).rejects.toThrow(/^not-installed: /);
    expect(started).toEqual([]);
    expect(appsRunning()).toBe(false);
  });

  it("removed by a store while it opens: it never starts, unless the person chose Run anyway", async () => {
    const files = held();
    const opening = web(files.promise)(REF, null);
    stopTakenDown(REMOVED);
    files.release();
    await expect(opening).rejects.toThrow(/^removed: /);
    expect(started).toEqual([]);

    const again = held();
    const anyway = web(again.promise)(REF, null, { runAnyway: true });
    stopTakenDown(REMOVED);
    again.release();
    await anyway;
    expect(started).toEqual(["Notes"]);
  });

  it("a read asked before the open, that lands while it opens, is older than the engine's check: it starts", async () => {
    const at = readingApps();
    const files = held();
    const opening = web(files.promise)(REF, null);
    stopTakenDown(UNINSTALLED, at);
    files.release();
    await opening;
    expect(started).toEqual(["Notes"]);
  });

  it("found fine while it opens: it starts", async () => {
    const files = held();
    const opening = web(files.promise)(REF, null);
    stopTakenDown(FINE);
    files.release();
    await opening;
    expect(started).toEqual(["Notes"]);
    expect(appsRunning()).toBe(true);
  });
});

describe("an app taken down or uninstalled while it opens (Desktop)", () => {
  function desktop(windowHeld: Promise<void> = Promise.resolve()) {
    const calls: { command: string; args?: Record<string, unknown> }[] = [];
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command === "app_focused") return true;
      if (command === "app_open") { await windowHeld; return "app-1"; }
      return undefined;
    }) as unknown as DesktopOpenerOptions["invoke"];
    const open = desktopOpener({ apps: () => engine(), invoke, listen: async () => () => {}, nameIn: () => undefined, view: { theme: () => "light", locale: () => "en" }, startTimeoutMs: 60_000 });
    const did = (command: string) => calls.filter((c) => c.command === command);
    return { open, did };
  }

  it("revoked while its window is made: the window closes and the app never starts", async () => {
    const window = held();
    const { open, did } = desktop(window.promise);
    const opening = open(REF, null);
    await vi.waitFor(() => expect(did("app_open")).toHaveLength(1));
    stopTakenDown(REVOKED);
    window.release();
    await expect(opening).rejects.toThrow(/^revoked: /);
    expect(did("app_close").map((c) => c.args)).toEqual([{ label: "app-1" }]);
    expect(did("app_post")).toHaveLength(0);
    expect(appsRunning()).toBe(false);
    // Opened again: a new window, not the one that closed (the engine refuses a revoked one itself).
    await open(REF, null);
    expect(did("app_open")).toHaveLength(2);
  });

  it("uninstalled while its window is made: the window closes", async () => {
    const window = held();
    const { open, did } = desktop(window.promise);
    const opening = open(REF, null);
    await vi.waitFor(() => expect(did("app_open")).toHaveLength(1));
    stopTakenDown(UNINSTALLED);
    window.release();
    await expect(opening).rejects.toThrow(/^not-installed: /);
    expect(did("app_close")).toHaveLength(1);
    expect(appsRunning()).toBe(false);
  });
});
