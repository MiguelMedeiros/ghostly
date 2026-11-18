import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppStoreSummary, BuiltInAppOffer, InstalledAppView } from "@ghostly/browser/engine/apps";
import type { AppListing } from "@ghostly/core";
import { Apps } from "../../pages/Apps";
import { setAppOpener } from "../../lib/apps/open";
import { forgetAppsAvailable } from "../../lib/apps/flag";
import { forgetInstalledApps } from "../../lib/apps/installed";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.page

vi.mock("../../lib/apps/runnerCheck", () => ({ runnerAvailable: vi.fn(async () => true), runnerPolicy: vi.fn(async () => true), forgetRunnerCheck: () => {}, isRunnerPolicy: () => true }));

/** Each installed or built-in app's row draws one icon of the default size (a store's listing, 32 px): rows drawn. */
const drawn = vi.hoisted(() => ({ rows: 0 }));
vi.mock("../../components/apps/AppIcon", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../components/apps/AppIcon")>();
  const AppIcon: typeof real.AppIcon = (props) => {
    if (props.size === undefined) drawn.rows++;
    return <real.AppIcon {...props} />;
  };
  return { ...real, AppIcon };
});

/**
 * The Apps page draws an installed or built-in app's row again only when that app changed: not for a toast showing or
 * closing, nor for the Add screen opening and closing, all of which are the page's own state.
 */

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const app = (n: number): InstalledAppView => ({
  ref: `${KEY}/app${n}`, name: `app${n}`, publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", title: `App ${n}`, tagline: "Play with a contact",
  version: "1.2.0", sequence: 7, digest: "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4", permissions: ["chat"], view: "chat",
  from: "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp", icon: false, installedAt: 1, updatedAt: 1,
  run: { status: "ok" }, listedBy: [], unknownPublisher: false,
});
const builtIn = (n: number): BuiltInAppOffer => ({
  ref: `${KEY}/built${n}`, publisher: KEY, name: `built${n}`, fingerprint: "yz7m oxuc bd4u 8aqt", digest: `b${n}`,
  url: `https://raw.githubusercontent.com/ana/built${n}/HEAD/app.ghostlyapp`, title: `Built ${n}`, tagline: "Comes with Ghostly",
});
const listing: AppListing = { ref: `ghostly:app/${KEY}/listed`, sequence: 1, digest: "d1", urls: [], title: "Listed", tagline: "" } as AppListing;
// A new object at each read, as the engine answers.
const store = (): AppStoreSummary => ({
  key: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", url: "https://raw.githubusercontent.com/ana/store/HEAD/ghostly-store.json", preloaded: false,
  name: "Store", kind: "curated", sequence: 4, expires: 4_000_000_000, expired: false, fetchedAt: 1, apps: [listing], removed: [],
});

const INSTALLED = 20, BUILT_INS = 2;
beforeEach(() => {
  forgetAppsAvailable();
  forgetInstalledApps();
  vi.stubEnv("VITE_APPS_TEST", "1");
  fakeEngine.appRunner = "/app-frame.html";
  setAppOpener(vi.fn(async () => {}));
  // The installed list read again comes as equal new objects, as the engine answers.
  fakeEngine.on("appList", () => Array.from({ length: INSTALLED }, (_, i) => app(i + 1)))
    .on("appBuiltIns", () => Array.from({ length: BUILT_INS }, (_, i) => builtIn(i + 1)))
    .on("appStoreList", () => [store()]).on("appCheckUpdates", () => [])
    .on("appStoreRefresh", () => [store()]);
});
afterEach(() => {
  forgetInstalledApps();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setAppOpener(null);
});

/** The page open with every row drawn and the update check's reads done, and the count zeroed. */
const opened = async () => {
  const view = renderApp(<Apps />, { route: "/apps" });
  await waitFor(() => expect(screen.getAllByTestId("installed-app")).toHaveLength(INSTALLED));
  await waitFor(() => expect(screen.getAllByTestId("built-in-app")).toHaveLength(BUILT_INS));
  await waitFor(() => expect(fakeEngine.callsTo("appStoreList")).toHaveLength(2));
  await act(async () => {});
  drawn.rows = 0;
  return view;
};

describe("the Apps page's installed and built-in app rows", () => {
  it("draws no row again for a Refresh's toast, nor when that toast closes", async () => {
    const { user } = await opened();
    await user.click(within(screen.getByTestId("app-store")).getByTestId("app-store-refresh"));
    expect(await screen.findByTestId("toast-text")).toHaveTextContent("Store");
    await act(async () => {});
    const shown = drawn.rows;
    drawn.rows = 0;
    await user.click(screen.getByTestId("toast-close"));
    await waitFor(() => expect(screen.queryByTestId("toast")).toBeNull());
    expect({ shown, closed: drawn.rows }).toEqual({ shown: 0, closed: 0 });
  });

  it("draws no row again when the Add screen opens and closes", async () => {
    const { user } = await opened();
    await user.click(screen.getByTestId("apps-add"));
    const dialog = await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(drawn.rows).toBe(0);
  });

  it("still opens the app a row's Open names", async () => {
    const opener = vi.fn(async () => {});
    setAppOpener(opener);
    const { user } = await opened();
    await user.click(within(screen.getAllByTestId("installed-app")[3]).getByTestId("installed-app-open"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveTextContent("App 4");
  });
});
