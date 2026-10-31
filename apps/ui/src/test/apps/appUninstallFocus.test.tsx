import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstalledAppView } from "@ghostly/browser/engine/apps";
import { InstalledAppDialog } from "../../components/apps/AppInstallDialog";
import { renderApp } from "../render";

// covers: apps.page

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const app: InstalledAppView = {
  ref: `${KEY}/chess`, name: "chess", publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", title: "Chess", tagline: "Play chess with a contact",
  version: "1.2.0", sequence: 7, digest: "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4", permissions: ["chat"], view: "chat",
  from: "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp", icon: false, installedAt: 1, updatedAt: 1,
  run: { status: "ok" }, listedBy: [], unknownPublisher: true,
};

afterEach(() => { vi.restoreAllMocks(); });

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
