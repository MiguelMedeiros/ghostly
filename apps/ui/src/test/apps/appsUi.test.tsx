import { act, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appCardId, statusCardText, type AppCard } from "@ghostly/core";
import type { AppPreview, InstalledAppView } from "@ghostly/browser/engine/apps";
import type { LinkView } from "@ghostly/browser/shared/types";
import { MessageBubble } from "../../components/MessageBubble";
import { MessageInput } from "../../components/MessageInput";
import { AccountBar } from "../../components/AccountBar";
import { MobileTabBar } from "../../components/MobileTabBar";
import { ChatServicesDialog } from "../../components/ChatServicesDialog";
import { InstalledAppDialog, AppInstallDialog } from "../../components/apps/AppInstallDialog";
import { Apps } from "../../pages/Apps";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { setAppOpener } from "../../lib/apps/open";
import { forgetAppsAvailable } from "../../lib/apps/flag";
import { forgetInstalledApps } from "../../lib/apps/installed";
import type { ChatMessage } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.page, apps.chat.card

// The runner page's header, asked once by the real check: answered here, never fetched in a test.
vi.mock("../../lib/apps/runnerCheck", () => ({ runnerAvailable: vi.fn(async () => true), forgetRunnerCheck: () => {}, isRunnerPolicy: () => true }));

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const REF = `${KEY}/chess`;
const DIGEST = "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4";
const URL_ = "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp";
const CARD: AppCard = { kind: "app", id: appCardId(REF), ref: REF, digest: DIGEST, sequence: 7, title: "Chess", version: "1.2.0", url: URL_, opened: true };

const installed = (patch: Partial<InstalledAppView> = {}): InstalledAppView => ({
  ref: REF, name: "chess", publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", title: "Chess", tagline: "Play chess with a contact",
  version: "1.2.0", sequence: 7, digest: DIGEST, permissions: ["chat"], from: URL_, icon: false, installedAt: 1, updatedAt: 1,
  run: { status: "ok" }, listedBy: [], unknownPublisher: true, ...patch,
});
const preview = (patch: Partial<AppPreview> = {}): AppPreview => ({
  digest: DIGEST, ref: REF, publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", from: URL_, icon: null, install: "new", asks: ["chat"],
  run: { status: "ok" }, listedBy: [], unknownPublisher: true,
  manifest: { ghostlyApp: 1, publisher: KEY, name: "chess", version: "1.2.0", sequence: 7, kind: "mini-app", title: "Chess", tagline: "Play chess with a contact",
    entry: "index.html", permissions: ["chat"], runtime: { host: ">=1.2", clients: ["web", "desktop"] }, license: "MIT", files: [] },
  ...patch,
});

const cardMessage = (patch: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: "m1", text: statusCardText(CARD), card: CARD, sender: "peer", timestamp: 1_700_000_000_000, ...patch });

const ready = { status: "ready", transport: "iroh/1" } as NonNullable<LinkView["pairing"]>;
/** A paired chat with Ana; `live`: connected, both apps offering apps/1. */
const ana = (live: boolean) => linkView({ id: "link-1", peerPubKeyZ32: "peer", profile: "paired-chat/1", pairing: live ? ready : { status: "waiting" } as never,
  dataLink: live ? "open" : "idle", sessionOffers: { mine: ["apps/1"], peer: live ? ["apps/1"] : null }, capabilities: { files: true, payments: false } });

/** Every engine call about apps so far. */
const appCalls = () => fakeEngine.calls.filter((c) => c.method.startsWith("app")).map((c) => c.method);

function appsOn() {
  vi.stubEnv("VITE_APPS_TEST", "1");
  fakeEngine.appRunner = "/app-frame.html";
  setAppOpener(vi.fn(async () => {}));
}

let fetches: string[];
beforeEach(() => {
  forgetAppsAvailable();
  forgetInstalledApps();
  fetches = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => { fetches.push(String(input)); return new Response("", { status: 404 }); });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setAppOpener(null);
});

describe("with the apps flag off", () => {
  it("shows nothing new: no page, no place, no tab, no composer row, the card as its text, and no request", async () => {
    // A client that runs apps, with its opener: only the flag is off.
    fakeEngine.appRunner = "/app-frame.html";
    setAppOpener(vi.fn(async () => {}));
    const { user } = renderApp(
      <LockScreenProvider>
        <Routes>
          <Route path="/apps" element={<Apps />} />
          <Route path="/" element={<p data-testid="home">home</p>} />
        </Routes>
        <AccountBar />
        <MobileTabBar />
        <MessageBubble message={cardMessage()} peerPubKey="peer" contactName="Ana" linkId="link-1" />
        <MessageInput onSend={async () => null} apps={undefined} />
        <ChatServicesDialog peerPubKey="peer" name="Ana" onClose={() => {}} />
      </LockScreenProvider>,
      { route: "/apps" },
    );
    act(() => fakeEngine.update({ links: [ana(true)] }));
    await waitFor(() => expect(screen.getByTestId("home")).toBeInTheDocument());
    expect(screen.queryByTestId("apps-page")).not.toBeInTheDocument();
    expect(screen.queryByTestId("account-apps")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mobile-tab-apps")).not.toBeInTheDocument();
    expect(screen.getByTestId("mobile-tab-services")).toBeInTheDocument();
    // An older app's view of the card: its text, the bundle's URL as a link.
    expect(screen.queryByTestId("app-card")).not.toBeInTheDocument();
    expect(screen.getByText(/Opened Chess 1\.2\.0 in this chat/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /raw\.githubusercontent\.com/ })).toBeInTheDocument();
    await user.click(screen.getByTestId("composer-more"));
    expect(screen.queryByTestId("composer-apps")).not.toBeInTheDocument();
    // The Shared services dialog keeps its old name.
    expect(screen.getByRole("heading", { name: "Apps with Ana" })).toBeInTheDocument();
    expect(appCalls()).toEqual([]);
    expect(fetches).toEqual([]);
  });
});

describe("with the apps flag on", () => {
  beforeEach(appsOn);

  it("renames the shared-apps dialog Shared services", async () => {
    renderApp(<ChatServicesDialog peerPubKey="peer" name="Ana" onClose={() => {}} />);
    act(() => fakeEngine.update({ links: [ana(true)] }));
    expect(await screen.findByRole("heading", { name: "Shared services with Ana" })).toBeInTheDocument();
  });

  it("puts Apps in Services' place, in the sidebar and in a phone's tabs: five places each", async () => {
    renderApp(<><AccountBar /><MobileTabBar /></>);
    expect(await screen.findByTestId("account-apps")).toHaveAccessibleName("Apps");
    expect(screen.queryByTestId("account-services")).not.toBeInTheDocument();
    expect(screen.getByTestId("mobile-tab-apps")).toHaveTextContent("Apps");
    expect(screen.queryByTestId("mobile-tab-services")).not.toBeInTheDocument();
    expect(screen.getAllByTestId(/^mobile-tab-[a-z]+$/)).toHaveLength(5);
  });

  it("draws a card from its own data and asks nothing of any host until Install", async () => {
    fakeEngine.on("appList", () => []).on("appPreview", () => preview()).on("appInstall", () => installed());
    const opener = vi.fn(async () => {});
    setAppOpener(opener);
    const { user } = renderApp(<MessageBubble message={cardMessage()} peerPubKey="peer" contactName="Ana" linkId="link-1" />);
    act(() => fakeEngine.update({ links: [ana(true)] }));
    const card = await screen.findByTestId("app-card");
    expect(card).toHaveTextContent("Chess 1.2.0");
    expect(card).toHaveTextContent("Ana opened it here");
    expect(card).toHaveTextContent("yz7m oxuc bd4u 8aqt");
    expect(within(card).getByTestId("app-card-check")).toHaveTextContent("Not checked yet");
    expect(screen.queryByTestId("app-card-waiting")).not.toBeInTheDocument();
    // Only the local list of installed apps: no preview, no fetch.
    await waitFor(() => expect(appCalls()).toEqual(["appList"]));
    expect(fetches).toEqual([]);

    await user.click(within(card).getByTestId("app-card-install"));
    expect(fakeEngine.callsTo("appPreview")).toEqual([{ card: { ref: REF, url: URL_, sequence: 7, digest: DIGEST } }]);
    const screenEl = await screen.findByTestId("app-install");
    expect(await within(screenEl).findByTestId("app-sent-by")).toHaveTextContent("Sent by Ana");
    expect(within(screenEl).getByTestId("app-publisher-name")).toHaveTextContent("Unknown publisher");
    expect(within(screenEl).getByTestId("app-store-line")).toHaveTextContent("Not in any of your stores");
    expect(within(screenEl).getByTestId("app-permissions")).toHaveTextContent("Keep its own data on this device");
    expect(within(screenEl).getByTestId("app-permissions")).toHaveTextContent("Talk to the same app on your contact's side");
    expect(within(screenEl).getByTestId("app-privacy")).toHaveTextContent("No internet access. The publisher may still learn your IP address and when you open it.");
    expect(within(screenEl).getByTestId("app-ip-line")).toHaveTextContent("Installing downloads from raw.githubusercontent.com, which learns your IP address.");
    await user.click(within(screenEl).getByRole("button", { name: "Install and play" }));
    expect(fakeEngine.callsTo("appInstall")).toEqual([{ digest: DIGEST, grant: ["chat"] }]);
    // Installing from a card opens it in that chat.
    await waitFor(() => expect(opener).toHaveBeenCalledWith(REF, "link-1"));
    expect(fetches).toEqual([]);
  });

  it("says the app needs you both online while the contact is not live, and Play once installed", async () => {
    fakeEngine.on("appList", () => [installed()]);
    renderApp(<MessageBubble message={cardMessage()} peerPubKey="peer" contactName="Ana" linkId="link-1" />);
    act(() => fakeEngine.update({ links: [ana(false)] }));
    expect(await screen.findByTestId("app-card-waiting")).toHaveTextContent("Chess needs you both online");
    expect(await screen.findByTestId("app-card-play")).toBeInTheDocument();
    expect(screen.queryByTestId("app-card-install")).not.toBeInTheDocument();
  });

  it("keeps the card's text in a group, where apps do not run", async () => {
    fakeEngine.on("appList", () => []);
    renderApp(<MessageBubble message={cardMessage()} peerPubKey="peer" contactName="Ana" linkId="group:g1" />);
    await act(async () => {});
    expect(screen.queryByTestId("app-card")).not.toBeInTheDocument();
    expect(screen.getByText(/Opened Chess 1\.2\.0 in this chat/)).toBeInTheDocument();
  });

  it("an update that adds a permission shows only what is new, and waits for the person", async () => {
    fakeEngine.on("appUpdateAccept", () => installed({ permissions: ["chat", "name"] })).on("appList", () => []);
    const { user } = renderApp(<InstalledAppDialog onClose={() => {}} onOpen={() => {}}
      app={installed({ pending: { sequence: 8, version: "1.3.0", added: ["name"] } })} />);
    const update = await screen.findByTestId("app-update");
    expect(update).toHaveTextContent("Version 1.3.0 is ready.");
    expect(within(update).getByTestId("app-permissions")).toHaveTextContent("This update also asks to");
    expect(within(update).getByTestId("app-permissions")).toHaveTextContent("See your name in this chat");
    expect(within(update).getByTestId("app-permissions")).not.toHaveTextContent("Talk to the same app");
    expect(within(update).getByTestId("app-permissions")).not.toHaveTextContent("Keep its own data");
    expect(fakeEngine.callsTo("appUpdateAccept")).toEqual([]);
    await user.click(screen.getByTestId("app-update-accept"));
    expect(fakeEngine.callsTo("appUpdateAccept")).toEqual([{ ref: REF }]);
  });

  it("the install screen of an update lists only the added permission", async () => {
    fakeEngine.on("appPreview", () => preview({ install: "update", asks: ["name"] }));
    renderApp(<AppInstallDialog source={{ url: URL_ }} onClose={() => {}} />);
    const permissions = await screen.findByTestId("app-permissions");
    expect(permissions).toHaveTextContent("This update also asks to");
    expect(permissions).toHaveTextContent("See your name in this chat");
    expect(permissions).not.toHaveTextContent("Keep its own data");
    expect(screen.getByTestId("app-install-confirm")).toHaveTextContent("Update");
  });

  it("refuses to install a version a store removed or its publisher revoked", async () => {
    fakeEngine.on("appPreview", () => preview({ run: { status: "removed", by: [{ store: "k", name: "Ghostly", reason: "Malware", at: 1 }] } }));
    renderApp(<AppInstallDialog source={{ url: URL_ }} onClose={() => {}} />);
    expect(await screen.findByTestId("app-install-blocked")).toHaveTextContent("Removed by Ghostly: Malware");
    expect(screen.queryByTestId("app-install-confirm")).not.toBeInTheDocument();
  });

  it("lists installed apps and stores; uninstall offers an export first", async () => {
    fakeEngine.on("appList", () => [installed({ unknownPublisher: false, listedBy: [{ key: "s", name: "Ghostly", kind: "curated" }] })])
      .on("appStoreList", () => [{ key: "s", fingerprint: "abcd efgh ijkl mnop", url: "https://raw.githubusercontent.com/g/s/HEAD/ghostly-store.json", preloaded: false,
        name: "Ghostly", kind: "curated", sequence: 1, expires: 2_000_000_000, expired: false, fetchedAt: 1,
        apps: [{ ref: REF, sequence: 7, digest: DIGEST, urls: [URL_], title: "Chess", tagline: "Play chess with a contact" }], removed: [] }])
      .on("appCheckUpdates", () => []).on("appDataExport", () => []).on("appUninstall", () => undefined);
    const { user } = renderApp(<Apps />, { route: "/apps" });
    const row = await screen.findByTestId("installed-app");
    expect(row).toHaveTextContent("Chess");
    expect(screen.getByTestId("app-store")).toHaveTextContent("Ghostly");
    expect(screen.getByTestId("app-store")).toHaveTextContent("Curated");
    expect(appCalls()).toContain("appCheckUpdates");
    await user.click(within(row).getByRole("button", { name: "Chess: details" }));
    expect(screen.getByTestId("app-store-line")).toHaveTextContent("In Ghostly");
    await user.click(screen.getByTestId("app-uninstall-open"));
    expect(screen.getByTestId("app-uninstall")).toHaveTextContent("Export the data first");
    await user.click(screen.getByTestId("app-uninstall-confirm"));
    expect(fakeEngine.callsTo("appUninstall")).toEqual([{ ref: REF }]);
    expect(fetches).toEqual([]);
  });
});
