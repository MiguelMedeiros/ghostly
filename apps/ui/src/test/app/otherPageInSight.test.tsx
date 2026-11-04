import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionEvent } from "@ghostly/browser/shared/rpc";
import { AttentionFeedback } from "../../components/AttentionFeedback";
import { useIncomingCallNotice } from "../../hooks/useIncomingCallNotice";
import { appAway, refreshAppInSight, watchAppInSight } from "../../lib/appInSight";
import { loadSettings, saveSettings } from "../../lib/settings";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.attention.notifications, calls.ring-elsewhere, extension.engine

/*
 * The extension's tabs share one engine: a call rings, and a message comes, in each. A tab in the background posted a
 * system notification about them while the person had the call ringing, or the chat open, in the tab in front. A page
 * in sight holds a lock the others see now, and a page behind it tells nothing.
 */

/** The browser's Web Locks, enough of them: `held` is what every page holds, another page's added by hand. */
function installLocks(releaseMs = 0) {
  const held: { name: string; mode?: string }[] = [];
  const locks = {
    request: (name: string, options: { mode?: string } | (() => Promise<void>), run?: () => Promise<void>) => {
      const task = typeof options === "function" ? options : run!;
      const lock = { name, mode: typeof options === "function" ? "exclusive" : options.mode };
      held.push(lock);
      // `releaseMs`: the browser lists a lock let go a while longer.
      return Promise.resolve(task()).finally(() => new Promise((resolve) => setTimeout(resolve, releaseMs))).finally(() => held.splice(held.indexOf(lock), 1));
    },
    query: async () => ({ held: [...held] }),
  };
  Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
  return held;
}

/** Another page of this profile, in sight. */
const OTHER_PAGE = { name: "ghostly-in-sight:ghostly_:another-page", mode: "exclusive" };
const ownLock = { name: expect.stringMatching(/^ghostly-in-sight:ghostly_:/), mode: "exclusive" };
let visibility: DocumentVisibilityState = "visible";
let focused = true;
/** This page goes out of sight (`away`) or comes back, as the browser tells it. */
function page(away: boolean) {
  visibility = away ? "hidden" : "visible";
  focused = !away;
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
}

const created = vi.fn(async (id: string) => id);

beforeEach(() => {
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  visibility = "visible";
  focused = true;
  created.mockClear();
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { id: "ext", getURL: (path: string) => `chrome-extension://ext/${path}` },
    permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true) },
    notifications: { create: created, clear: vi.fn(async () => true), onClicked: { addListener() {} } },
  };
  saveSettings({ ...loadSettings(), notifications: { ...loadSettings().notifications, soundEnabled: false, systemEnabled: true } });
  watchAppInSight();
});
afterEach(async () => {
  // The page lets go of what it holds, so the next test starts holding nothing.
  visibility = "hidden";
  focused = false;
  refreshAppInSight();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
  delete (globalThis as { chrome?: unknown }).chrome;
  delete (navigator as { locks?: unknown }).locks;
  vi.restoreAllMocks();
});

describe("a page in sight", () => {
  it("holds the lock while it is in sight, and lets go once it is not", async () => {
    const held = installLocks();
    refreshAppInSight();
    await waitFor(() => expect(held).toEqual([ownLock]));
    expect(await appAway()).toBe(false);

    page(true);
    await waitFor(() => expect(held).toEqual([]));
    expect(await appAway()).toBe(true);

    page(false);
    await waitFor(() => expect(held).toHaveLength(1));
  });

  it("does not count its own lock while it is still being let go", async () => {
    const held = installLocks(50);
    refreshAppInSight();
    await waitFor(() => expect(held).toHaveLength(1));
    page(true);
    expect(held).toHaveLength(1);
    expect(await appAway()).toBe(true);
    // And another page's, beside it, still counts.
    held.push(OTHER_PAGE);
    expect(await appAway()).toBe(false);
    held.pop();
  });

  it("keeps a page behind it from saying it is away; without locks, the page alone decides", async () => {
    const held = installLocks();
    page(true);
    held.push(OTHER_PAGE);
    expect(await appAway()).toBe(false);
    // Another profile's page in sight (the web app, two tabs) is not this one's.
    held.splice(0, 1, { name: "ghostly-in-sight:ghostly_other_:a-page", mode: "exclusive" });
    expect(await appAway()).toBe(true);
    delete (navigator as { locks?: unknown }).locks;
    expect(await appAway()).toBe(true);
  });
});

describe("a page behind the one in sight", () => {
  it("posts no notification for the call ringing in both; once nothing is in sight it does", async () => {
    const held = installLocks();
    page(true);
    held.push(OTHER_PAGE);
    const ring = renderHook(({ ringing }) => useIncomingCallNotice(ringing, "chat-a", "Incoming call"), { initialProps: { ringing: true } });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(created).not.toHaveBeenCalled();
    ring.unmount();

    held.length = 0;
    renderHook(() => useIncomingCallNotice(true, "chat-a", "Incoming call"));
    await waitFor(() => expect(created).toHaveBeenCalledTimes(1));
  });

  it("posts no notification for a message the page in sight shows", async () => {
    const held = installLocks();
    page(true);
    held.push(OTHER_PAGE);
    renderApp(<AttentionFeedback />);
    const message = (id: string, linkId: string): AttentionEvent => ({ id, type: "message", at: Date.now(), linkId });
    act(() => { fakeEngine.emit({ kind: "attention", event: message("in-sight", "link-seen") }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(created).not.toHaveBeenCalled();

    held.length = 0;
    act(() => { fakeEngine.emit({ kind: "attention", event: message("nobody", "link-unseen") }); });
    await waitFor(() => expect(created).toHaveBeenCalledTimes(1));
  });
});

describe("no page in sight", () => {
  it("posts one notification for a call ringing in two, and one for its next ring", async () => {
    installLocks();
    page(true);
    // Two tabs out of sight, ringing for the same offer: each runs its own hook.
    const ring = (offer: number) => renderHook(() => useIncomingCallNotice(true, "chat-a", "Incoming call", offer));
    const tabs = [ring(1_000), ring(1_000)];
    await waitFor(() => expect(created).toHaveBeenCalledTimes(1));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(created).toHaveBeenCalledTimes(1);
    for (const tab of tabs) tab.unmount();

    // The caller calls again: a ring of its own, told once more.
    ring(2_000);
    ring(2_000);
    await waitFor(() => expect(created).toHaveBeenCalledTimes(2));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(created).toHaveBeenCalledTimes(2);
  });
});
