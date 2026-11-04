import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledAppView } from "@ghostly/browser/engine/apps";
import { Apps } from "../../pages/Apps";
import { setAppOpener } from "../../lib/apps/open";
import { forgetAppsAvailable } from "../../lib/apps/flag";
import { forgetInstalledApps } from "../../lib/apps/installed";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.page

// The runner page's header, asked once by the real check: answered here, never fetched in a test.
vi.mock("../../lib/apps/runnerCheck", () => ({ runnerAvailable: vi.fn(async () => true), runnerPolicy: vi.fn(async () => true), forgetRunnerCheck: () => {}, isRunnerPolicy: () => true }));

/**
 * The installed apps are read once as the Apps page opens and once after its update check. The engine says a check ran
 * (`apps-checked`, to every page, before it answers the page that asked), and the list is read again for that: the page
 * reads it no second time. Each read is a list of every app with its files looked for, drawn again wherever one shows.
 */

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const installed = (n: number): InstalledAppView => ({
  ref: `${KEY}/app${n}`, name: `app${n}`, publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", title: `App ${n}`, tagline: "An app",
  version: "1.0.0", sequence: 1, digest: "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4", permissions: ["chat"], view: "chat",
  from: "https://raw.githubusercontent.com/ana/app/HEAD/app.ghostlyapp", icon: false, installedAt: n, updatedAt: n,
  run: { status: "ok" }, listedBy: [], unknownPublisher: true,
} as unknown as InstalledAppView);

/** The engine's check: it reads the stores (a while), tells every page a check ran, then answers. */
const checkThatTells = async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  fakeEngine.emit({ kind: "apps-checked" });
  return [];
};

beforeEach(() => {
  forgetAppsAvailable();
  forgetInstalledApps();
  vi.stubEnv("VITE_APPS_TEST", "1");
  fakeEngine.appRunner = "/app-frame.html";
  setAppOpener(vi.fn(async () => {}));
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36");
  fakeEngine.on("appList", () => [installed(1), installed(2)]).on("appStoreList", () => []).on("appBuiltIns", () => []);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setAppOpener(null);
});

describe("the Apps page's reads of the installed apps", () => {
  it("reads them once as it opens and once after its update check", async () => {
    fakeEngine.on("appCheckUpdates", checkThatTells);
    renderApp(<Apps />, { route: "/apps" });
    expect(await screen.findAllByTestId("installed-app")).toHaveLength(2);
    await waitFor(() => expect(fakeEngine.callsTo("appCheckUpdates")).toHaveLength(1));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(fakeEngine.callsTo("appList")).toHaveLength(2);
    expect(fakeEngine.callsTo("appBuiltIns")).toHaveLength(2);
  });

  it("still shows what the check found when it ended before the first read answered", async () => {
    let found = false;
    let answer: () => void = () => {};
    fakeEngine.on("appList", () => {
      const list: InstalledAppView[] = found ? [installed(1), { ...installed(2), run: { status: "revoked" } }] : [installed(1), installed(2)];
      // The first read is slow: the check ends (and says so) before it answers.
      return fakeEngine.callsTo("appList").length === 1 ? new Promise<InstalledAppView[]>((resolve) => { answer = () => resolve(list); }) : list;
    }).on("appCheckUpdates", async () => { found = true; fakeEngine.emit({ kind: "apps-checked" }); return []; });
    renderApp(<Apps />, { route: "/apps" });
    await waitFor(() => expect(fakeEngine.callsTo("appList")).toHaveLength(2));
    await act(async () => { answer(); });
    const rows = await screen.findAllByTestId("installed-app");
    await waitFor(() => expect(rows[1]).toHaveTextContent("Stopped"));
    expect(fakeEngine.callsTo("appList")).toHaveLength(2);
  });
});
