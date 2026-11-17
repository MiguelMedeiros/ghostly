import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstalledAppView } from "@ghostly/browser/engine/apps";
import { InstalledAppDialog } from "../../components/apps/AppInstallDialog";
import { ChatAppsDialog } from "../../components/apps/ChatAppsDialog";
import { Notice } from "../../components/ui/Notice";
import { forgetInstalledApps } from "../../lib/apps/installed";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.page, app.i18n

/**
 * An error the app has no words for is shown as it came: the engine's short English (problemText). In Arabic it took the
 * paragraph's direction, so "Internal error opening backing store for indexedDB.open." read with its full stop at the
 * start of the line, in a chat's + → Apps and on an installed app's Uninstall question. It keeps its own direction
 * (dir="auto", as an app's title does); the app's own Arabic words keep the page's.
 */
const RAW = "Internal error opening backing store for indexedDB.open.";

/** The element showing exactly this text is laid out in its own direction: a <bdi>, or dir="auto". */
const ownDirection = (root: HTMLElement, text: string) => {
  const shown = within(root).getByText(text);
  return shown.tagName === "BDI" || shown.getAttribute("dir") === "auto";
};

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const app: InstalledAppView = {
  ref: `${KEY}/chess`, name: "chess", publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", title: "Chess", tagline: "Play chess with a contact",
  version: "1.2.0", sequence: 7, digest: "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4", permissions: ["chat"], view: "chat",
  from: "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp", icon: false, installedAt: 1, updatedAt: 1,
  run: { status: "ok" }, listedBy: [], unknownPublisher: true,
};

afterEach(() => { forgetInstalledApps(); vi.restoreAllMocks(); });

describe("in Arabic, an English error shown as it came", () => {
  it("keeps its own direction as a notice's title, and the app's Arabic words keep the page's", () => {
    renderApp(<>
      <Notice tone="error" testId="raw">{RAW}</Notice>
      <Notice tone="error" testId="said">Cashu متوقف في هذه المحادثة</Notice>
    </>, { language: "ar" });
    expect(ownDirection(screen.getByTestId("raw"), RAW)).toBe(true);
    // An Arabic line that starts with a Latin name would turn left to right under dir="auto": it is left to the page.
    expect(screen.getByTestId("said-title")).not.toHaveAttribute("dir");
  });

  it("keeps its own direction in a chat's + → Apps when the installed apps cannot be read", async () => {
    fakeEngine.on("appList", () => { throw new Error(RAW); });
    renderApp(<ChatAppsDialog linkId="link-1" name="Ana" onClose={() => {}} />, { language: "ar" });
    const line = await screen.findByTestId("chat-apps-error");
    expect(line).toHaveTextContent(RAW);
    expect(ownDirection(line, RAW)).toBe(true);
  });

  it("keeps its own direction on an installed app's Uninstall question when Uninstall fails", async () => {
    fakeEngine.on("appList", () => [app]).on("appBuiltIns", () => []).on("appUninstall", () => { throw new Error(RAW); });
    const { user } = renderApp(<InstalledAppDialog app={app} onClose={() => {}} onOpen={() => {}} />, { language: "ar" });
    await user.click(screen.getByTestId("app-uninstall-open"));
    await user.click(screen.getByTestId("app-uninstall-confirm"));
    const alert = await within(screen.getByTestId("app-uninstall")).findByRole("alert");
    expect(alert).toHaveTextContent(RAW);
    expect(ownDirection(alert, RAW)).toBe(true);
  });
});
