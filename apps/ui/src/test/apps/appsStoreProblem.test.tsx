import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppStoreSummary } from "@ghostly/browser/engine/apps";
import { Apps } from "../../pages/Apps";
import { setAppOpener } from "../../lib/apps/open";
import { forgetAppsAvailable } from "../../lib/apps/flag";
import { forgetInstalledApps } from "../../lib/apps/installed";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.page

vi.mock("../../lib/apps/runnerCheck", () => ({ runnerAvailable: vi.fn(async () => true), runnerPolicy: vi.fn(async () => true), forgetRunnerCheck: () => {}, isRunnerPolicy: () => true }));

/**
 * A store whose last read failed says why (WISP 1200 § Stores): offline, a host that could not be reached or had a
 * problem of its own, another key, and a store that signed two lists under one number. A Refresh that fails says so.
 */

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const SEEN = Date.UTC(2026, 9, 3, 12);
const store = (problem: Partial<AppStoreSummary>): AppStoreSummary => ({
  key: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", url: "https://raw.githubusercontent.com/ana/store/HEAD/ghostly-store.json", preloaded: false,
  name: "Store off", kind: "curated", sequence: 4, expires: 4_000_000_000, expired: false, fetchedAt: 1, apps: [], removed: [], ...problem,
});

beforeEach(() => {
  forgetAppsAvailable();
  forgetInstalledApps();
  vi.stubEnv("VITE_APPS_TEST", "1");
  fakeEngine.appRunner = "/app-frame.html";
  setAppOpener(vi.fn(async () => {}));
  fakeEngine.on("appList", () => []).on("appBuiltIns", () => []).on("appCheckUpdates", () => []);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setAppOpener(null);
});

const problemLine = async (summary: AppStoreSummary, language?: "pt") => {
  fakeEngine.on("appStoreList", () => [summary]);
  renderApp(<Apps />, { route: "/apps", ...(language && { language }) });
  return (await screen.findByTestId("app-store-problem")).textContent;
};

describe("a store's last read that failed", () => {
  it.each([
    [{ problem: "offline" }, "You are offline."],
    [{ problem: "network" }, "Could not reach the host."],
    [{ problem: "status", problemStatus: 503 }, "The host had a problem (error 503). Try again later."],
    [{ problem: "status", problemStatus: 404 }, "Nothing found at that link."],
    [{ problem: "store-key" }, "That store is signed by a different key."],
    [{ problem: "not-json" }, "That link holds no valid store."],
    [{ problem: "rollback" }, "This store's link now holds an older list than yours. Ghostly kept yours."],
    [{ problem: "too-large" }, "This store's list is too large for Ghostly to read."],
  ])("says its cause: %o", async (problem, line) => {
    expect(await problemLine(store(problem))).toBe(line);
  });

  it("says that the store signed two lists, and when that was seen", async () => {
    const line = await problemLine(store({ problem: "equivocation", equivocation: { sequence: 5, at: SEEN } }));
    expect(line).toContain("signed two different lists");
    expect(line).toContain("Ghostly kept yours");
    expect(line).toContain("Oct 3, 2026");
  });

  it("still shows the two lists once the store's own list is read again", async () => {
    expect(await problemLine(store({ equivocation: { sequence: 5, at: SEEN } }))).toContain("signed two different lists");
  });

  it("says its cause in the app's language", async () => {
    expect(await problemLine(store({ problem: "offline" }), "pt")).toBe("Você está offline.");
  });

  it("says an older list in the store's words, in the app's language", async () => {
    expect(await problemLine(store({ problem: "rollback" }), "pt")).toBe("O link desta loja agora tem uma lista mais antiga que a sua. O Ghostly manteve a sua.");
  });

  it("says so when a Refresh fails again", async () => {
    const off = store({ problem: "offline" });
    fakeEngine.on("appStoreRefresh", () => [off]);
    await problemLine(off);
    const block = screen.getByTestId("app-store");
    await userEvent.click(within(block).getByTestId("app-store-refresh"));
    await waitFor(() => expect(fakeEngine.callsTo("appStoreRefresh")).toHaveLength(1));
    await act(async () => {});
    expect(await screen.findByTestId("toast-text")).toHaveTextContent("You are offline.");
  });
});
