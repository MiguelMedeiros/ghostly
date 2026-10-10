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
import { AddAppDialog } from "../../components/apps/AddAppDialog";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { Settings } from "../../pages/Settings";
import { setAppOpener } from "../../lib/apps/open";
import { appsAvailable, forgetAppsAvailable, webKitAppLeak } from "../../lib/apps/flag";
import { forgetInstalledApps } from "../../lib/apps/installed";
import type { ChatMessage } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.page, apps.chat.card

// The runner page's header, asked once by the real check: answered here, never fetched in a test.
vi.mock("../../lib/apps/runnerCheck", () => ({ runnerAvailable: vi.fn(async () => true), runnerPolicy: vi.fn(async () => true), forgetRunnerCheck: () => {}, isRunnerPolicy: () => true }));
// The build's flag, off here whatever APPS_ENABLED says: "with the apps flag on" turns it on as the e2e build does.
vi.mock("@ghostly/browser/shared/features", async (importOriginal) =>
  ({ ...(await importOriginal<typeof import("@ghostly/browser/shared/features")>()), APPS_ENABLED: false }));

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const REF = `${KEY}/chess`;
const DIGEST = "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4";
const URL_ = "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp";
const CARD: AppCard = { kind: "app", id: appCardId(REF), ref: REF, digest: DIGEST, sequence: 7, title: "Chess", version: "1.2.0", url: URL_, opened: true };

const installed = (patch: Partial<InstalledAppView> = {}): InstalledAppView => ({
  ref: REF, name: "chess", publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", title: "Chess", tagline: "Play chess with a contact",
  version: "1.2.0", sequence: 7, digest: DIGEST, permissions: ["chat"], view: "chat", from: URL_, icon: false, installedAt: 1, updatedAt: 1,
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

/** Settings' storage section with Clear all data asked: its list of what goes. */
async function openClearAllData(): Promise<HTMLElement> {
  const { user } = renderApp(
    <LockScreenProvider><UpdateProvider><Routes><Route path="/settings/:section?" element={<Settings />} /></Routes></UpdateProvider></LockScreenProvider>,
    { route: "/settings/storage" },
  );
  await user.click(await screen.findByTestId("clear-all-data"));
  return screen.getByTestId("clear-all-data-list");
}

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
  // Chromium, as the e2e suite runs: happy-dom's own user agent names AppleWebKit and no other engine.
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => { fetches.push(String(input)); return new Response("", { status: 404 }); });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setAppOpener(null);
});

describe("webKitAppLeak: the web app in a WebKit browser", () => {
  it("is Safari and every iOS browser, not Chromium, Firefox or Desktop", () => {
    const ua = {
      safari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      iosChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1",
      chrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
      android: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36",
      firefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0",
    };
    expect(webKitAppLeak(ua.safari, false)).toBe(true);
    expect(webKitAppLeak(ua.iosChrome, false)).toBe(true);
    expect(webKitAppLeak(ua.chrome, false)).toBe(false);
    expect(webKitAppLeak(ua.android, false)).toBe(false);
    expect(webKitAppLeak(ua.firefox, false)).toBe(false);
    expect(webKitAppLeak(ua.safari, true)).toBe(false);
  });
});

describe("appsAvailable, the one rule every screen asks", () => {
  const on = { enabled: true, runner: "/app-frame.html", opener: async () => {}, runnerPolicy: true } as const;
  it("is on only when the build, the client, the opener and the runner's header all say so", () => {
    expect(appsAvailable(on)).toBe("on");
    expect(appsAvailable({ ...on, enabled: false })).toBe("off");
    expect(appsAvailable({ ...on, runner: null })).toBe("off");
    expect(appsAvailable({ ...on, opener: null })).toBe("off");
    expect(appsAvailable({ ...on, runnerPolicy: false })).toBe("off");
    expect(appsAvailable({ ...on, runnerPolicy: undefined })).toBe("checking");
  });
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
    // The Shared services dialog has that name with the flag off too.
    expect(screen.getByRole("heading", { name: "Shared services with Ana" })).toBeInTheDocument();
    expect(appCalls()).toEqual([]);
    expect(fetches).toEqual([]);
  });

  it("Clear all data says nothing of installed apps", async () => {
    fakeEngine.appRunner = "/app-frame.html";
    setAppOpener(vi.fn(async () => {}));
    const list = await openClearAllData();
    expect(within(list).getByText("Shared services")).toBeInTheDocument();
    expect(within(list).queryByText("Installed apps and their data")).not.toBeInTheDocument();
    expect(list.querySelector('[data-item="appsData"]')).toBeNull();
  });
});

describe("with the apps flag on", () => {
  beforeEach(appsOn);

  it("on Desktop, which serves its runner itself, shows Apps without asking any server for the runner's header", async () => {
    // covers: apps.desktop-sandbox
    const { runnerAvailable } = await import("../../lib/apps/runnerCheck");
    vi.mocked(runnerAvailable).mockClear();
    fakeEngine.appRunner = "ghostly-app://localhost/";
    fakeEngine.appRunnerServed = true;
    renderApp(<AccountBar />);
    expect(await screen.findByTestId("account-apps")).toHaveAccessibleName("Apps");
    expect(runnerAvailable).not.toHaveBeenCalled();
    expect(fetches).toEqual([]);
  });

  it.each([
    // The Android app is the Desktop app built for Android: a Tauri page with an Android agent.
    ["in the Android app", "Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36"],
    // Desktop on Windows: a Tauri page in WebView2.
    ["on Desktop on Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0"],
  ])("%s shows nothing of it, even in the e2e suite's build: no page, no place, no tab, no card, no composer row, no request", async (_where, agent) => {
    // covers: apps.desktop-sandbox
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(agent);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    // A runner the app does not serve itself: without the platform rule, its header would be asked.
    fakeEngine.appRunner = "/app-frame.html";
    fakeEngine.appRunnerServed = false;
    const { runnerPolicy } = await import("../../lib/apps/runnerCheck");
    vi.mocked(runnerPolicy).mockClear();
    try {
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
        </LockScreenProvider>,
        { route: "/apps" },
      );
      act(() => fakeEngine.update({ links: [ana(true)] }));
      await waitFor(() => expect(screen.getByTestId("home")).toBeInTheDocument());
      expect(screen.queryByTestId("apps-page")).not.toBeInTheDocument();
      expect(screen.queryByTestId("account-apps")).not.toBeInTheDocument();
      expect(screen.queryByTestId("mobile-tab-apps")).not.toBeInTheDocument();
      // The card as its text, as in an older app.
      expect(screen.queryByTestId("app-card")).not.toBeInTheDocument();
      expect(screen.getByText(/Opened Chess 1\.2\.0 in this chat/)).toBeInTheDocument();
      await user.click(screen.getByTestId("composer-more"));
      expect(screen.queryByTestId("composer-apps")).not.toBeInTheDocument();
      expect(appCalls()).toEqual([]);
      expect(runnerPolicy).not.toHaveBeenCalled();
      expect(fetches).toEqual([]);
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
  });

  it("keeps the dialog's name Shared services", async () => {
    renderApp(<ChatServicesDialog peerPubKey="peer" name="Ana" onClose={() => {}} />);
    act(() => fakeEngine.update({ links: [ana(true)] }));
    expect(await screen.findByRole("heading", { name: "Shared services with Ana" })).toBeInTheDocument();
  });

  it("Clear all data lists the installed apps and their data", async () => {
    const list = await openClearAllData();
    expect(within(list).getByText("Shared services")).toBeInTheDocument();
    expect(await within(list).findByText("Installed apps and their data")).toBeInTheDocument();
  });

  it("puts Apps beside Services under the list, and in Services' tab on a phone (five tabs)", async () => {
    renderApp(<><AccountBar /><MobileTabBar /></>);
    expect(await screen.findByTestId("account-apps")).toHaveAccessibleName("Apps");
    expect(screen.getByTestId("account-services")).toBeInTheDocument();
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
    // One line about who learns the address, the rest behind its ⓘ.
    expect(within(screenEl).getByTestId("app-ip-line")).toHaveTextContent("Downloads from raw.githubusercontent.com, which sees your IP address.");
    expect(within(screenEl).queryByTestId("app-ip-line-text")).not.toBeInTheDocument();
    await user.click(within(screenEl).getByTestId("app-ip-line-info"));
    expect(within(screenEl).getByTestId("app-ip-line-text")).toHaveTextContent(
      "Ghostly downloads the app from raw.githubusercontent.com, which learns your IP address and when. The app has no internet access, but its publisher may still learn your IP address and when you open it.");
    expect(within(screenEl).queryByTestId("app-webkit-line")).not.toBeInTheDocument();
    await user.click(within(screenEl).getByRole("button", { name: "Install and open" }));
    expect(fakeEngine.callsTo("appInstall")).toEqual([{ digest: DIGEST, grant: ["chat"] }]);
    // Installing from a card opens it in that chat.
    await waitFor(() => expect(opener).toHaveBeenCalledWith(REF, "link-1", { runAnyway: false }));
    expect(fetches).toEqual([]);
  });

  it("says the app needs you both online while the contact is not live, and Open once installed", async () => {
    fakeEngine.on("appList", () => [installed()]);
    renderApp(<MessageBubble message={cardMessage()} peerPubKey="peer" contactName="Ana" linkId="link-1" />);
    act(() => fakeEngine.update({ links: [ana(false)] }));
    expect(await screen.findByTestId("app-card-waiting")).toHaveTextContent("Chess needs you both online");
    expect(await screen.findByTestId("app-card-open")).toBeInTheDocument();
    expect(screen.queryByTestId("app-card-install")).not.toBeInTheDocument();
  });

  it("a card for an app installed here names the installed app, the one Open starts, not the card's own title", async () => {
    const notes = installed({ title: "Private Notes", version: "3.1.0", permissions: ["chat", "name"] });
    fakeEngine.on("appList", () => [notes]);
    const opener = vi.fn(async () => {});
    setAppOpener(opener);
    // Every field is Ana's to choose: the installed app's ref under another name and version.
    const card: AppCard = { ...CARD, title: "Chess", version: "1.0.0" };
    const { user } = renderApp(<MessageBubble message={cardMessage({ card, text: statusCardText(card) })} peerPubKey="peer" contactName="Ana" linkId="link-1" />);
    act(() => fakeEngine.update({ links: [ana(false)] }));
    const shown = await screen.findByTestId("app-card");
    await waitFor(() => expect(within(shown).getByTestId("app-card-check")).toHaveTextContent("Installed"));
    expect(within(shown).getByTestId("app-card-title")).toHaveTextContent("Private Notes 3.1.0");
    expect(within(shown).getByTestId("app-card-title")).not.toHaveTextContent("Chess");
    expect(within(shown).getByTestId("app-card-waiting")).toHaveTextContent("Private Notes needs you both online");
    await user.click(within(shown).getByTestId("app-card-open"));
    await waitFor(() => expect(opener).toHaveBeenCalledWith(REF, "link-1", { runAnyway: false }));
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

  it("shows the internet permission with what it means behind ⓘ, and an update that adds it asks again", async () => {
    const internet: AppPreview["asks"] = ["chat", "internet"];
    fakeEngine.on("appPreview", () => preview({ asks: internet, manifest: { ...preview().manifest, permissions: internet } }));
    const { user, unmount } = renderApp(<AppInstallDialog source={{ url: URL_ }} onClose={() => {}} />);
    const line = await screen.findByTestId("app-permission-internet");
    expect(line).toHaveTextContent("Use the internet");
    await user.click(within(line).getByTestId("app-permission-internet-info"));
    expect(screen.getByTestId("app-permission-internet-text")).toHaveTextContent("The app and the servers it talks to can learn your IP address and what you do in it.");
    // An app that may use the internet is not told it has none.
    await user.click(screen.getByTestId("app-ip-line-info"));
    expect(screen.getByTestId("app-ip-line-text")).not.toHaveTextContent("no internet access");
    unmount();

    fakeEngine.on("appUpdateAccept", () => installed()).on("appList", () => []);
    renderApp(<InstalledAppDialog onClose={() => {}} onOpen={() => {}}
      app={installed({ pending: { sequence: 8, version: "1.3.0", added: ["internet"] } })} />);
    const update = await screen.findByTestId("app-update");
    expect(within(update).getByTestId("app-permissions")).toHaveTextContent("This update also asks to");
    expect(within(update).getByTestId("app-permission-internet")).toHaveTextContent("Use the internet");
    expect(fakeEngine.callsTo("appUpdateAccept")).toEqual([]);
  });

  it("says in Safari, and only there, that an app can still contact other servers", async () => {
    const safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(safari);
    fakeEngine.on("appPreview", () => preview());
    const { user } = renderApp(<AppInstallDialog source={{ url: URL_ }} onClose={() => {}} />);
    const line = await screen.findByTestId("app-webkit-line");
    expect(line).toHaveTextContent("In this browser, an app can still contact other servers.");
    await user.click(within(line).getByTestId("app-webkit-line-info"));
    expect(screen.getByTestId("app-webkit-line-text")).toHaveTextContent("The desktop app blocks them.");
  });

  it("refuses to install a version a store removed or its publisher revoked", async () => {
    fakeEngine.on("appPreview", () => preview({ run: { status: "removed", by: [{ store: "k", name: "Ghostly", reason: "Malware", at: 1 }] } }));
    renderApp(<AppInstallDialog source={{ url: URL_ }} onClose={() => {}} />);
    expect(await screen.findByTestId("app-install-blocked")).toHaveTextContent("Removed by Ghostly: Malware");
    expect(screen.queryByTestId("app-install-confirm")).not.toBeInTheDocument();
  });

  it("a github.com page that is not an app says so, and asks for a repository or file link, never that GitHub is off the list", async () => {
    const tried: string[] = [];
    fakeEngine.on("appPreview", () => { tried.push("app"); throw new Error("github-link: Paste the repository's link, or the link to its app file"); })
      .on("appStorePreview", () => { tried.push("store"); throw new Error("github-link: Paste the repository's link, or the link to its app file"); });
    const { user } = renderApp(<AddAppDialog onClose={() => {}} onStoreAdded={() => {}} />);
    await user.type(screen.getByTestId("apps-add-url"), "https://github.com/ana/chess/issues/3");
    await user.click(screen.getByTestId("apps-add-check"));
    expect(await screen.findByTestId("apps-add-error")).toHaveTextContent("That GitHub page is not an app. Paste the repository's link, or the link to its app file.");
    expect(screen.getByTestId("apps-add-error")).not.toHaveTextContent("Apps come only from GitHub");
    // Not read again as a store: the same link is no store either.
    expect(tried).toEqual(["app"]);
  });

  it("a link without https:// to a host of the list is read as https://, as a repository is usually written", async () => {
    const asked: unknown[] = [];
    fakeEngine.on("appPreview", (params) => { asked.push(params); return preview(); });
    const { user } = renderApp(<AddAppDialog onClose={() => {}} onStoreAdded={() => {}} />);
    await user.type(screen.getByTestId("apps-add-url"), "github.com/ana/chess");
    await user.click(screen.getByTestId("apps-add-check"));
    await waitFor(() => expect(asked).toEqual([{ url: "https://github.com/ana/chess" }]));
    expect(screen.queryByTestId("apps-add-error")).not.toBeInTheDocument();
  });

  it("words that are no link get the dialog's own error, not the browser's validation bubble", async () => {
    const asked: unknown[] = [];
    const refuse = (params: unknown) => { asked.push(params); throw new Error("host: Apps are read only from raw.githubusercontent.com, or from cdn.jsdelivr.net at a commit, over HTTPS"); };
    fakeEngine.on("appPreview", refuse).on("appStorePreview", refuse);
    const { user } = renderApp(<AddAppDialog onClose={() => {}} onStoreAdded={() => {}} />);
    await user.type(screen.getByTestId("apps-add-url"), "not a link");
    await user.click(screen.getByTestId("apps-add-check"));
    expect(await screen.findByTestId("apps-add-error")).toHaveTextContent("Apps come only from GitHub (raw.githubusercontent.com) or jsDelivr at a commit.");
    // As typed: only a host of the list gets https:// put before it.
    expect(asked).toEqual([{ url: "not a link" }]);
  });

  it("a version a store removed stays stopped: Run anyway in its details opens it, Keep it stopped does not", async () => {
    const onOpen = vi.fn();
    const removed = installed({ run: { status: "removed", by: [{ store: "k", name: "Ghostly", reason: "Malware", at: 1 }] } });
    const { user } = renderApp(<InstalledAppDialog app={removed} onClose={() => {}} onOpen={onOpen} />);
    expect(await screen.findByTestId("app-run-line")).toHaveTextContent("Removed by Ghostly: Malware");
    expect(screen.queryByTestId("app-open")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("app-keep-stopped"));
    expect(onOpen).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("app-run-anyway"));
    expect(onOpen).toHaveBeenCalledWith(removed, { runAnyway: true });
  });

  it("a revoked version has no Run anyway and no Open", async () => {
    renderApp(<InstalledAppDialog app={installed({ run: { status: "revoked" } })} onClose={() => {}} onOpen={() => {}} />);
    expect(await screen.findByTestId("app-run-line")).toHaveTextContent("Its publisher revoked this version.");
    expect(screen.queryByTestId("app-run-anyway")).not.toBeInTheDocument();
    expect(screen.queryByTestId("app-open")).not.toBeInTheDocument();
    expect(screen.getByTestId("app-keep-stopped")).toBeInTheDocument();
  });

  it("the card of a removed app says so when Open is refused, and Run anyway opens it in that chat", async () => {
    fakeEngine.on("appList", () => [installed()]);
    const opener = vi.fn(async (_ref: string, _linkId: string | null, options?: { runAnyway?: boolean }) => {
      if (!options?.runAnyway) throw new Error("removed: Removed by Ghostly: Malware");
    });
    setAppOpener(opener);
    const { user } = renderApp(<MessageBubble message={cardMessage()} peerPubKey="peer" contactName="Ana" linkId="link-1" />);
    act(() => fakeEngine.update({ links: [ana(true)] }));
    await user.click(await screen.findByTestId("app-card-open"));
    expect(await screen.findByTestId("app-card-error")).toHaveTextContent("A store you added removed this app.");
    expect(opener).toHaveBeenLastCalledWith(REF, "link-1", { runAnyway: false });
    await user.click(screen.getByTestId("app-card-run-anyway"));
    expect(opener).toHaveBeenLastCalledWith(REF, "link-1", { runAnyway: true });
    await waitFor(() => expect(screen.queryByTestId("app-card-error")).not.toBeInTheDocument());
    expect(screen.queryByTestId("app-card-run-anyway")).not.toBeInTheDocument();
  });

  it("a revoked app's card offers no Run anyway", async () => {
    fakeEngine.on("appList", () => [installed()]);
    setAppOpener(vi.fn(async () => { throw new Error("revoked: Its publisher revoked this version"); }));
    const { user } = renderApp(<MessageBubble message={cardMessage()} peerPubKey="peer" contactName="Ana" linkId="link-1" />);
    act(() => fakeEngine.update({ links: [ana(true)] }));
    await user.click(await screen.findByTestId("app-card-open"));
    expect(await screen.findByTestId("app-card-error")).toHaveTextContent("Its publisher revoked this version.");
    expect(screen.queryByTestId("app-card-run-anyway")).not.toBeInTheDocument();
  });

  it("a store read again that removed an installed app stops it on the page at once", async () => {
    const removedRun = { status: "removed" as const, by: [{ store: "s", name: "Ghostly", reason: "Malware", at: 1 }] };
    let refreshed = false;
    const store = () => ({ key: "s", fingerprint: "abcd efgh ijkl mnop", url: "https://raw.githubusercontent.com/g/s/HEAD/ghostly-store.json", preloaded: false,
      name: "Ghostly", kind: "curated" as const, sequence: refreshed ? 2 : 1, expires: 2_000_000_000, expired: false, fetchedAt: 1,
      apps: [{ ref: REF, sequence: 7, digest: DIGEST, urls: [URL_], title: "Chess", tagline: "Play chess with a contact" }],
      removed: refreshed ? [{ ref: REF, digest: DIGEST, reason: "Malware", at: 1 }] : [] });
    fakeEngine.on("appList", () => [installed(refreshed ? { run: removedRun } : {})]).on("appStoreList", () => [store()]).on("appCheckUpdates", () => [])
      .on("appStoreRefresh", () => { refreshed = true; return [store()]; });
    const { user } = renderApp(<Apps />, { route: "/apps" });
    const row = await screen.findByTestId("installed-app");
    expect(within(row).getByTestId("installed-app-open")).toBeInTheDocument();
    await user.click(screen.getByTestId("app-store-refresh"));
    await waitFor(() => expect(within(row).getByTestId("installed-app-hint")).toHaveTextContent("Stopped"));
    expect(within(row).queryByTestId("installed-app-open")).not.toBeInTheDocument();
  });

  it("reads the installed apps again after the engine's own update check, so a stopped version shows stopped", async () => {
    let run: InstalledAppView["run"] = { status: "ok" };
    fakeEngine.on("appList", () => [installed({ run })]).on("appStoreList", () => []).on("appCheckUpdates", () => []);
    renderApp(<Apps />, { route: "/apps" });
    expect(await screen.findByTestId("installed-app-open")).toBeInTheDocument();
    // The scheduled check (no page asked for it) found the version removed: the engine says a check ran.
    run = { status: "removed", by: [{ store: "k", name: "Ghostly", reason: "Malware", at: 1 }] };
    act(() => fakeEngine.emit({ kind: "apps-checked" }));
    expect(await screen.findByTestId("installed-app-hint")).toHaveTextContent("Stopped");
    expect(screen.queryByTestId("installed-app-open")).not.toBeInTheDocument();
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

  it("an installed app's row is named for its details and describes its version and line, so a stopped app says so to a screen reader", async () => {
    const run = { status: "removed" as const, by: [{ store: "s", name: "Ghostly", reason: "Malware", at: 1 }] };
    fakeEngine.on("appList", () => [installed({ run })]).on("appStoreList", () => []).on("appCheckUpdates", () => []);
    renderApp(<Apps />, { route: "/apps" });
    const details = within(await screen.findByTestId("installed-app")).getByRole("button", { name: "Chess: details" });
    expect(details).toHaveAccessibleDescription("1.2.0 Stopped");
  });

  it("the focus goes to Add once an uninstalled app's row or a removed store's block is gone, not lost on the page", async () => {
    let apps = [installed()];
    let stores = [{ key: "s", fingerprint: "abcd efgh ijkl mnop", url: "https://raw.githubusercontent.com/g/s/HEAD/ghostly-store.json", preloaded: false,
      name: "Ghostly", kind: "curated" as const, sequence: 1, expires: 2_000_000_000, expired: false, fetchedAt: 1, apps: [], removed: [] }];
    fakeEngine.on("appList", () => apps).on("appStoreList", () => stores).on("appCheckUpdates", () => [])
      .on("appUninstall", () => { apps = []; return undefined; }).on("appStoreRemove", () => { stores = []; return undefined; });
    const { user } = renderApp(<Apps />, { route: "/apps" });
    await user.click(within(await screen.findByTestId("installed-app")).getByRole("button", { name: "Chess: details" }));
    await user.click(screen.getByTestId("app-uninstall-open"));
    await user.click(screen.getByTestId("app-uninstall-confirm"));
    await waitFor(() => expect(screen.queryByTestId("installed-app")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("apps-add")).toHaveFocus());

    screen.getByTestId("app-store-remove").focus();
    await user.click(screen.getByTestId("app-store-remove"));
    await waitFor(() => expect(screen.queryByTestId("app-store")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("apps-add")).toHaveFocus());
  });

  it("the focus goes back to Add when Add closes, and to the new app's Open after Install from a pasted link", async () => {
    let apps: InstalledAppView[] = [];
    fakeEngine.on("appList", () => apps).on("appStoreList", () => []).on("appCheckUpdates", () => [])
      .on("appPreview", () => preview()).on("appInstall", () => { apps = [installed()]; return installed(); });
    const { user } = renderApp(<Apps />, { route: "/apps" });
    const add = await screen.findByTestId("apps-add");
    add.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("apps-add-url")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("apps-add-dialog")).not.toBeInTheDocument();
    expect(add).toHaveFocus();

    await user.keyboard("{Enter}");
    await user.type(screen.getByTestId("apps-add-url"), `${URL_}{Enter}`);
    await user.click(await screen.findByTestId("app-install-confirm"));
    await waitFor(() => expect(screen.getByTestId("installed-app-open")).toHaveFocus());
  });

  it("gives each text a publisher or a store wrote its own direction, so in a right-to-left app an English title is cut at its end", async () => {
    const title = "Chess Tournament Organizer for Friends!";
    const unread = "https://raw.githubusercontent.com/g/unread/HEAD/ghostly-store.json";
    fakeEngine.on("appList", () => [installed({ title, description: "Chess for two." })])
      .on("appStoreList", () => [
        { key: "s", fingerprint: "abcd efgh ijkl mnop", url: "https://raw.githubusercontent.com/g/s/HEAD/ghostly-store.json", preloaded: false,
          name: "Ghostly", kind: "curated", sequence: 1, expires: 2_000_000_000, expired: false, fetchedAt: 1,
          apps: [{ ref: `${KEY}/other`, sequence: 1, digest: DIGEST, urls: [URL_], title: "Snake", tagline: "Eat, grow." }], removed: [] },
        { key: "u", fingerprint: "qrst uvwx yz12 3456", url: unread, preloaded: true, sequence: 0, expired: false, apps: [], removed: [] },
      ]).on("appCheckUpdates", () => []);
    const { user } = renderApp(<Apps />, { route: "/apps" });
    const row = await screen.findByTestId("installed-app");
    expect(within(row).getByText(title)).toHaveAttribute("dir", "auto");
    expect(within(row).getByTestId("installed-app-hint")).toHaveAttribute("dir", "auto");
    expect(screen.getByText(unread)).toHaveAttribute("dir", "auto");
    expect(screen.getByText("Ghostly")).toHaveAttribute("dir", "auto");
    await user.click(screen.getByText("Ghostly"));
    expect(screen.getByText("Snake")).toHaveAttribute("dir", "auto");
    expect(screen.getByText("Eat, grow.")).toHaveAttribute("dir", "auto");
    await user.click(within(row).getByRole("button", { name: `${title}: details` }));
    const details = screen.getByTestId("app-details");
    expect(within(details).getByRole("heading", { name: title })).toHaveAttribute("dir", "auto");
    expect(within(details).getByText("Play chess with a contact")).toHaveAttribute("dir", "auto");
    expect(within(details).getByText("Chess for two.")).toHaveAttribute("dir", "auto");
  });

  it("a store at the format's limit of 4096 listings opens with its first 50, Show more for the next, and a search over them all", async () => {
    const apps = Array.from({ length: 4096 }, (_, i) => ({ ref: `${KEY}/app${i}`, sequence: 1, digest: DIGEST, urls: [URL_], title: `App ${i}`, tagline: `Tagline ${i}` }));
    fakeEngine.on("appList", () => [installed({ ref: `${KEY}/app4000` })]).on("appCheckUpdates", () => [])
      .on("appStoreList", () => [{ key: "s", fingerprint: "abcd efgh ijkl mnop", url: "https://raw.githubusercontent.com/g/s/HEAD/ghostly-store.json", preloaded: false,
        name: "Big", kind: "indexed", sequence: 1, expires: 2_000_000_000, expired: false, fetchedAt: 1, apps,
        removed: [{ ref: `${KEY}/app4001`, digest: DIGEST, reason: "Malware", at: 1 }] }]);
    const { user } = renderApp(<Apps />, { route: "/apps" });
    await user.click(await screen.findByText("Big"));
    const listing = screen.getByTestId("app-store-listing");
    expect(within(listing).getAllByTestId("app-listing")).toHaveLength(50);
    await user.click(screen.getByTestId("app-store-more"));
    expect(within(listing).getAllByTestId("app-listing")).toHaveLength(100);
    expect(screen.getByTestId("app-store-more")).toHaveTextContent("Show more (3996)");

    await user.type(screen.getByTestId("app-store-filter"), "App 400");
    const rows = within(listing).getAllByTestId("app-listing");
    expect(rows.map((r) => r.getAttribute("data-ref"))).toEqual([400, ...Array.from({ length: 10 }, (_, i) => 4000 + i)].map((i) => `${KEY}/app${i}`));
    expect(screen.queryByTestId("app-store-more")).not.toBeInTheDocument();
    // An installed listing and a removed one still say so.
    expect(rows[1]).toHaveTextContent("Installed");
    expect(rows[2]).toHaveTextContent("Malware");
    expect(within(rows[2]).queryByTestId("app-listing-install")).not.toBeInTheDocument();
    await user.clear(screen.getByTestId("app-store-filter"));
    await user.type(screen.getByTestId("app-store-filter"), "nothing like it");
    expect(within(listing).queryByTestId("app-listing")).not.toBeInTheDocument();
    expect(listing).toHaveTextContent("No app in this store matches.");

    // Closed and opened again: the first page, not every listing shown before.
    await user.clear(screen.getByTestId("app-store-filter"));
    await user.click(screen.getByText("Big"));
    await user.click(screen.getByText("Big"));
    expect(within(screen.getByTestId("app-store-listing")).getAllByTestId("app-listing")).toHaveLength(50);
  });

  it("gives the card's title its own direction", async () => {
    fakeEngine.on("appList", () => []);
    renderApp(<MessageBubble message={cardMessage()} peerPubKey="peer" contactName="Ana" linkId="link-1" />);
    expect(await screen.findByTestId("app-card-title")).toHaveAttribute("dir", "auto");
  });
});

