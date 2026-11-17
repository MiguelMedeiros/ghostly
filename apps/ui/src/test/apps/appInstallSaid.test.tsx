import { act, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppPreview, InstalledAppView } from "@ghostly/browser/engine/apps";
import { AppInstallDialog, InstalledAppDialog } from "../../components/apps/AppInstallDialog";
import { forgetInstalledApps } from "../../lib/apps/installed";
import { LOCALES as locales } from "../i18n/locales";
import { translateWith } from "../../locales/translate";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.page, apps.takedown

/*
 * The install screen opens with the focus on the screen, named by its title only, and "Checking the app…" in a plain
 * line; what the check found (Install, or why it cannot be installed) came in plain lines too, so a screen reader said
 * "Chess, dialog" and then nothing. A revoked version said only that its publisher revoked it: nothing said it can't be
 * installed, or, once installed, that it stays stopped until a new version and that Uninstall drops it.
 */

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const REF = `${KEY}/chess`;
const DIGEST = "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4";
const URL_ = "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp";
const REASON = "It sent the board to a server";

const preview = (patch: Partial<AppPreview> = {}): AppPreview => ({
  digest: DIGEST, ref: REF, publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", from: URL_, icon: null, install: "new", asks: ["chat"],
  run: { status: "ok" }, listedBy: [], unknownPublisher: true, stage: `${DIGEST}\nscreen`,
  manifest: { ghostlyApp: 1, publisher: KEY, name: "chess", version: "1.2.0", sequence: 7, kind: "mini-app", title: "Chess", tagline: "Play chess with a contact",
    entry: "index.html", permissions: ["chat"], runtime: { host: ">=1.2", clients: ["web", "desktop"] }, license: "MIT", files: [] },
  ...patch,
});
const installed = (run: InstalledAppView["run"]): InstalledAppView => ({
  ref: REF, name: "chess", publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", title: "Chess", tagline: "Play chess with a contact",
  version: "1.2.0", sequence: 7, digest: DIGEST, permissions: ["chat"], view: "chat", from: URL_, icon: false, installedAt: 1, updatedAt: 1,
  run, listedBy: [], unknownPublisher: true,
});

const INSTALL_NEXT = "It can't be installed. Look for a newer version from its publisher.";
const APP_NEXT = "It stays stopped until its publisher releases a new version, or you can uninstall it.";

/** The install screen, its check held until `arrive` hands it what the engine read. */
async function opened() {
  let arrive!: (p: AppPreview) => void;
  fakeEngine.on("appPreview", () => new Promise<AppPreview>((resolve) => { arrive = resolve; }));
  renderApp(<AppInstallDialog source={{ store: "s1", ref: REF }} title="Chess" onClose={() => {}} />);
  const dialog = await screen.findByTestId("app-install");
  const said = within(dialog).getByRole("status");
  return { dialog, said, arrive: (p: AppPreview) => act(async () => { arrive(p); }) };
}

beforeEach(() => {
  forgetInstalledApps();
  fakeEngine.on("appList", () => []).on("appBuiltIns", () => []);
});
afterEach(() => { forgetInstalledApps(); vi.restoreAllMocks(); });

describe("the install screen says what its check found", () => {
  it("has its status from the start, describing the screen, and says when the app is ready to install", async () => {
    const { dialog, said, arrive } = await opened();
    expect(said).toHaveAttribute("data-testid", "app-install-said");
    expect(said).toHaveTextContent("Checking the app…");
    expect(dialog).toHaveAccessibleDescription("Checking the app…");
    await arrive(preview());
    await screen.findByTestId("app-install-confirm");
    // The same node, still there: its text changed, which is what a screen reader reads out.
    expect(within(dialog).getByRole("status")).toBe(said);
    expect(said).toHaveTextContent("Ready to install.");
  });

  it("says an update is ready to update", async () => {
    const { said, arrive } = await opened();
    await arrive(preview({ install: "update" }));
    expect(said).toHaveTextContent("Ready to update.");
  });

  it("says a revoked version's line, with what to do, and the same line shows on the screen", async () => {
    const { dialog, said, arrive } = await opened();
    await arrive(preview({ run: { status: "revoked", reason: REASON } }));
    const blocked = within(dialog).getByTestId("app-install-blocked");
    expect(blocked).toHaveTextContent(`Its publisher revoked this version: \u2068${REASON}\u2069 ${INSTALL_NEXT}`);
    expect(said).toHaveTextContent(`Its publisher revoked this version: \u2068${REASON}\u2069 ${INSTALL_NEXT}`);
    expect(within(dialog).queryByTestId("app-install-confirm")).not.toBeInTheDocument();
  });

  it("says the next step for a revoked version with no reason too", async () => {
    const { said, arrive } = await opened();
    await arrive(preview({ run: { status: "revoked" } }));
    expect(screen.getByTestId("app-install-blocked")).toHaveTextContent(`Its publisher revoked this version. ${INSTALL_NEXT}`);
    expect(said).toHaveTextContent(`Its publisher revoked this version. ${INSTALL_NEXT}`);
  });

  it("leaves a failed read to its own alert", async () => {
    fakeEngine.on("appPreview", () => { throw new Error("offline: You are offline"); });
    renderApp(<AppInstallDialog source={{ store: "s1", ref: REF }} title="Chess" onClose={() => {}} />);
    await screen.findByTestId("app-install-error");
    expect(screen.getByTestId("app-install-said")).toHaveTextContent("");
  });
});

describe("an installed app its publisher revoked", () => {
  it("says it stays stopped until a new version, or that Uninstall drops it", async () => {
    renderApp(<InstalledAppDialog app={installed({ status: "revoked", reason: REASON })} onClose={() => {}} onOpen={() => {}} />);
    expect(await screen.findByTestId("app-run-line")).toHaveTextContent(`Its publisher revoked this version: \u2068${REASON}\u2069 ${APP_NEXT}`);
    expect(screen.getByTestId("app-uninstall-open")).toBeInTheDocument();
    expect(screen.getByTestId("app-keep-stopped")).toBeInTheDocument();
  });

  it("in each language, with its own words for the next step on both screens", async () => {
    for (const lang of ["pt", "es", "fr", "it", "ja", "zh", "ar"] as const) {
      const t = translateWith(locales[lang], lang), en = translateWith(locales.en, "en");
      for (const key of ["apps.install.revokedNext", "apps.app.revokedNext"] as const) {
        expect(t(key), `${lang} ${key}`).not.toBe(en(key));
        expect(t(key), `${lang} ${key}`).not.toBe(key);
      }
    }
    renderApp(<InstalledAppDialog app={installed({ status: "revoked" })} onClose={() => {}} onOpen={() => {}} />, { language: "pt" });
    const pt = translateWith(locales.pt, "pt");
    expect(await screen.findByTestId("app-run-line")).toHaveTextContent(`${pt("apps.install.revoked")} ${pt("apps.app.revokedNext")}`);
  });
});
