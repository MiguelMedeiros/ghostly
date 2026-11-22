import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LockScreenProvider, useLockScreen } from "../../contexts/LockScreenContext";
import { handOverUnlock } from "../../lib/lockHandover";
import { activeProfileId } from "../../lib/profiles";
import { createBroker, startApp } from "../../lib/apps/broker";
import { appInput, onAppInput } from "../../lib/apps/open";
import { memoryHost } from "../../lib/apps/memoryHost";
import { renderApp } from "../render";

// covers: settings.lock.idle

/**
 * A person playing a mini-app is using Ghostly: their taps and keys in the app's frame (web) or window (Desktop) never
 * reach the Ghostly page, so the runner says `activity` and the lock counts it, but only while the app has the focus.
 * Leaving the app (another window, another page) lets the lock come as before.
 */
const MINUTE = 60_000;

function brokerWith(inUse: () => boolean | Promise<boolean>) {
  const posted: Record<string, unknown>[] = [];
  const onInput = vi.fn();
  const broker = createBroker({
    host: memoryHost(),
    launch: { ref: "pubkeyalpha/chess", digest: "d", version: "1.0.0", title: "Chess", permissions: [], entry: "<p>app</p>", chat: null },
    view: { theme: () => "dark", locale: () => "en" },
    post: (message) => posted.push(message as Record<string, unknown>),
    stopped: () => {},
    inUse,
    onInput,
  });
  broker.load();
  broker.message({ id: 0, type: "writing", args: [] });
  broker.load();
  return { broker, posted, onInput };
}

describe("the runner's `activity`", () => {
  it("is the person's input while the app has the focus, and is answered", async () => {
    const { broker, posted, onInput } = brokerWith(() => true);
    broker.message({ id: 1, type: "activity", args: [] });
    await vi.waitFor(() => expect(onInput).toHaveBeenCalledOnce());
    expect(posted).toContainEqual({ id: 1, ok: true });
  });

  it("counts for nothing from an app the person is not in, and is answered the same", async () => {
    const { broker, posted, onInput } = brokerWith(async () => false);
    broker.message({ id: 1, type: "activity", args: [] });
    await vi.waitFor(() => expect(posted).toContainEqual({ id: 1, ok: true }));
    await Promise.resolve();
    expect(onInput).not.toHaveBeenCalled();
  });
});

/**
 * On the web, the app runs in the runner's realm and can post `activity` itself, with no one there: left in front, it
 * would keep the lock away for good. A tap or key in the frame activates the page around it too (HTML § user
 * activation), which no script can do, so only an `activity` that comes with the page's transient activation counts.
 */
describe("the runner's `activity` on the web", () => {
  const isActive = { value: false };
  let running: ReturnType<typeof startApp> | null = null;
  beforeEach(() => {
    Object.defineProperty(navigator, "userActivation", { configurable: true, get: () => ({ isActive: isActive.value, hasBeenActive: true }) });
  });
  afterEach(() => {
    running?.stop();
    running = null;
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, "userActivation");
  });

  /** A running app in a frame the person is in (focused, in a focused page), and the runner's end of its port. */
  async function inApp() {
    const container = document.createElement("div");
    document.body.appendChild(container);
    running = startApp({
      container, host: memoryHost(), view: { theme: () => "dark", locale: () => "en" },
      launch: { ref: "pubkeyalpha/chess", digest: "d", version: "1.0.0", title: "Chess", permissions: [], entry: "<p>app</p>", chat: null },
    });
    const { frame } = running;
    // happy-dom loads no frame: the runner's window only takes the port it is handed.
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
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "activeElement", "get").mockReturnValue(frame);
    return { runner: runner!, answers };
  }

  it("counts with the person's tap or key: the page around the frame is active", async () => {
    const { runner, answers } = await inApp();
    const input = vi.fn();
    const stop = onAppInput(input);
    isActive.value = true;
    runner.postMessage({ id: 1, type: "activity", args: [] });
    await vi.waitFor(() => expect(input).toHaveBeenCalledOnce());
    expect(answers).toContainEqual({ id: 1, ok: true });
    stop();
  });

  it("counts for nothing when the app says it by itself, and is answered the same", async () => {
    const { runner, answers } = await inApp();
    const input = vi.fn();
    const stop = onAppInput(input);
    isActive.value = false;
    runner.postMessage({ id: 1, type: "activity", args: [] });
    await vi.waitFor(() => expect(answers).toContainEqual({ id: 1, ok: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(input).not.toHaveBeenCalled();
    stop();
  });
});

function Probe() {
  const { isLocked } = useLockScreen();
  return <p data-testid="locked">{String(isLocked)}</p>;
}

const locked = () => screen.getByTestId("locked").textContent;
const awake = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe("the lock, with an app in use", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: "x", timeoutMinutes: 1 } }));
    handOverUnlock(activeProfileId(), "x");
    renderApp(<LockScreenProvider><Probe /></LockScreenProvider>);
    expect(locked()).toBe("false");
  });
  afterEach(() => { vi.useRealTimers(); localStorage.clear(); sessionStorage.clear(); });

  it("input in the app starts the time again: a game longer than the lock time goes on", () => {
    for (let i = 0; i < 5; i++) {
      awake(50_000);
      act(() => { appInput(); });
    }
    expect(locked()).toBe("false");
    awake(MINUTE);
    expect(locked()).toBe("true");
  });

  it("the first input in the app after the time is up locks, and does not start the time again", () => {
    vi.setSystemTime(Date.now() + 2 * MINUTE);
    act(() => { appInput(); });
    expect(locked()).toBe("true");
  });
});
