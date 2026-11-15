import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppStoreSummary } from "@ghostly/browser/engine/apps";
import type { AppListing } from "@ghostly/core";
import { Apps } from "../../pages/Apps";
import { setAppOpener } from "../../lib/apps/open";
import { forgetAppsAvailable } from "../../lib/apps/flag";
import { forgetInstalledApps } from "../../lib/apps/installed";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.page

vi.mock("../../lib/apps/runnerCheck", () => ({ runnerAvailable: vi.fn(async () => true), runnerPolicy: vi.fn(async () => true), forgetRunnerCheck: () => {}, isRunnerPolicy: () => true }));

/** Each store listing row draws one 32 px icon: how many rows were drawn since the count was last zeroed. */
const drawn = vi.hoisted(() => ({ rows: 0 }));
vi.mock("../../components/apps/AppIcon", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../components/apps/AppIcon")>();
  const AppIcon: typeof real.AppIcon = (props) => {
    if (props.size === 32) drawn.rows++;
    return <real.AppIcon {...props} />;
  };
  return { ...real, AppIcon };
});

/**
 * The Apps page draws a store's listing rows again only when that store's list changed: not when the update check
 * reads the stores again and they read as before, not for a Refresh's card or its closing, not for another store.
 */

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiego";
const listing = (store: number, n: number): AppListing => ({ ref: `ghostly:app/${KEY}${store}/app${n}`, sequence: 1, digest: `d${n}`, urls: [], title: `App ${store}.${n}`, tagline: "" } as AppListing);
// A new object at each read, as the engine answers: equal, never the same.
const store = (n: number, listings: number): AppStoreSummary => ({
  key: `${KEY}${n}`, fingerprint: "yz7m oxuc bd4u 8aqt", url: `https://raw.githubusercontent.com/ana/store${n}/HEAD/ghostly-store.json`, preloaded: false,
  name: `Store ${n}`, kind: "curated", sequence: 4, expires: 4_000_000_000, expired: false, fetchedAt: 1,
  apps: Array.from({ length: listings }, (_, i) => listing(n, i + 1)), removed: [],
});
// Two stores open by themselves (a few listings each: 5 + 4 rows), one closed (60 listings).
let sizes: [number, number, number];
const stores = () => sizes.map((size, i) => store(i + 1, size));

let checked: () => void;
beforeEach(() => {
  forgetAppsAvailable();
  forgetInstalledApps();
  vi.stubEnv("VITE_APPS_TEST", "1");
  fakeEngine.appRunner = "/app-frame.html";
  setAppOpener(vi.fn(async () => {}));
  sizes = [5, 4, 60];
  checked = () => {};
  fakeEngine.on("appList", () => []).on("appBuiltIns", () => []).on("appStoreList", () => stores())
    .on("appCheckUpdates", () => new Promise((resolve) => { checked = () => resolve([]); }))
    .on("appStoreRefresh", (params: { key?: string } | undefined) => stores().filter((s) => s.key === params?.key));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setAppOpener(null);
});

/** The page open with its 9 rows drawn, and the count zeroed. */
const opened = async () => {
  const view = renderApp(<Apps />, { route: "/apps" });
  await waitFor(() => expect(screen.getAllByTestId("app-listing")).toHaveLength(9));
  await act(async () => {});
  drawn.rows = 0;
  return view;
};

/** The update check ends, and the stores it reads again are drawn. */
const checkEnds = async () => {
  await act(async () => { checked(); });
  await waitFor(() => expect(fakeEngine.callsTo("appStoreList")).toHaveLength(2));
  await act(async () => {});
};

describe("the Apps page's store listing rows", () => {
  it("draws no row again when the update check ends with the stores as they were", async () => {
    await opened();
    await checkEnds();
    expect(drawn.rows).toBe(0);
    expect(screen.getAllByTestId("app-listing")).toHaveLength(9);
  });

  it("draws no row again for a Refresh's card, nor when that card closes", async () => {
    const { user } = await opened();
    await checkEnds();
    drawn.rows = 0;
    const closed = screen.getAllByTestId("app-store")[2];
    await user.click(within(closed).getByTestId("app-store-refresh"));
    expect(await screen.findByTestId("toast-text")).toHaveTextContent("Store 3");
    await waitFor(() => expect(fakeEngine.callsTo("appStoreList")).toHaveLength(3));
    await act(async () => {});
    const card = drawn.rows;
    drawn.rows = 0;
    await user.click(screen.getByTestId("toast-close"));
    await waitFor(() => expect(screen.queryByTestId("toast")).toBeNull());
    expect({ card, closed: drawn.rows }).toEqual({ card: 0, closed: 0 });
    expect(screen.getAllByTestId("app-listing")).toHaveLength(9);
  });

  it("draws again only the rows of the store whose list changed", async () => {
    await opened();
    sizes = [5, 5, 60];
    await checkEnds();
    expect(within(screen.getAllByTestId("app-store")[1]).getAllByTestId("app-listing")).toHaveLength(5);
    expect(drawn.rows).toBe(5);
  });

  it("draws only the listings a Show more adds, not the ones shown already", async () => {
    const { user } = await opened();
    await checkEnds();
    const big = screen.getAllByTestId("app-store")[2];
    await user.click(within(big).getByRole("button", { expanded: false }));
    expect(within(big).getAllByTestId("app-listing")).toHaveLength(50);
    drawn.rows = 0;
    await user.click(within(big).getByTestId("app-store-more"));
    expect(within(big).getAllByTestId("app-listing")).toHaveLength(60);
    expect(drawn.rows).toBe(10);
  });
});
