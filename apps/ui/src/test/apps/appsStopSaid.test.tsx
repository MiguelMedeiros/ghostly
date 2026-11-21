import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledAppView } from "@ghostly/browser/engine/apps";
import { Apps } from "../../pages/Apps";
import { InstalledAppDialog } from "../../components/apps/AppInstallDialog";
import { setAppOpener } from "../../lib/apps/open";
import { forgetAppsAvailable } from "../../lib/apps/flag";
import { forgetInstalledApps, refreshInstalledApps, useInstalledApps } from "../../lib/apps/installed";
import { LOCALES as locales } from "../i18n/locales";
import { translateWith } from "../../locales/translate";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.page, apps.takedown

// The runner page's header, asked once by the real check: answered here, never fetched in a test.
vi.mock("../../lib/apps/runnerCheck", () => ({ runnerAvailable: vi.fn(async () => true), runnerPolicy: vi.fn(async () => true), forgetRunnerCheck: () => {}, isRunnerPolicy: () => true }));

/*
 * An update check or a store that stops an installed app (its publisher revoked it, a store removed it) changed the
 * Apps page's row to "Stopped" and took its Open away, and on the app's own screen took Open away and moved the focus
 * to the screen: nothing of it was a live region, and the screen was named by its title only, so a screen reader heard
 * "Chess, dialog" and nothing about why. Opening the screen of an app already stopped said no more.
 */

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const REASON = "It sent the board to a server";
const REVOKED: InstalledAppView["run"] = { status: "revoked", reason: REASON };
const REMOVED: InstalledAppView["run"] = { status: "removed", by: [{ store: "k", name: "Ghostly", reason: "Malware", at: 1 }] };
const SAID_REVOKED = `\u2068Chess\u2069 stopped. Its publisher revoked this version: \u2068${REASON}\u2069`;
const SAID_REMOVED = "\u2068Chess\u2069 stopped. Removed by \u2068Ghostly\u2069: \u2068Malware\u2069";

const app = (name: string, title: string, run: InstalledAppView["run"]): InstalledAppView => ({
  ref: `${KEY}/${name}`, name, publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", title, tagline: "Play with a contact",
  version: "1.2.0", sequence: 7, digest: "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4", permissions: ["chat"], view: "chat",
  from: "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp", icon: false, installedAt: 1, updatedAt: 1,
  run, listedBy: [], unknownPublisher: true,
});

beforeEach(() => {
  forgetAppsAvailable();
  forgetInstalledApps();
  vi.stubEnv("VITE_APPS_TEST", "1");
  fakeEngine.appRunner = "/app-frame.html";
  setAppOpener(vi.fn(async () => {}));
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36");
  fakeEngine.on("appStoreList", () => []).on("appBuiltIns", () => []).on("appCheckUpdates", () => []);
});
afterEach(() => {
  forgetInstalledApps();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setAppOpener(null);
});

describe("the Apps page, when a check stops an installed app", () => {
  /** The page with Chess running fine and Go already revoked when it opened; `stop` is what the next check finds. */
  async function page() {
    let chess: InstalledAppView["run"] = { status: "ok" };
    fakeEngine.on("appList", () => [app("chess", "Chess", chess), app("go", "Go", REVOKED)]);
    const view = renderApp(<Apps />, { route: "/apps" });
    expect(await screen.findByTestId("installed-app-open")).toBeInTheDocument();
    const said = screen.getByTestId("apps-stop-said");
    const stop = async (run: InstalledAppView["run"]) => {
      chess = run;
      await act(async () => { fakeEngine.emit({ kind: "apps-checked" }); });
      await waitFor(() => expect(screen.queryByTestId("installed-app-open")).not.toBeInTheDocument());
    };
    const allow = async () => {
      chess = { status: "ok" };
      await act(async () => { fakeEngine.emit({ kind: "apps-checked" }); });
      await waitFor(() => expect(screen.getByTestId("installed-app-open")).toBeInTheDocument());
    };
    return { ...view, said, stop, allow };
  }

  it("says the app stopped and why, politely, in a status there since the page opened", async () => {
    const { said, stop } = await page();
    expect(said).toHaveAttribute("role", "status");
    expect(said).toHaveAttribute("aria-live", "polite");
    // Go was already stopped as the page opened: nothing is said for it.
    expect(said).toBeEmptyDOMElement();
    await stop(REVOKED);
    expect(screen.getByTestId("apps-stop-said")).toBe(said);
    expect(said).toHaveTextContent(SAID_REVOKED);
    expect(said).not.toHaveTextContent("Go");
  });

  it("says a store's takedown with the store's own words", async () => {
    const { said, stop } = await page();
    await stop(REMOVED);
    expect(said).toHaveTextContent(SAID_REMOVED);
  });

  it("says it once: the next check, finding it still stopped, says nothing new", async () => {
    const { said, stop } = await page();
    await stop(REVOKED);
    const text = said.textContent;
    await act(async () => { fakeEngine.emit({ kind: "apps-checked" }); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(said.textContent).toBe(text);
  });

  it("says it again when the app, allowed to run again, stops a second time for the same reason", async () => {
    const { said, stop, allow } = await page();
    await stop(REMOVED);
    expect(said).toHaveTextContent(SAID_REMOVED);
    await allow();
    // Emptied as it may run again: the same words set again were no change, and nothing was said the second time.
    expect(said).toBeEmptyDOMElement();
    await stop(REMOVED);
    expect(said).toHaveTextContent(SAID_REMOVED);
  });

  it("says it again when the app, uninstalled and installed again, stops for the same reason", async () => {
    let list = [app("chess", "Chess", { status: "ok" })];
    fakeEngine.on("appList", () => list);
    renderApp(<Apps />, { route: "/apps" });
    expect(await screen.findByTestId("installed-app-open")).toBeInTheDocument();
    const said = screen.getByTestId("apps-stop-said");
    const check = async (next: InstalledAppView[]) => {
      list = next;
      await act(async () => { fakeEngine.emit({ kind: "apps-checked" }); });
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    };
    await check([app("chess", "Chess", REMOVED)]);
    expect(said).toHaveTextContent(SAID_REMOVED);
    await check([]);
    expect(said).toBeEmptyDOMElement();
    await check([app("chess", "Chess", { status: "ok" })]);
    await check([app("chess", "Chess", REMOVED)]);
    expect(said).toHaveTextContent(SAID_REMOVED);
  });

  it("leaves it to the app's own screen when that screen is open", async () => {
    const { said, user } = await page();
    await user.click(screen.getByRole("button", { name: /^Chess .*: details$/ }));
    const dialog = await screen.findByTestId("app-details");
    fakeEngine.on("appList", () => [app("chess", "Chess", REVOKED), app("go", "Go", REVOKED)]);
    await act(async () => { fakeEngine.emit({ kind: "apps-checked" }); });
    await waitFor(() => expect(within(dialog).getByTestId("app-stop-said")).toHaveTextContent(SAID_REVOKED));
    expect(said).toBeEmptyDOMElement();
  });
});

/** The screen as the Apps page shows it: the app as the installed list has it now. */
function Shown() {
  const shown = useInstalledApps(true)?.find((a) => a.name === "chess");
  return shown ? <InstalledAppDialog app={shown} onClose={() => {}} onOpen={() => {}} /> : null;
}

describe("an installed app's screen", () => {
  it.each([["revoked", REVOKED, SAID_REVOKED], ["removed", REMOVED, SAID_REMOVED]] as const)("open while a check finds it %s: says so politely, and is described by its run line", async (_, run, line) => {
    let list = [app("chess", "Chess", { status: "ok" })];
    fakeEngine.on("appList", () => list);
    renderApp(<Shown />);
    const dialog = await screen.findByTestId("app-details");
    const said = within(dialog).getByTestId("app-stop-said");
    expect(said).toHaveAttribute("role", "status");
    expect(said).toBeEmptyDOMElement();
    expect(dialog).not.toHaveAttribute("aria-describedby");
    list = [app("chess", "Chess", run)];
    await act(() => refreshInstalledApps());
    expect(within(dialog).getByTestId("app-stop-said")).toBe(said);
    expect(said).toHaveTextContent(line);
    const runLine = within(dialog).getByTestId("app-run-line");
    expect(runLine.id).not.toBe("");
    expect(dialog).toHaveAttribute("aria-describedby", runLine.id);
  });

  it("on its Uninstall question when a check finds it revoked: says so there too", async () => {
    let list = [app("chess", "Chess", { status: "ok" })];
    fakeEngine.on("appList", () => list);
    const { user } = renderApp(<Shown />);
    await screen.findByTestId("app-details");
    await user.click(screen.getByTestId("app-uninstall-open"));
    const question = await screen.findByTestId("app-uninstall");
    list = [app("chess", "Chess", REVOKED)];
    await act(() => refreshInstalledApps());
    expect(within(question).getByTestId("app-stop-said")).toHaveTextContent(SAID_REVOKED);
  });

  it("allowed to run again: never says a bare \"stopped\" on the way", async () => {
    let list = [app("chess", "Chess", { status: "ok" })];
    fakeEngine.on("appList", () => list);
    renderApp(<Shown />);
    const said = within(await screen.findByTestId("app-details")).getByTestId("app-stop-said");
    const heard: string[] = [];
    const watch = new MutationObserver(() => heard.push(said.textContent ?? ""));
    watch.observe(said, { childList: true, characterData: true, subtree: true });
    list = [app("chess", "Chess", REVOKED)];
    await act(() => refreshInstalledApps());
    list = [app("chess", "Chess", { status: "ok" })];
    await act(() => refreshInstalledApps());
    watch.disconnect();
    expect(heard.filter(Boolean)).toEqual([SAID_REVOKED]);
  });

  it("opened on an app already revoked: described by its run line, with nothing said on opening", async () => {
    renderApp(<InstalledAppDialog app={app("chess", "Chess", REVOKED)} onClose={() => {}} onOpen={() => {}} />);
    const dialog = await screen.findByTestId("app-details");
    const runLine = within(dialog).getByTestId("app-run-line");
    expect(runLine.id).not.toBe("");
    expect(dialog).toHaveAttribute("aria-describedby", runLine.id);
    expect(within(dialog).getByTestId("app-stop-said")).toBeEmptyDOMElement();
  });

  it("allowed to run again: the stop said goes, and the screen is described by nothing", async () => {
    let list = [app("chess", "Chess", { status: "ok" })];
    fakeEngine.on("appList", () => list);
    renderApp(<Shown />);
    const dialog = await screen.findByTestId("app-details");
    list = [app("chess", "Chess", REVOKED)];
    await act(() => refreshInstalledApps());
    list = [app("chess", "Chess", { status: "ok" })];
    await act(() => refreshInstalledApps());
    expect(within(dialog).getByTestId("app-stop-said")).toBeEmptyDOMElement();
    expect(dialog).not.toHaveAttribute("aria-describedby");
  });
});

describe("the stopped line", () => {
  it("has its own words in every language", () => {
    const en = translateWith(locales.en, "en");
    for (const lang of ["pt", "es", "fr", "it", "ja", "zh", "ar"] as const) {
      const t = translateWith(locales[lang], lang);
      expect(t("apps.app.stoppedSaid", { title: "Chess" }), lang).not.toBe(en("apps.app.stoppedSaid", { title: "Chess" }));
      expect(t("apps.app.stoppedSaid", { title: "Chess" }), lang).toContain("Chess");
    }
  });
});
