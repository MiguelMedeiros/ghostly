import { act, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledAppView } from "@ghostly/browser/engine/apps";
import { Apps } from "../../pages/Apps";
import { forgetAppsAvailable } from "../../lib/apps/flag";
import { forgetInstalledApps, refreshInstalledApps } from "../../lib/apps/installed";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.page

/*
 * A store's listing whose Install goes while it has the focus: the update check the page runs as it opens finds the
 * store took it down, or another tab installed it. The focus goes to the listing, which now says why, not to the page;
 * never taken from where the person went meanwhile.
 */

vi.mock("../../lib/apps/runnerCheck", () => ({ runnerAvailable: vi.fn(async () => true), runnerPolicy: vi.fn(async () => true), forgetRunnerCheck: () => {}, isRunnerPolicy: () => true }));

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const REF = `${KEY}/chess`;
const DIGEST = "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4";
const URL_ = "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp";

let takenDown: boolean;
let installedHere: boolean;
const store = () => ({ key: "s", fingerprint: "abcd efgh ijkl mnop", url: "https://raw.githubusercontent.com/g/s/HEAD/ghostly-store.json", preloaded: false,
  name: "Ghostly", kind: "curated" as const, sequence: 1, expires: 2_000_000_000, expired: false, fetchedAt: 1,
  apps: [{ ref: REF, sequence: 7, digest: DIGEST, urls: [URL_], title: "Chess", tagline: "Play chess with a contact" }],
  removed: takenDown ? [{ ref: REF, digest: DIGEST, reason: "Malware", at: 1 }] : [] });
const installed = (): InstalledAppView => ({
  ref: REF, name: "chess", publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", title: "Chess", tagline: "Play chess", version: "1.2.0",
  sequence: 7, digest: DIGEST, permissions: ["chat"], view: "chat", from: URL_, icon: false, installedAt: 1, updatedAt: 1,
  run: { status: "ok" }, listedBy: [], unknownPublisher: false,
});
let checked: () => void;

beforeEach(() => {
  forgetAppsAvailable();
  forgetInstalledApps();
  vi.stubEnv("VITE_APPS_TEST", "1");
  fakeEngine.appRunner = "/app-frame.html";
  takenDown = false;
  installedHere = false;
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36");
  fakeEngine.on("appList", () => (installedHere ? [installed()] : [])).on("appStoreList", () => [store()]).on("appBuiltIns", () => [])
    .on("appCheckUpdates", () => new Promise((done) => { checked = () => done([]); }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  forgetAppsAvailable();
  forgetInstalledApps();
});

describe("a store listing whose Install goes while it has the focus", () => {
  async function focused(on: "install" | "elsewhere") {
    renderApp(<><button type="button" data-testid="elsewhere">Elsewhere</button><Apps /></>, { route: "/apps" });
    const listing = await screen.findByTestId("app-listing");
    (on === "install" ? within(listing).getByTestId("app-listing-install") : screen.getByTestId("elsewhere")).focus();
    return listing;
  }

  it("taken down by the store, found by the page's update check: the listing, saying why, takes the focus", async () => {
    const listing = await focused("install");
    takenDown = true;
    await act(async () => { checked(); });
    expect(await within(listing).findByTestId("app-listing-removed")).toHaveTextContent(/Malware/);
    expect(within(listing).queryByTestId("app-listing-install")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(listing);
  });

  it("installed in another tab: the listing, saying Installed, takes the focus", async () => {
    const listing = await focused("install");
    installedHere = true;
    await act(() => refreshInstalledApps());
    expect(within(listing).queryByTestId("app-listing-install")).not.toBeInTheDocument();
    expect(listing).toHaveTextContent(/Installed/);
    expect(document.activeElement).toBe(listing);
  });

  it("the focus elsewhere is left where it is", async () => {
    await focused("elsewhere");
    takenDown = true;
    await act(async () => { checked(); });
    await screen.findByTestId("app-listing-removed");
    expect(document.activeElement).toBe(screen.getByTestId("elsewhere"));
  });
});
