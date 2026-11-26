import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuiltInAppOffer, InstalledAppView } from "@ghostly/browser/engine/apps";
import { Apps } from "../../pages/Apps";
import { InstalledAppDialog } from "../../components/apps/AppInstallDialog";
import { setAppOpener } from "../../lib/apps/open";
import { forgetAppsAvailable } from "../../lib/apps/flag";
import { forgetInstalledApps, installedApps, refreshInstalledApps } from "../../lib/apps/installed";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.page

vi.mock("../../lib/apps/runnerCheck", () => ({ runnerAvailable: vi.fn(async () => true), runnerPolicy: vi.fn(async () => true), forgetRunnerCheck: () => {}, isRunnerPolicy: () => true }));

/**
 * An uninstall, files fetched again or a built-in app removed reads the installed list once after it: the engine tells
 * every page it changed them (`apps-checked`, before it answers), and that read is the one awaited, not a second one.
 * An engine that tells nothing still gets the list read.
 */

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const installed = (n: number, extra: Partial<InstalledAppView> = {}): InstalledAppView => ({
  ref: `${KEY}/app${n}`, name: `app${n}`, publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", title: `App ${n}`, tagline: "An app",
  version: "1.0.0", sequence: 1, digest: "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4", permissions: ["chat"], view: "chat",
  from: "https://raw.githubusercontent.com/ana/app/HEAD/app.ghostlyapp", icon: false, installedAt: n, updatedAt: n,
  run: { status: "ok" }, listedBy: [], unknownPublisher: true, ...extra,
} as unknown as InstalledAppView);
const tell = () => fakeEngine.emit({ kind: "apps-checked" });

beforeEach(() => {
  forgetAppsAvailable();
  forgetInstalledApps();
  vi.stubEnv("VITE_APPS_TEST", "1");
  fakeEngine.appRunner = "/app-frame.html";
  setAppOpener(vi.fn(async () => {}));
});
afterEach(() => { vi.unstubAllEnvs(); setAppOpener(null); });

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });
const reads = () => [fakeEngine.callsTo("appList").length, fakeEngine.callsTo("appBuiltIns").length];

describe("the installed list read after a change", () => {
  it("Uninstall reads it once, the read the engine's tell asked", async () => {
    let list = [installed(1)];
    fakeEngine.on("appList", () => list).on("appBuiltIns", () => []).on("appUninstall", () => { list = []; tell(); });
    await refreshInstalledApps();
    const onClose = vi.fn();
    const { user } = renderApp(<InstalledAppDialog app={installed(1)} onClose={onClose} onOpen={() => {}} />);
    await settle();
    fakeEngine.calls.length = 0;
    await user.click(screen.getByTestId("app-uninstall-open"));
    await user.click(screen.getByTestId("app-uninstall-confirm"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    await settle();
    expect(reads()).toEqual([1, 1]);
    expect(installedApps()).toEqual([]);
  });

  it("Fetch files reads it once", async () => {
    let list = [installed(1, { run: { status: "needs-files" } } as Partial<InstalledAppView>)];
    fakeEngine.on("appList", () => list).on("appBuiltIns", () => []).on("appFetchFiles", () => { list = [installed(1)]; tell(); return { status: "ok" }; });
    await refreshInstalledApps();
    const { user } = renderApp(<InstalledAppDialog app={list[0]!} onClose={() => {}} onOpen={() => {}} />);
    await settle();
    fakeEngine.calls.length = 0;
    await user.click(screen.getByTestId("app-fetch-files"));
    await settle();
    expect(reads()).toEqual([1, 1]);
    expect(installedApps()?.[0]?.run.status).toBe("ok");
  });

  it("removing a built-in app reads it once", async () => {
    let offers = [{ ref: `${KEY}/chess`, title: "Chess", tagline: "Play", url: "https://raw.githubusercontent.com/x/y/HEAD/app.ghostlyapp" }] as unknown as BuiltInAppOffer[];
    fakeEngine.on("appList", () => []).on("appStoreList", () => []).on("appBuiltIns", () => offers).on("appCheckUpdates", () => { tell(); return []; })
      .on("appUninstall", () => { offers = []; tell(); });
    const { user } = renderApp(<Apps />, { route: "/apps" });
    await screen.findByTestId("built-in-app");
    await settle();
    fakeEngine.calls.length = 0;
    await user.click(screen.getByTestId("built-in-app-remove"));
    await user.click(screen.getByTestId("built-in-app-remove-confirm"));
    await waitFor(() => expect(screen.queryByTestId("built-in-app")).toBeNull());
    await settle();
    expect(reads()).toEqual([1, 1]);
  });

  it("an engine that tells nothing still has the list read after Uninstall", async () => {
    let list = [installed(1)];
    fakeEngine.on("appList", () => list).on("appBuiltIns", () => []).on("appUninstall", () => { list = []; });
    await refreshInstalledApps();
    const onClose = vi.fn();
    const { user } = renderApp(<InstalledAppDialog app={installed(1)} onClose={onClose} onOpen={() => {}} />);
    await settle();
    fakeEngine.calls.length = 0;
    await user.click(screen.getByTestId("app-uninstall-open"));
    await user.click(screen.getByTestId("app-uninstall-confirm"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(reads()).toEqual([1, 1]);
    expect(installedApps()).toEqual([]);
  });
});
