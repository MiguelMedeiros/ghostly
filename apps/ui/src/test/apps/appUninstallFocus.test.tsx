import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstalledAppView } from "@ghostly/browser/engine/apps";
import { InstalledAppDialog } from "../../components/apps/AppInstallDialog";
import { forgetInstalledApps } from "../../lib/apps/installed";
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

afterEach(() => { forgetInstalledApps(); vi.restoreAllMocks(); });

describe("an installed app's Uninstall question, by keyboard", () => {
  it("has the focus on its Cancel once Uninstall is pressed, and Cancel gives it back to Uninstall, never to the page", async () => {
    const { user } = renderApp(<InstalledAppDialog app={app} onClose={() => {}} onOpen={() => {}} />);
    screen.getByTestId("app-uninstall-open").focus();
    await user.keyboard("{Enter}");
    const question = screen.getByTestId("app-uninstall");
    // The question's safe way out has it: Enter again does not uninstall.
    expect(within(question).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("app-details")).toBeInTheDocument();
    expect(screen.getByTestId("app-uninstall-open")).toHaveFocus();
  });
});

describe("an installed app's Uninstall, in red", () => {
  it("is written in danger's ink, which reads at 4.5:1 on the details' surface at rest and hovered, in every theme", () => {
    renderApp(<InstalledAppDialog app={app} onClose={() => {}} onOpen={() => {}} />);
    // Danger's own red read 4.44:1 on Monochrome dark's #1a1a1a, and 4.04:1 there under its hover tint.
    expect(screen.getByTestId("app-uninstall-open")).toHaveClass("text-danger-ink");
    expect(screen.getByTestId("app-uninstall-open")).not.toHaveClass("text-danger");
  });
});

describe("an installed app's Uninstall question and details, each with its own error", () => {
  it("a Fetch files that failed on the details is not said again on the Uninstall question", async () => {
    const lacking: InstalledAppView = { ...app, run: { status: "needs-files" } };
    fakeEngine.on("appList", () => [lacking]).on("appBuiltIns", () => []).on("appFetchFiles", () => ({ status: "needs-files" }));
    const { user } = renderApp(<InstalledAppDialog app={lacking} onClose={() => {}} onOpen={() => {}} />);
    await user.click(screen.getByTestId("app-fetch-files"));
    expect(await screen.findByTestId("app-details-error")).toBeInTheDocument();
    // An alert on the question read the failed Fetch files out again, as though Uninstall had failed.
    await user.click(screen.getByTestId("app-uninstall-open"));
    expect(within(screen.getByTestId("app-uninstall")).queryByRole("alert")).toBeNull();
  });

  it("an Export that failed on the question is gone from the details after its Cancel", async () => {
    fakeEngine.on("appList", () => [app]).on("appBuiltIns", () => []).on("appDataExportText", () => { throw new Error("storage: the app's data could not be read"); });
    const { user } = renderApp(<InstalledAppDialog app={app} onClose={() => {}} onOpen={() => {}} />);
    await user.click(screen.getByTestId("app-uninstall-open"));
    await user.click(screen.getByTestId("app-export"));
    expect(await within(screen.getByTestId("app-uninstall")).findByRole("alert")).toBeInTheDocument();
    await user.click(within(screen.getByTestId("app-uninstall")).getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("app-details")).toBeInTheDocument();
    expect(screen.queryByTestId("app-details-error")).toBeNull();
  });
});

describe("an installed app's Export data, for an app that kept nothing", () => {
  it("says the app kept no data, and reads it out, instead of saving nothing in silence", async () => {
    fakeEngine.on("appList", () => [app]).on("appBuiltIns", () => []).on("appDataExportText", () => []);
    const { user } = renderApp(<InstalledAppDialog app={app} onClose={() => {}} onOpen={() => {}} />);
    await user.click(screen.getByTestId("app-uninstall-open"));
    // Under "Export the data first to keep it.", nothing saved and nothing said read as a download that was blocked.
    const said = screen.getByTestId("app-export-none");
    expect(said).toHaveRole("status");
    expect(said).toBeEmptyDOMElement();
    await user.click(screen.getByTestId("app-export"));
    await waitFor(() => expect(said).toHaveTextContent("Chess kept no data."));
    expect(within(screen.getByTestId("app-uninstall")).queryByRole("alert")).toBeNull();
  });
});
