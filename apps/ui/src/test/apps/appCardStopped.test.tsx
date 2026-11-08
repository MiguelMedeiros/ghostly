import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { appCardId, type AppCard } from "@ghostly/core";
import type { InstalledAppView } from "@ghostly/browser/engine/apps";
import { AppCardView } from "../../components/apps/AppCardView";
import { Apps } from "../../pages/Apps";
import { setAppOpener, type AppOpener } from "../../lib/apps/open";
import { forgetAppsAvailable } from "../../lib/apps/flag";
import { forgetInstalledApps } from "../../lib/apps/installed";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.chat.card apps.page

/*
 * A card in a chat for an app installed here whose version was found revoked or removed says what the Apps page says
 * of the same app at the same moment: "Stopped", with no plain Open. Removed by a store, it offers "Run anyway" as the
 * details screen does; revoked, it never does. An app that may run still says "Installed" with Open.
 */

vi.mock("../../lib/apps/runnerCheck", () => ({ runnerAvailable: vi.fn(async () => true), runnerPolicy: vi.fn(async () => true), forgetRunnerCheck: () => {}, isRunnerPolicy: () => true }));

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const REF = `${KEY}/chess`;
const DIGEST = "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4";
const URL_ = "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp";
const CARD: AppCard = { kind: "app", id: appCardId(REF), ref: REF, digest: DIGEST, sequence: 7, title: "Chess", version: "1.2.0", url: URL_, opened: true };
const REMOVED: InstalledAppView["run"] = { status: "removed", by: [{ store: "k", name: "Ghostly", reason: "Sends your moves to a server", at: 1 }] };

let run: InstalledAppView["run"];
const installed = (): InstalledAppView => ({
  ref: REF, name: "chess", publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", title: "Chess", tagline: "Play chess", version: "1.2.0",
  sequence: 7, digest: DIGEST, permissions: ["chat"], view: "chat", from: URL_, icon: false, installedAt: 1, updatedAt: 1,
  run, listedBy: [], unknownPublisher: true,
});
let opened: Mock<AppOpener>;

beforeEach(() => {
  forgetAppsAvailable();
  forgetInstalledApps();
  vi.stubEnv("VITE_APPS_TEST", "1");
  fakeEngine.appRunner = "/app-frame.html";
  opened = vi.fn<AppOpener>(async () => {});
  setAppOpener(opened);
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36");
  fakeEngine.on("appList", () => [installed()]).on("appStoreList", () => []).on("appBuiltIns", () => []).on("appCheckUpdates", () => []);
  fakeEngine.setState({ links: [linkView({ id: "link-1", peerPubKeyZ32: "peer", profile: "paired-chat/1" })] });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setAppOpener(null);
  forgetAppsAvailable();
  forgetInstalledApps();
});

/** The Apps page and a contact's card of the same app, side by side; the card once it names the installed app. */
async function pageAndCard() {
  const view = renderApp(<><Apps /><AppCardView card={CARD} mine={false} contact="Ana" linkId="link-1" peerKey="peer" /></>, { route: "/apps" });
  const row = await screen.findByTestId("installed-app");
  const card = screen.getByTestId("app-card");
  await waitFor(() => expect(within(card).getByTestId("app-card-check")).not.toHaveTextContent("Not checked yet"));
  return { ...view, row, card };
}

describe("an app card for an installed app taken down", () => {
  it("revoked: the card says Stopped as the Apps page does, with no Open and no Run anyway", async () => {
    run = { status: "revoked" };
    const { row, card } = await pageAndCard();
    expect(within(row).getByTestId("installed-app-hint")).toHaveTextContent(/^Stopped$/);
    expect(within(card).getByTestId("app-card-check")).toHaveTextContent(/^Stopped$/);
    expect(within(card).queryByTestId("app-card-open")).not.toBeInTheDocument();
    expect(within(card).queryByTestId("app-card-run-anyway")).not.toBeInTheDocument();
    expect(within(row).queryByTestId("installed-app-open")).not.toBeInTheDocument();
  });

  it("removed by a store: the card says Stopped as the Apps page does, and offers Run anyway, which opens it", async () => {
    run = REMOVED;
    const { row, card, user } = await pageAndCard();
    expect(within(row).getByTestId("installed-app-hint")).toHaveTextContent(/^Stopped$/);
    expect(within(card).getByTestId("app-card-check")).toHaveTextContent(/^Stopped$/);
    expect(within(card).queryByTestId("app-card-open")).not.toBeInTheDocument();
    await user.click(within(card).getByTestId("app-card-run-anyway"));
    expect(opened).toHaveBeenCalledWith(REF, "link-1", { runAnyway: true });
  });

  it("an app that may run still says Installed with Open", async () => {
    run = { status: "ok" };
    const { row, card, user } = await pageAndCard();
    expect(within(row).getByTestId("installed-app-hint")).toHaveTextContent(/Play chess$/);
    expect(within(card).getByTestId("app-card-check")).toHaveTextContent(/^Installed$/);
    expect(within(card).queryByTestId("app-card-run-anyway")).not.toBeInTheDocument();
    await user.click(within(card).getByTestId("app-card-open"));
    expect(opened).toHaveBeenCalledWith(REF, "link-1", { runAnyway: false });
  });
});
