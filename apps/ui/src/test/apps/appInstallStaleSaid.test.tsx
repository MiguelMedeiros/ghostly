import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppPreview, InstalledAppView } from "@ghostly/browser/engine/apps";
import { AppInstallDialog } from "../../components/apps/AppInstallDialog";
import { forgetInstalledApps } from "../../lib/apps/installed";
import { LOCALES as locales } from "../i18n/locales";
import { translateWith } from "../../locales/translate";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.page

/*
 * Install refused (`permissions-changed`, or `expired`) and the read again failing (offline, the host down) turns
 * Install off and shows Try again, but the screen's status, which also describes the screen, still said "Ready to
 * install.": a screen reader heard the app was ready while nothing on the screen could install it. While the screen
 * waits for Try again, the status says, once, to look at the app again: the line a read that worked shows.
 */

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const REF = `${KEY}/chess`;
const DIGEST = "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4";
const URL_ = "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp";
const ASKS = "What this app asks for changed. Look at it again before you install it.";
const EXPIRED = "That took too long. Check the app again.";

const preview = (patch: Partial<AppPreview> = {}): AppPreview => ({
  digest: DIGEST, ref: REF, publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", from: URL_, icon: null, install: "new", asks: ["chat"],
  run: { status: "ok" }, listedBy: [], unknownPublisher: true, stage: `${DIGEST}\nscreen`,
  manifest: { ghostlyApp: 1, publisher: KEY, name: "chess", version: "1.2.0", sequence: 7, kind: "mini-app", title: "Chess", tagline: "Play chess with a contact",
    entry: "index.html", permissions: ["chat"], runtime: { host: ">=1.2", clients: ["web", "desktop"] }, license: "MIT", files: [] },
  ...patch,
});
const installed = (): InstalledAppView => ({
  ref: REF, name: "chess", publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", title: "Chess", tagline: "Play chess with a contact",
  version: "1.2.0", sequence: 7, digest: DIGEST, permissions: ["chat"], view: "chat", from: URL_, icon: false, installedAt: 1, updatedAt: 1,
  run: { status: "ok" }, listedBy: [], unknownPublisher: true,
});

let read: () => AppPreview;
let refusal: string | null;
beforeEach(() => {
  forgetInstalledApps();
  read = () => preview();
  refusal = "permissions-changed: This install now asks for chat, name; look at it again";
  fakeEngine.on("appList", () => []).on("appBuiltIns", () => [])
    .on("appPreview", () => read())
    .on("appInstall", () => { if (refusal) throw new Error(refusal); return installed(); });
});
afterEach(() => { forgetInstalledApps(); vi.restoreAllMocks(); });

const unreachable = () => { throw new Error("network: fetch failed"); };

/** Every text the status took, in order, from when this is called. */
function heard(node: HTMLElement) {
  const said: string[] = [];
  const watch = new MutationObserver(() => { const now = node.textContent ?? ""; if (said[said.length - 1] !== now) said.push(now); });
  watch.observe(node, { childList: true, characterData: true, subtree: true });
  return { said, stop: () => watch.disconnect() };
}

describe("an install screen waiting for Try again after its read again failed", () => {
  for (const lang of ["en", "ar"] as const) {
    it(`never says it is ready to install (${lang})`, async () => {
      const t = translateWith(locales[lang], lang);
      const onInstalled = vi.fn();
      const { user } = renderApp(<AppInstallDialog source={{ url: URL_ }} onClose={() => {}} onInstalled={onInstalled} />, { language: lang });
      const confirm = await screen.findByTestId("app-install-confirm");
      const said = screen.getByTestId("app-install-said");
      const dialog = screen.getByTestId("app-install");
      expect(said).toHaveTextContent(t("apps.install.ready"));
      read = unreachable;
      await user.click(confirm);
      await screen.findByTestId("app-install-retry");
      expect(await screen.findByTestId("app-install-error")).toHaveTextContent(t("apps.errors.network"));
      expect(screen.getByTestId("app-install-confirm")).toBeDisabled();
      // Install is off: the status and the screen's description don't say it is ready.
      expect(said.textContent).not.toBe(t("apps.install.ready"));
      expect(dialog).not.toHaveAccessibleDescription(t("apps.install.ready"));
      expect(said).toHaveTextContent(t("apps.install.asksChanged"));
      expect(dialog).toHaveAccessibleDescription(t("apps.install.asksChanged"));
      expect(onInstalled).not.toHaveBeenCalled();
    });
  }

  it("says so once, not again when Try again fails again, and ready once Try again read it", async () => {
    const { user } = renderApp(<AppInstallDialog source={{ url: URL_ }} onClose={() => {}} />);
    const confirm = await screen.findByTestId("app-install-confirm");
    const said = screen.getByTestId("app-install-said");
    const told = heard(said);
    read = unreachable;
    await user.click(confirm);
    await screen.findByTestId("app-install-retry");
    expect(said).toHaveTextContent(ASKS);
    await user.click(screen.getByTestId("app-install-retry"));
    await waitFor(() => expect(screen.getByTestId("app-install-retry")).not.toHaveAttribute("aria-busy"));
    expect(await screen.findByTestId("app-install-error")).toHaveTextContent("Could not reach the host.");
    expect(told.said).toEqual([ASKS]);
    read = () => preview({ asks: ["chat", "name"], manifest: { ...preview().manifest, permissions: ["chat", "name"] } });
    await user.click(screen.getByTestId("app-install-retry"));
    await waitFor(() => expect(screen.getByTestId("app-install-confirm")).toBeEnabled());
    expect(said).toHaveTextContent("Ready to install.");
    told.stop();
  });

  it("after an expired Install too", async () => {
    refusal = "expired: Fetch the app again";
    const { user } = renderApp(<AppInstallDialog source={{ url: URL_ }} onClose={() => {}} />);
    const confirm = await screen.findByTestId("app-install-confirm");
    read = unreachable;
    await user.click(confirm);
    await screen.findByTestId("app-install-retry");
    expect(screen.getByTestId("app-install-said")).toHaveTextContent(EXPIRED);
    expect(screen.getByTestId("app-install")).toHaveAccessibleDescription(EXPIRED);
  });

  it("an update says it is not ready to update either", async () => {
    read = () => preview({ install: "update" });
    const { user } = renderApp(<AppInstallDialog source={{ url: URL_ }} onClose={() => {}} />);
    const confirm = await screen.findByTestId("app-install-confirm");
    expect(screen.getByTestId("app-install-said")).toHaveTextContent("Ready to update.");
    read = unreachable;
    await user.click(confirm);
    await screen.findByTestId("app-install-retry");
    expect(screen.getByTestId("app-install-said")).toHaveTextContent("This update now adds other permissions. Look at them again before you update.");
  });
});
