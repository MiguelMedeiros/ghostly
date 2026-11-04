import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledAppView } from "@ghostly/browser/engine/apps";
import { InstalledAppDialog } from "../../components/apps/AppInstallDialog";
import { forgetInstalledApps, useInstalledApps } from "../../lib/apps/installed";
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
