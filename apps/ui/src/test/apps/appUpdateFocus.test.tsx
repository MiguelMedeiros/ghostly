import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledAppView } from "@ghostly/browser/engine/apps";
import { InstalledAppDialog } from "../../components/apps/AppInstallDialog";
import { forgetInstalledApps, refreshInstalledApps, useInstalledApps } from "../../lib/apps/installed";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.page

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const app: InstalledAppView = {
  ref: `${KEY}/chess`, name: "chess", publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", title: "Chess", tagline: "Play chess with a contact",
  version: "1.2.0", sequence: 7, digest: "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4", permissions: ["chat"], view: "chat",
  from: "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp", icon: false, installedAt: 1, updatedAt: 1,
  run: { status: "ok" }, listedBy: [], unknownPublisher: true,
};

/** The screen as the Apps page shows it: the app as the installed list has it now. */
function Shown() {
  const shown = useInstalledApps(true)?.find((a) => a.ref === app.ref);
  return shown ? <InstalledAppDialog app={shown} onClose={() => {}} onOpen={() => {}} /> : null;
}

beforeEach(() => { forgetInstalledApps(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("an installed app's waiting update, by keyboard", () => {
  it("keeps the focus in the screen once the update lands and its section goes, never on the page", async () => {
    let list: InstalledAppView[] = [{ ...app, pending: { sequence: 8, version: "1.3.0", added: ["name"] } }];
    const updated: InstalledAppView = { ...app, version: "1.3.0", sequence: 8, permissions: ["chat", "name"] };
    fakeEngine.on("appList", () => list).on("appUpdateAccept", () => { list = [updated]; return updated; });
    const { user } = renderApp(<Shown />);
    (await screen.findByTestId("app-update-accept")).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByTestId("app-update")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("app-details")).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });
});

/*
 * A check while the screen is open finds the app stopped (its publisher revoked it, a store removed it) or allowed
 * again: Open, or Run anyway and Keep stopped, go, and the focus one of them had stays in the screen, never on the page.
 */
describe("an installed app whose state changes while its screen has the focus", () => {
  const REMOVED: InstalledAppView["run"] = { status: "removed", by: [{ store: "k", name: "Ghostly", reason: "Sends your moves to a server", at: 1 }] };
  async function change(from: InstalledAppView["run"], to: InstalledAppView["run"], focus: string) {
    let list: InstalledAppView[] = [{ ...app, run: from }];
    fakeEngine.on("appList", () => list);
    renderApp(<><button type="button" data-testid="elsewhere">Elsewhere</button><Shown /></>);
    (await screen.findByTestId(focus)).focus();
    list = [{ ...app, run: to }];
    await act(() => refreshInstalledApps());
    expect(screen.queryByTestId(focus)).not.toBeInTheDocument();
  }

  it("revoked while Open has the focus: the screen takes it", async () => {
    await change({ status: "ok" }, { status: "revoked" }, "app-open");
    expect(screen.getByTestId("app-details")).toHaveFocus();
  });

  it("removed by a store while Open has the focus: the screen takes it", async () => {
    await change({ status: "ok" }, REMOVED, "app-open");
    expect(screen.getByTestId("app-details")).toHaveFocus();
  });

  it("listed again while Run anyway has the focus: the screen takes it", async () => {
    await change(REMOVED, { status: "ok" }, "app-run-anyway");
    expect(screen.getByTestId("app-details")).toHaveFocus();
  });

  it("the focus elsewhere is left where it is", async () => {
    let list: InstalledAppView[] = [app];
    fakeEngine.on("appList", () => list);
    renderApp(<><button type="button" data-testid="elsewhere">Elsewhere</button><Shown /></>);
    await screen.findByTestId("app-open");
    screen.getByTestId("elsewhere").focus();
    list = [{ ...app, run: { status: "revoked" } }];
    await act(() => refreshInstalledApps());
    expect(screen.getByTestId("elsewhere")).toHaveFocus();
  });
});

describe("an installed app's missing files, by keyboard", () => {
  it("gives the focus to Open once Fetch files brings them back and goes, never to the page", async () => {
    let list: InstalledAppView[] = [{ ...app, run: { status: "needs-files" } }];
    fakeEngine.on("appList", () => list).on("appFetchFiles", () => { list = [app]; return app.run; });
    const { user } = renderApp(<Shown />);
    (await screen.findByTestId("app-fetch-files")).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByTestId("app-fetch-files")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("app-open")).toHaveFocus());
  });
});
