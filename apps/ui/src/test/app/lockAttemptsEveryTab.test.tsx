import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LockScreenProvider, useLockScreen } from "../../contexts/LockScreenContext";
import { renderApp } from "../render";

// covers: profiles.lock

/** The password check takes a while, as PBKDF2 does: tries made at once in several tabs overlap. */
const check = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../lib/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/settings")>()),
  needsRehash: () => false,
  verifyPassword: async (password: string) => {
    check.calls++;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return password === "right";
  },
}));

const ATTEMPTS_KEY = "ghostly_lock_attempts";
type Unlock = (password: string) => Promise<boolean>;

/** A tab of the app (the extension opens several), locked; gives back its `unlock`. */
function openTab(): Unlock {
  const tab: { unlock?: Unlock } = {};
  function Probe() {
    tab.unlock = useLockScreen().unlock;
    return null;
  }
  renderApp(<LockScreenProvider><Probe /></LockScreenProvider>);
  return (password) => tab.unlock!(password);
}

function stored(): { failures: number; retryAt: number } {
  return JSON.parse(localStorage.getItem(ATTEMPTS_KEY) ?? "null");
}

describe("wrong passwords tried in several tabs at once", () => {
  beforeEach(() => {
    check.calls = 0;
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: "x", timeoutMinutes: 5 } }));
    // Ten wrong tries already, and the wait after the last one just over.
    localStorage.setItem(ATTEMPTS_KEY, JSON.stringify({ failures: 10, retryAt: Date.now() - 1 }));
  });
  afterEach(() => { localStorage.clear(); sessionStorage.clear(); });

  it("checks one in the slot the wait allows, and counts it", async () => {
    const tabs = [openTab(), openTab(), openTab()];
    let results: boolean[] = [];
    await act(async () => { results = await Promise.all(tabs.map((unlock) => unlock("wrong"))); });
    expect(results).toEqual([false, false, false]);
    expect(check.calls).toBe(1);
    expect(stored().failures).toBe(11);
    expect(stored().retryAt).toBeGreaterThan(Date.now());
  });

  it("does not let the right password through in the slot a wrong one took", async () => {
    const tabs = [openTab(), openTab(), openTab()];
    let results: boolean[] = [];
    await act(async () => { results = await Promise.all([tabs[0]("wrong"), tabs[1]("wrong"), tabs[2]("right")]); });
    expect(results).toEqual([false, false, false]);
    expect(check.calls).toBe(1);
    expect(stored().failures).toBe(11);
  });

  it("takes its turn on a Web Lock where the browser has them", async () => {
    let queue = Promise.resolve();
    const names: string[] = [];
    const request = (name: string, run: () => Promise<unknown>) => {
      names.push(name);
      const turn = queue.then(run);
      queue = turn.then(() => {}, () => {});
      return turn;
    };
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
    try {
      const tabs = [openTab(), openTab(), openTab()];
      await act(async () => { await Promise.all(tabs.map((unlock) => unlock("wrong"))); });
      expect(names).toEqual(["ghostly-unlock", "ghostly-unlock", "ghostly-unlock"]);
      expect(check.calls).toBe(1);
      expect(stored().failures).toBe(11);
    } finally {
      delete (navigator as { locks?: unknown }).locks;
    }
  });

  it("still opens with the right password, and forgets the count", async () => {
    localStorage.setItem(ATTEMPTS_KEY, JSON.stringify({ failures: 1, retryAt: 0 }));
    const unlock = openTab();
    let opened = false;
    await act(async () => { opened = await unlock("right"); });
    expect(opened).toBe(true);
    expect(localStorage.getItem(ATTEMPTS_KEY)).toBeNull();
  });
});
