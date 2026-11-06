import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppStoreSummary, InstalledAppView } from "@ghostly/browser/engine/apps";
import { Apps } from "../../pages/Apps";
import { setAppOpener } from "../../lib/apps/open";
import { forgetAppsAvailable } from "../../lib/apps/flag";
import { forgetInstalledApps } from "../../lib/apps/installed";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.page

vi.mock("../../lib/apps/runnerCheck", () => ({ runnerAvailable: vi.fn(async () => true), runnerPolicy: vi.fn(async () => true), forgetRunnerCheck: () => {}, isRunnerPolicy: () => true }));

/**
 * Reading the installed apps or the stores can fail (storage: a private window, a full disk). The page says so, in the
 * person's language, with Try again: never "No apps yet." or "No stores yet.", which describe a new profile.
 */

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const app = {
  ref: `${KEY}/app1`, name: "app1", publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", title: "App 1", tagline: "An app",
  version: "1.0.0", sequence: 1, digest: "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4", permissions: ["chat"], view: "chat",
  from: "https://raw.githubusercontent.com/ana/app/HEAD/app.ghostlyapp", icon: false, installedAt: 1, updatedAt: 1,
  run: { status: "ok" }, listedBy: [], unknownPublisher: true,
} as unknown as InstalledAppView;
const store = {
  key: "s1", url: "https://raw.githubusercontent.com/ana/store/HEAD/store.json", name: "Ana's store", fingerprint: "yz7m oxuc bd4u 8aqt",
  apps: [], removed: [], fetchedAt: 1, preloaded: false, expired: false,
} as unknown as AppStoreSummary;
const STORAGE = "storage: The operation failed for reasons unrelated to the database itself";

let failing = true;
beforeEach(() => {
  failing = true;
  forgetAppsAvailable();
  forgetInstalledApps();
  vi.stubEnv("VITE_APPS_TEST", "1");
  fakeEngine.appRunner = "/app-frame.html";
  setAppOpener(vi.fn(async () => {}));
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36");
  fakeEngine
    .on("appList", () => { if (failing) throw new Error(STORAGE); return [app]; })
    .on("appStoreList", () => { if (failing) throw new Error(STORAGE); return [store]; })
    .on("appBuiltIns", () => [])
    .on("appCheckUpdates", () => []);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setAppOpener(null);
});

describe("the Apps page when its reads fail", () => {
  it("says the read failed, with the storage line, and no empty state", async () => {
    renderApp(<Apps />, { route: "/apps" });
    const apps = await screen.findByTestId("apps-installed-error");
    const stores = await screen.findByTestId("apps-stores-error");
    for (const block of [apps, stores]) {
      expect(block).toHaveTextContent("This browser can't keep apps here (private browsing?). Try a normal window.");
      expect(within(block).getByRole("alert")).toBeInTheDocument();
    }
    expect(screen.queryByTestId("apps-none")).toBeNull();
    expect(screen.queryByTestId("apps-no-stores")).toBeNull();
    expect(screen.queryByText("No apps yet.")).toBeNull();
    expect(screen.queryByText("No stores yet. Add one by its link.")).toBeNull();
    // The ⓘ tells the longer story.
    fireEvent.click(within(apps).getByTestId("apps-installed-error-line-info"));
    expect(within(apps).getByTestId("apps-installed-error-line-details")).toHaveTextContent("Ghostly keeps each app's files on this device.");
  });

  it("says it in the person's language", async () => {
    renderApp(<Apps />, { route: "/apps", language: "pt" });
    expect(await screen.findByTestId("apps-installed-error")).toHaveTextContent("Este navegador não consegue guardar apps aqui");
    expect(await screen.findByTestId("apps-stores-error")).toHaveTextContent("Este navegador não consegue guardar apps aqui");
    expect(screen.queryByText("Nenhum app ainda.")).toBeNull();
    expect(screen.queryByText("Nenhuma loja ainda. Adicione uma pelo link.")).toBeNull();
  });

  it("reads again on Try again, and shows what is there", async () => {
    renderApp(<Apps />, { route: "/apps" });
    const apps = await screen.findByTestId("apps-installed-error");
    const stores = await screen.findByTestId("apps-stores-error");
    failing = false;
    await act(async () => { fireEvent.click(within(apps).getByRole("button", { name: "Try again" })); });
    await act(async () => { fireEvent.click(within(stores).getByRole("button", { name: "Try again" })); });
    expect(await screen.findAllByTestId("installed-app")).toHaveLength(1);
    expect(await screen.findAllByTestId("app-store")).toHaveLength(1);
    expect(screen.queryByTestId("apps-installed-error")).toBeNull();
    expect(screen.queryByTestId("apps-stores-error")).toBeNull();
  });

  it("still says No apps yet. and No stores yet. when the reads found none", async () => {
    fakeEngine.on("appList", () => []).on("appStoreList", () => []);
    renderApp(<Apps />, { route: "/apps" });
    expect(await screen.findByTestId("apps-none")).toHaveTextContent("No apps yet.");
    expect(await screen.findByTestId("apps-no-stores")).toHaveTextContent("No stores yet. Add one by its link.");
    expect(screen.queryByTestId("apps-installed-error")).toBeNull();
    expect(screen.queryByTestId("apps-stores-error")).toBeNull();
  });
});
