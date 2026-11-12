import { act, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appCardId, statusCardText, type AppCard } from "@ghostly/core";
import type { AppPreview, AppStorePreview, AppStoreSummary, BuiltInAppOffer, InstalledAppView } from "@ghostly/browser/engine/apps";
import type { LinkView } from "@ghostly/browser/shared/types";
import { MessageBubble } from "../../components/MessageBubble";
import { MessageInput } from "../../components/MessageInput";
import { AccountBar } from "../../components/AccountBar";
import { MobileTabBar } from "../../components/MobileTabBar";
import { ChatServicesDialog } from "../../components/ChatServicesDialog";
import { InstalledAppDialog, AppInstallDialog } from "../../components/apps/AppInstallDialog";
import { Apps } from "../../pages/Apps";
import { AddAppDialog } from "../../components/apps/AddAppDialog";
import { AppChatPicker } from "../../components/apps/AppChatPicker";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { Settings } from "../../pages/Settings";
import { registerRunningApp, setAppOpener, setLinkedFiles } from "../../lib/apps/open";
import { appsAvailable, forgetAppsAvailable, webKitAppLeak } from "../../lib/apps/flag";
import { forgetInstalledApps, useInstalledApps } from "../../lib/apps/installed";
import type { ChatMessage } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { shownInName } from "../labelInName";
import { renderApp } from "../render";

// covers: apps.page, apps.chat.card, apps.built-in

// The runner page's header, asked once by the real check: answered here, never fetched in a test.
vi.mock("../../lib/apps/runnerCheck", () => ({ runnerAvailable: vi.fn(async () => true), runnerPolicy: vi.fn(async () => true), forgetRunnerCheck: () => {}, isRunnerPolicy: () => true }));
// The build's flag, off here whatever APPS_ENABLED says: "with the apps flag on" turns it on as the e2e build does.
vi.mock("@ghostly/browser/shared/features", async (importOriginal) =>
  ({ ...(await importOriginal<typeof import("@ghostly/browser/shared/features")>()), APPS_ENABLED: false }));

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const REF = `${KEY}/chess`;
const DIGEST = "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4";
const STAGE = `${DIGEST}\nscreen`;
const URL_ = "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp";
const CARD: AppCard = { kind: "app", id: appCardId(REF), ref: REF, digest: DIGEST, sequence: 7, title: "Chess", version: "1.2.0", url: URL_, opened: true };

const installed = (patch: Partial<InstalledAppView> = {}): InstalledAppView => ({
  ref: REF, name: "chess", publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", title: "Chess", tagline: "Play chess with a contact",
  version: "1.2.0", sequence: 7, digest: DIGEST, permissions: ["chat"], view: "chat", from: URL_, icon: false, installedAt: 1, updatedAt: 1,
  run: { status: "ok" }, listedBy: [], unknownPublisher: true, ...patch,
});
const preview = (patch: Partial<AppPreview> = {}): AppPreview => ({
  digest: DIGEST, ref: REF, publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", from: URL_, icon: null, install: "new", asks: ["chat"],
  run: { status: "ok" }, listedBy: [], unknownPublisher: true, stage: STAGE,
  manifest: { ghostlyApp: 1, publisher: KEY, name: "chess", version: "1.2.0", sequence: 7, kind: "mini-app", title: "Chess", tagline: "Play chess with a contact",
    entry: "index.html", permissions: ["chat"], runtime: { host: ">=1.2", clients: ["web", "desktop"] }, license: "MIT", files: [] },
  ...patch,
});
/** An installed app's row: named with its title, version and line as it shows them, then "details". */
const detailsOf = (title: string) => new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} .*: details$`);

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

  it("draws a card from its own data and asks nothing of any host until Join", async () => {
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
    // The installed apps and the built-in ones offered here: two reads of the engine's own records, no request.
    await waitFor(() => expect(appCalls()).toEqual(["appBuiltIns", "appList"]));
    expect(fetches).toEqual([]);

    // The card invites the person into the app their contact opened: it says Join, never Install.
    expect(within(card).getByTestId("app-card-install")).toHaveTextContent(/^Join$/);
    expect(card).not.toHaveTextContent(/install/i);
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
    expect(fakeEngine.callsTo("appInstall")).toEqual([{ stage: STAGE, digest: DIGEST, grant: ["chat"], asks: ["chat"] }]);
    // Installing from a card opens it in that chat.
    await waitFor(() => expect(opener).toHaveBeenCalledWith(REF, "link-1", { runAnyway: false }));
    expect(fetches).toEqual([]);
  });

  it("while Install and open runs, the screen's Cancel, Escape and its backdrop do not close it: no Cancel the app opens after all", async () => {
    let finish: () => void = () => {};
    fakeEngine.on("appList", () => []).on("appPreview", () => preview())
      .on("appInstall", () => new Promise<InstalledAppView>((resolve) => { finish = () => resolve(installed()); }));
    const opener = vi.fn(async () => {});
    setAppOpener(opener);
    const { user } = renderApp(<MessageBubble message={cardMessage()} peerPubKey="peer" contactName="Ana" linkId="link-1" />);
    act(() => fakeEngine.update({ links: [ana(true)] }));
    await user.click(await screen.findByTestId("app-card-install"));
    const screenEl = await screen.findByTestId("app-install");
    await user.click(await within(screenEl).findByRole("button", { name: "Install and open" }));
    expect(within(screenEl).getByTestId("app-install-confirm")).toHaveAttribute("aria-busy", "true");
    const cancel = within(screenEl).getByRole("button", { name: "Cancel" });
    expect(cancel).toBeDisabled();
    await user.click(cancel);
    await user.keyboard("{Escape}");
    await user.pointer({ keys: "[MouseLeft]", target: screenEl.parentElement! });
    expect(screen.getByTestId("app-install")).toBeInTheDocument();
    await act(async () => finish());
    // It installs and opens as it said it would, and the screen closes.
    await waitFor(() => expect(opener).toHaveBeenCalledWith(REF, "link-1", { runAnyway: false }));
    await waitFor(() => expect(screen.queryByTestId("app-install")).not.toBeInTheDocument());
  });

  it("while Uninstall runs, its question's Cancel, Escape and backdrop do not take it back to an app that is about to go", async () => {
    let finish: () => void = () => {};
    fakeEngine.on("appList", () => []).on("appUninstall", () => new Promise<void>((resolve) => { finish = resolve; }));
    const onClose = vi.fn(), onUninstalled = vi.fn();
    const { user } = renderApp(<InstalledAppDialog app={installed()} onClose={onClose} onOpen={() => {}} onUninstalled={onUninstalled} />);
    await user.click(await screen.findByTestId("app-uninstall-open"));
    const question = screen.getByTestId("app-uninstall");
    await user.click(within(question).getByTestId("app-uninstall-confirm"));
    expect(within(question).getByTestId("app-uninstall-confirm")).toHaveAttribute("aria-busy", "true");
    const cancel = within(question).getByRole("button", { name: "Cancel" });
    expect(cancel).toBeDisabled();
    await user.click(cancel);
    await user.keyboard("{Escape}");
    await user.pointer({ keys: "[MouseLeft]", target: question.parentElement! });
    expect(screen.getByTestId("app-uninstall")).toBeInTheDocument();
    expect(screen.queryByTestId("app-details")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onUninstalled).toHaveBeenCalledTimes(1);
  });

  it("Escape on the Uninstall question does what its Cancel does: back to the app's screen, on Uninstall", async () => {
    const onClose = vi.fn();
    const { user } = renderApp(<InstalledAppDialog app={installed()} onClose={onClose} onOpen={() => {}} />);
    await user.click(await screen.findByTestId("app-uninstall-open"));
    expect(screen.getByTestId("app-uninstall")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("app-uninstall")).not.toBeInTheDocument();
    expect(screen.getByTestId("app-uninstall-open")).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
    expect(fakeEngine.callsTo("appUninstall")).toEqual([]);
  });

  it("while a waiting Update runs, Escape and the backdrop do not close the app's screen", async () => {
    let finish: () => void = () => {};
    fakeEngine.on("appList", () => []).on("appUpdateAccept", () => new Promise<InstalledAppView>((resolve) => { finish = () => resolve(installed()); }));
    const onClose = vi.fn();
    const { user } = renderApp(<InstalledAppDialog onClose={onClose} onOpen={() => {}}
      app={installed({ pending: { sequence: 8, version: "1.3.0", added: ["name"] } })} />);
    await user.click(await screen.findByTestId("app-update-accept"));
    const details = screen.getByTestId("app-details");
    await user.keyboard("{Escape}");
    await user.pointer({ keys: "[MouseLeft]", target: details.parentElement! });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish());
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("while a waiting Update runs, Open, Keep it stopped and Run anyway do not leave the screen, and a failed update shows why", async () => {
    const removedRun = { status: "removed" as const, by: [{ store: "k", name: "Ghostly", reason: "Malware", at: 1 }] };
    for (const run of [undefined, removedRun]) {
      let fail: (e: Error) => void = () => {};
      fakeEngine.on("appList", () => []).on("appUpdateAccept", () => new Promise<InstalledAppView>((_, reject) => { fail = reject; }));
      const onClose = vi.fn(), onOpen = vi.fn();
      const { user, unmount } = renderApp(<InstalledAppDialog onClose={onClose} onOpen={onOpen}
        app={installed({ pending: { sequence: 8, version: "1.3.0", added: ["name"] }, ...(run && { run }) })} />);
      await user.click(await screen.findByTestId("app-update-accept"));
      const leaving = run ? ["app-run-anyway", "app-keep-stopped"] : ["app-open"];
      for (const id of leaving) await user.click(screen.getByTestId(id));
      expect(onClose).not.toHaveBeenCalled();
      expect(onOpen).not.toHaveBeenCalled();
      for (const id of [...leaving, "app-uninstall-open"]) expect(screen.getByTestId(id)).toBeDisabled();
      expect(screen.getByTestId("app-details")).toBeInTheDocument();
      await act(async () => fail(new Error("The host answered 503")));
      expect(await screen.findByTestId("app-details-error")).toBeInTheDocument();
      // Once the update is over, they work again.
      await user.click(screen.getByTestId(leaving[0]!));
      expect(onClose).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it("while Add store runs, the store's Cancel, Escape and the backdrop do not close Add: no Cancel the store is added after all", async () => {
    const LINK = "https://raw.githubusercontent.com/ana/store/HEAD/ghostly-store.json";
    let finish: () => void = () => {};
    fakeEngine.on("appStorePreview", ({ url }) => ({ url, key: "k", name: "Ana's store", kind: "curated", sequence: 1, apps: 1, fingerprint: "abcd efgh", expires: 9e9, expired: false }))
      .on("appStoreAdd", () => new Promise<AppStoreSummary>((resolve) => { finish = () => resolve({} as AppStoreSummary); }));
    const onClose = vi.fn(), onStoreAdded = vi.fn();
    const { user } = renderApp(<AddAppDialog onClose={onClose} onStoreAdded={onStoreAdded} />);
    await user.type(screen.getByTestId("apps-add-url"), LINK);
    await user.click(screen.getByTestId("apps-add-check"));
    const store = await screen.findByTestId("apps-add-store");
    await user.click(within(store).getByTestId("apps-add-store-confirm"));
    const cancel = within(store).getByRole("button", { name: "Cancel" });
    expect(cancel).toBeDisabled();
    await user.click(cancel);
    await user.keyboard("{Escape}");
    await user.pointer({ keys: "[MouseLeft]", target: screen.getByTestId("apps-add-dialog").parentElement! });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onStoreAdded).toHaveBeenCalledTimes(1);
  });

  it("while Add store runs, the link can be neither edited nor checked again: the question and its Cancel stay as they were", async () => {
    const LINK = "https://raw.githubusercontent.com/ana/store/HEAD/ghostly-store.json";
    let finish: () => void = () => {};
    fakeEngine.on("appStorePreview", ({ url }) => ({ url, key: "k", name: "Ana's store", kind: "curated", sequence: 1, apps: 1, fingerprint: "abcd efgh", expires: 9e9, expired: false }))
      .on("appStoreAdd", () => new Promise<AppStoreSummary>((resolve) => { finish = () => resolve({} as AppStoreSummary); }));
    const onClose = vi.fn(), onStoreAdded = vi.fn();
    const { user } = renderApp(<AddAppDialog onClose={onClose} onStoreAdded={onStoreAdded} />);
    const field = screen.getByTestId("apps-add-url");
    await user.type(field, LINK);
    await user.click(screen.getByTestId("apps-add-check"));
    await user.click(within(await screen.findByTestId("apps-add-store")).getByTestId("apps-add-store-confirm"));
    // An edit dropped the question and the busy state with it: Cancel and Escape then closed Add while the store was added.
    await user.type(field, "x");
    await user.type(field, "{Enter}");
    expect(field).toHaveValue(LINK);
    expect(fakeEngine.callsTo("appStorePreview")).toHaveLength(1);
    expect(within(screen.getByTestId("apps-add-store")).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onStoreAdded).toHaveBeenCalledTimes(1);
  });

  it("names a contact with no name as the chat does, not Anonymous, on the card and its install screen", async () => {
    fakeEngine.on("appList", () => []).on("appPreview", () => preview());
    // The chat of a contact with no name passes none (Chat.tsx), and calls them "Contact · <the start of their key>".
    const { user } = renderApp(<MessageBubble message={cardMessage()} peerPubKey="peer" peerNick="" contactName="" linkId="link-1" />);
    act(() => fakeEngine.update({ links: [ana(true)] }));
    const card = await screen.findByTestId("app-card");
    expect(card).toHaveTextContent("Contact · peer opened it here");
    expect(card).not.toHaveTextContent("Anonymous");
    await user.click(within(card).getByTestId("app-card-install"));
    expect(await within(await screen.findByTestId("app-install")).findByTestId("app-sent-by")).toHaveTextContent("Sent by Contact · peer");
  });

  it("a long contact name is cut alone on the card, never the words around it, in English and in Japanese", async () => {
    fakeEngine.on("appList", () => []);
    // A nickname at its 20-letter limit: on a 320 px phone the one cut line lost "opened it here".
    const long = "Maximiliano Albuquer";
    for (const [language, words] of [["en", " opened it here"], ["ja", " がここで開きました"]] as const) {
      const view = renderApp(<MessageBubble message={cardMessage()} peerPubKey="peer" contactName={long} linkId="link-1" />, { language });
      const line = within(await screen.findByTestId("app-card")).getByText((_, el) => el?.tagName === "P" && el.textContent === `${long}${words}`);
      expect(line).toHaveClass("flex", "min-w-0", "overflow-hidden", "whitespace-nowrap");
      expect(line).not.toHaveClass("truncate");
      const name = within(line).getByTestId("app-card-name");
      expect(name).toHaveTextContent(long);
      expect(name).toHaveClass("min-w-0", "truncate");
      const rest = [...line.children].filter((node) => node !== name);
      expect(rest.map((node) => node.textContent).join("")).toBe(words);
      for (const node of rest) expect(node).toHaveClass("shrink-0");
      view.unmount();
    }
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
    // The card's name for a screen reader is the same app's, not Ana's word for it.
    expect(shown.closest("[data-message-card]")).toHaveAttribute("aria-label", "App: Private Notes");
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
    expect(fakeEngine.callsTo("appUpdateAccept")).toEqual([{ ref: REF, sequence: 8, added: ["name"] }]);
  });

  it("Update on a screen drawn before the check found a newer update grants nothing it did not list, and shows the newer one", async () => {
    let list = [installed({ pending: { sequence: 8, version: "1.3.0", added: ["name"] } })];
    fakeEngine.on("appList", () => list).on("appUpdateAccept", (p: { sequence?: number; added?: string[] }) => {
      // As the engine does: the update waiting now, unless it is not the one the screen listed.
      const waits = list[0]!.pending!;
      if (p.sequence !== undefined && p.sequence !== waits.sequence) throw new Error("permissions-changed: Another update waits now, which adds name, internet; look at it again");
      list = [installed({ version: waits.version, sequence: waits.sequence, permissions: ["chat", ...waits.added] })];
      return list[0]!;
    });
    function Shown() {
      const shown = useInstalledApps(true)?.find((a) => a.ref === REF);
      return shown ? <InstalledAppDialog app={shown} onClose={() => {}} onOpen={() => {}} /> : null;
    }
    const { user } = renderApp(<Shown />);
    const update = await screen.findByTestId("app-update");
    expect(within(update).getByTestId("app-permissions")).not.toHaveTextContent("Use the internet");
    // The check swaps in 1.4.0, which adds internet as well; the page has not read the list again.
    list = [installed({ pending: { sequence: 9, version: "1.4.0", added: ["name", "internet"] } })];
    await user.click(screen.getByTestId("app-update-accept"));
    expect(await screen.findByTestId("app-details-error")).toHaveTextContent("This update now adds other permissions");
    expect(list[0]!.permissions).not.toContain("internet");
    await waitFor(() => expect(screen.getByTestId("app-update")).toHaveTextContent("Version 1.4.0 is ready."));
    expect(within(screen.getByTestId("app-update")).getByTestId("app-permissions")).toHaveTextContent("Use the internet");
    await user.click(screen.getByTestId("app-update-accept"));
    await waitFor(() => expect(list[0]!.permissions).toEqual(["chat", "name", "internet"]));
    expect(fakeEngine.callsTo("appUpdateAccept")).toEqual([{ ref: REF, sequence: 8, added: ["name"] }, { ref: REF, sequence: 9, added: ["name", "internet"] }]);
  });

  it("keeps what an installed app may do now on its screen while an update that asks for more waits", async () => {
    fakeEngine.on("appList", () => []);
    renderApp(<InstalledAppDialog onClose={() => {}} onOpen={() => {}}
      app={installed({ permissions: ["chat", "name"], pending: { sequence: 8, version: "1.3.0", added: ["internet"] } })} />);
    const update = await screen.findByTestId("app-update");
    const lists = screen.getAllByTestId("app-permissions");
    expect(lists).toHaveLength(2);
    const now = lists.find((list) => !update.contains(list))!;
    expect(now).toHaveTextContent("It can");
    expect([...now.querySelectorAll("[data-permission]")].map((li) => li.getAttribute("data-permission"))).toEqual(["storage", "chat", "name"]);
    expect([...within(update).getByTestId("app-permissions").querySelectorAll("[data-permission]")].map((li) => li.getAttribute("data-permission"))).toEqual(["internet"]);
  });

  it("keeps what an installed app may do now on its screen while an update that asks for more waits", async () => {
    fakeEngine.on("appList", () => []);
    renderApp(<InstalledAppDialog onClose={() => {}} onOpen={() => {}}
      app={installed({ permissions: ["chat", "name"], pending: { sequence: 8, version: "1.3.0", added: ["internet"] } })} />);
    const update = await screen.findByTestId("app-update");
    const lists = screen.getAllByTestId("app-permissions");
    expect(lists).toHaveLength(2);
    const now = lists.find((list) => !update.contains(list))!;
    expect(now).toHaveTextContent("It can");
    expect([...now.querySelectorAll("[data-permission]")].map((li) => li.getAttribute("data-permission"))).toEqual(["storage", "chat", "name"]);
    expect([...within(update).getByTestId("app-permissions").querySelectorAll("[data-permission]")].map((li) => li.getAttribute("data-permission"))).toEqual(["internet"]);
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

  it("Install of a screen whose app asks for more since it opened shows what it asks now, and grants only that", async () => {
    const all = ["chat", "name"] as AppPreview["asks"];
    const manifest = { ...preview().manifest, permissions: all };
    let shown = preview({ install: "update", asks: [], manifest });
    fakeEngine.on("appPreview", () => shown).on("appInstall", (params) => {
      const { asks } = params as { asks: string[] };
      if (asks.length < all.length) throw new Error("permissions-changed: This install now asks for chat, name; look at it again");
      return installed({ permissions: all });
    });
    const onInstalled = vi.fn();
    const { user } = renderApp(<AppInstallDialog source={{ url: URL_ }} onClose={() => {}} onInstalled={onInstalled} />);
    expect(await screen.findByTestId("app-install-confirm")).toHaveTextContent("Update");
    expect(screen.queryByTestId("app-permissions")).not.toBeInTheDocument();
    // Uninstalled meanwhile: the screen read again is a new install's, every permission listed.
    shown = preview({ install: "new", asks: all, manifest });
    await user.click(screen.getByTestId("app-install-confirm"));
    expect(await screen.findByTestId("app-install-error")).toHaveTextContent("What this app asks for changed. Look at it again before you install it.");
    expect(screen.getByTestId("app-install-error").firstElementChild).toHaveClass("text-danger-ink");
    expect(onInstalled).not.toHaveBeenCalled();
    expect(screen.getByTestId("app-permissions")).toHaveTextContent("See your name in this chat");
    expect(screen.getByTestId("app-install-confirm")).toHaveTextContent("Install");
    await user.click(screen.getByTestId("app-install-confirm"));
    await waitFor(() => expect(onInstalled).toHaveBeenCalled());
    expect(fakeEngine.callsTo("appInstall")).toEqual([{ stage: STAGE, digest: DIGEST, grant: all, asks: [] }, { stage: STAGE, digest: DIGEST, grant: all, asks: all }]);
  });

  it("an update refused for what it asks, whose read again fails, says why and takes no Update until Try again reads it", async () => {
    const all = ["chat", "name"] as AppPreview["asks"];
    const manifest = { ...preview().manifest, permissions: all };
    let read: () => AppPreview = () => preview({ install: "update", asks: [], manifest });
    fakeEngine.on("appPreview", () => read()).on("appInstall", (params) => {
      const { asks } = params as { asks: string[] };
      if (asks.length < 1) throw new Error("permissions-changed: This install now asks for name; look at it again");
      return installed({ permissions: all });
    });
    const onInstalled = vi.fn();
    const { user } = renderApp(<AppInstallDialog source={{ url: URL_ }} onClose={() => {}} onInstalled={onInstalled} />);
    const confirm = await screen.findByTestId("app-install-confirm");
    expect(confirm).toHaveTextContent("Update");
    read = () => { throw new Error("offline: no network"); };
    await user.click(confirm);
    expect(await screen.findByTestId("app-install-error")).toHaveTextContent("You are offline.");
    expect(screen.getByTestId("app-install-error")).not.toHaveTextContent("Look at them again");
    // The screen still shows what it asked before: another press would be refused the same way.
    expect(screen.getByTestId("app-install-confirm")).toBeDisabled();
    const retry = screen.getByTestId("app-install-retry");
    expect(retry).toHaveTextContent("Try again");
    expect(retry).toHaveFocus();
    await user.click(screen.getByTestId("app-install-confirm"));
    expect(fakeEngine.callsTo("appInstall")).toHaveLength(1);
    // Still offline: said again, Update still off.
    await user.click(retry);
    await waitFor(() => expect(fakeEngine.callsTo("appPreview")).toHaveLength(3));
    expect(await screen.findByTestId("app-install-error")).toHaveTextContent("You are offline.");
    expect(screen.getByTestId("app-install-confirm")).toBeDisabled();
    // Back online: what it asks now, and Update grants that.
    read = () => preview({ install: "update", asks: ["name"], manifest });
    await user.click(screen.getByTestId("app-install-retry"));
    expect(await screen.findByTestId("app-permissions")).toHaveTextContent("See your name in this chat");
    expect(screen.getByTestId("app-install-error")).toHaveTextContent("This update now adds other permissions. Look at them again before you update.");
    expect(screen.queryByTestId("app-install-retry")).not.toBeInTheDocument();
    expect(screen.getByTestId("app-install-confirm")).toBeEnabled();
    expect(screen.getByTestId("app-install-confirm")).toHaveFocus();
    await user.click(screen.getByTestId("app-install-confirm"));
    await waitFor(() => expect(onInstalled).toHaveBeenCalled());
    expect(fakeEngine.callsTo("appInstall")).toEqual([{ stage: STAGE, digest: DIGEST, grant: all, asks: [] }, { stage: STAGE, digest: DIGEST, grant: all, asks: ["name"] }]);
  });

  it("a new install refused for what it asks, whose read again fails, says the read's error, and Try again shows the install's words", async () => {
    const all = ["chat", "name"] as AppPreview["asks"];
    const manifest = { ...preview().manifest, permissions: all };
    let read: () => AppPreview = () => preview({ install: "new", asks: ["chat"], manifest });
    fakeEngine.on("appPreview", () => read()).on("appInstall", (params) => {
      const { asks } = params as { asks: string[] };
      if (asks.length < all.length) throw new Error("permissions-changed: This install now asks for chat, name; look at it again");
      return installed({ permissions: all });
    });
    const onInstalled = vi.fn();
    const { user } = renderApp(<AppInstallDialog source={{ url: URL_ }} onClose={() => {}} onInstalled={onInstalled} />);
    const confirm = await screen.findByTestId("app-install-confirm");
    expect(confirm).toHaveTextContent("Install");
    read = () => { throw new Error("network: fetch failed"); };
    await user.click(confirm);
    expect(await screen.findByTestId("app-install-error")).toHaveTextContent("Could not reach the host.");
    expect(screen.getByTestId("app-install-error")).not.toHaveTextContent("update");
    expect(screen.getByTestId("app-install-confirm")).toBeDisabled();
    read = () => preview({ install: "new", asks: all, manifest });
    await user.click(screen.getByTestId("app-install-retry"));
    expect(await screen.findByTestId("app-install-error")).toHaveTextContent("What this app asks for changed. Look at it again before you install it.");
    expect(screen.getByTestId("app-permissions")).toHaveTextContent("See your name in this chat");
    expect(screen.getByTestId("app-install-confirm")).toHaveTextContent("Install");
    expect(screen.getByTestId("app-install-confirm")).toBeEnabled();
    await user.click(screen.getByTestId("app-install-confirm"));
    await waitFor(() => expect(onInstalled).toHaveBeenCalled());
    expect(fakeEngine.callsTo("appInstall")).toEqual([{ stage: STAGE, digest: DIGEST, grant: all, asks: ["chat"] }, { stage: STAGE, digest: DIGEST, grant: all, asks: all }]);
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

  it("says what the files permission lets the app do, never its bare name, here and on an update that adds it", async () => {
    const files: AppPreview["asks"] = ["chat", "files"];
    fakeEngine.on("appPreview", () => preview({ asks: files, manifest: { ...preview().manifest, permissions: files } }));
    const { user, unmount } = renderApp(<AppInstallDialog source={{ url: URL_ }} onClose={() => {}} />);
    const line = await screen.findByTestId("app-permission-files");
    expect(line).toHaveTextContent("Read the files and folders you pick, and share them with your contact in the chat");
    await user.click(within(line).getByTestId("app-permission-files-info"));
    expect(screen.getByTestId("app-permission-files-text")).toHaveTextContent("Only what you pick");
    unmount();

    fakeEngine.on("appUpdateAccept", () => installed()).on("appList", () => []);
    renderApp(<InstalledAppDialog onClose={() => {}} onOpen={() => {}}
      app={installed({ pending: { sequence: 8, version: "1.3.0", added: ["files"] } })} />);
    const update = await screen.findByTestId("app-update");
    expect(within(update).getByTestId("app-permission-files")).toHaveTextContent("Read the files and folders you pick");
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

  it("a link with a query (a private repository's file, with its token) says to publish the app in a public repository, and is not read as a store", async () => {
    const tried: string[] = [];
    const refused = "private-link: This link carries a query or a fragment";
    fakeEngine.on("appPreview", () => { tried.push("app"); throw new Error(refused); })
      .on("appStorePreview", () => { tried.push("store"); throw new Error(refused); });
    const { user } = renderApp(<AddAppDialog onClose={() => {}} onStoreAdded={() => {}} />);
    await user.type(screen.getByTestId("apps-add-url"), "https://raw.githubusercontent.com/ana/chess/main/dist?token=GHSAT0");
    await user.click(screen.getByTestId("apps-add-check"));
    expect(await screen.findByTestId("apps-add-error")).toHaveTextContent("Publish the app in a public repository and paste that link.");
    expect(tried).toEqual(["app"]);
  });

  it("Add: a host answering 500 says try again later; a store link holding no valid store says so, its refusal behind the ⓘ", async () => {
    fakeEngine.on("appStorePreview", () => { throw new Error("status: The host answered 500"); });
    const first = renderApp(<AddAppDialog onClose={() => {}} onStoreAdded={() => {}} />);
    await first.user.type(screen.getByTestId("apps-add-url"), "https://raw.githubusercontent.com/ana/store/main/ghostly-store.json");
    await first.user.click(screen.getByTestId("apps-add-check"));
    expect(await screen.findByTestId("apps-add-error")).toHaveTextContent("The host had a problem (error 500). Try again later.");
    first.unmount();

    fakeEngine.on("appStorePreview", () => { throw new Error("not-json: This is not a store Ghostly can read"); });
    const { user } = renderApp(<AddAppDialog onClose={() => {}} onStoreAdded={() => {}} />);
    await user.type(screen.getByTestId("apps-add-url"), "https://raw.githubusercontent.com/ana/store/main/ghostly-store.json");
    await user.click(screen.getByTestId("apps-add-check"));
    expect(await screen.findByTestId("apps-add-error-title")).toHaveTextContent("That link holds no valid store.");
    expect(screen.getByTestId("apps-add-error")).not.toHaveTextContent("install");
    await user.click(screen.getByTestId("apps-add-error-info"));
    expect(screen.getByTestId("apps-add-error-details")).toHaveTextContent("not-json: This is not a store Ghostly can read");
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

  it("a link with http:// to a host of the list is read as its https:// link; to any other host it goes as typed", async () => {
    const asked: unknown[] = [];
    fakeEngine.on("appPreview", (params) => {
      asked.push(params);
      if (!(params as { url: string }).url.startsWith("https://")) throw new Error("host: Apps are read only from raw.githubusercontent.com, or from cdn.jsdelivr.net at a commit, over HTTPS");
      return preview();
    });
    const first = renderApp(<AddAppDialog onClose={() => {}} onStoreAdded={() => {}} />);
    await first.user.type(screen.getByTestId("apps-add-url"), "HTTP://GitHub.com/ana/chess");
    await first.user.click(screen.getByTestId("apps-add-check"));
    await waitFor(() => expect(asked).toEqual([{ url: "https://GitHub.com/ana/chess" }]));
    expect(screen.queryByTestId("apps-add-error")).not.toBeInTheDocument();
    first.unmount();

    asked.length = 0;
    const { user } = renderApp(<AddAppDialog onClose={() => {}} onStoreAdded={() => {}} />);
    await user.type(screen.getByTestId("apps-add-url"), "http://example.com/github.com/app.ghostlyapp");
    await user.click(screen.getByTestId("apps-add-check"));
    expect(await screen.findByTestId("apps-add-error")).toHaveTextContent("Apps come only from GitHub (raw.githubusercontent.com) or jsDelivr at a commit.");
    expect(asked).toEqual([{ url: "http://example.com/github.com/app.ghostlyapp" }]);
  });

  it("Enter in the field while Check runs reads the link once: the busy Check takes no second press", async () => {
    const asked: unknown[] = [];
    fakeEngine.on("appPreview", (params) => { asked.push(params); return new Promise<AppPreview>(() => {}); });
    const { user } = renderApp(<AddAppDialog onClose={() => {}} onStoreAdded={() => {}} />);
    await user.type(screen.getByTestId("apps-add-url"), "https://github.com/ana/chess{Enter}");
    await waitFor(() => expect(screen.getByTestId("apps-add-check")).toHaveAttribute("aria-busy", "true"));
    await user.type(screen.getByTestId("apps-add-url"), "{Enter}");
    await user.click(screen.getByTestId("apps-add-check"));
    expect(asked).toEqual([{ url: "https://github.com/ana/chess" }]);
  });

  it("a link edited while Check runs drops the old link's answer: no store or app of it shows, and Add store adds the new one", async () => {
    const OLD = "https://raw.githubusercontent.com/ana/old/HEAD/ghostly-store.json";
    const NEW = "https://raw.githubusercontent.com/ana/new/HEAD/ghostly-store.json";
    const answers = new Map<string, (found: AppStorePreview) => void>();
    let answerApp!: (found: AppPreview) => void;
    const added: unknown[] = [];
    fakeEngine.on("appStorePreview", ({ url }) => new Promise((resolve) => answers.set(url, resolve)))
      .on("appStoreAdd", (params) => { added.push(params); return {} as AppStoreSummary; })
      .on("appPreview", () => new Promise((resolve) => { answerApp = resolve; }));
    const store = (url: string, name: string): AppStorePreview => ({ url, key: name, name, kind: "curated", sequence: 1, apps: 1, fingerprint: "abcd efgh", expires: 9e9, expired: false });
    const { user } = renderApp(<AddAppDialog onClose={() => {}} onStoreAdded={() => {}} />);
    const field = screen.getByTestId("apps-add-url");
    await user.type(field, OLD);
    await user.click(screen.getByTestId("apps-add-check"));
    // The person fixes the link before the old one answers.
    await user.clear(field);
    await user.type(field, NEW);
    await act(async () => answers.get(OLD)!(store(OLD, "Old store")));
    expect(screen.queryByTestId("apps-add-store")).not.toBeInTheDocument();
    expect(screen.getByTestId("apps-add-check")).toHaveTextContent("Check");

    await user.click(screen.getByTestId("apps-add-check"));
    await act(async () => answers.get(NEW)!(store(NEW, "New store")));
    expect(await screen.findByTestId("apps-add-store")).toHaveTextContent("New store");
    await user.click(screen.getByTestId("apps-add-store-confirm"));
    expect(added).toEqual([{ url: NEW, key: "New store" }]);

    // An app link edited while it is read: its install screen does not open for the link the field no longer holds.
    await user.clear(field);
    await user.type(field, "https://github.com/ana/chess");
    await user.click(screen.getByTestId("apps-add-check"));
    await user.type(field, "-two");
    await act(async () => answerApp(preview()));
    expect(screen.queryByTestId("app-install")).not.toBeInTheDocument();
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
    // The card read the list before the store's removal: Open is refused, and the list read again says so.
    let run: InstalledAppView["run"] = { status: "ok" };
    fakeEngine.on("appList", () => [installed({ run })]);
    const opener = vi.fn(async (_ref: string, _linkId: string | null, options?: { runAnyway?: boolean }) => {
      if (!options?.runAnyway) throw new Error("removed: Removed by Ghostly: Malware");
    });
    setAppOpener(opener);
    const { user } = renderApp(<MessageBubble message={cardMessage()} peerPubKey="peer" contactName="Ana" linkId="link-1" />);
    act(() => fakeEngine.update({ links: [ana(true)] }));
    const open = await screen.findByTestId("app-card-open");
    run = { status: "removed", by: [{ store: "k", name: "Ghostly", reason: "Malware", at: 1 }] };
    await user.click(open);
    expect(await screen.findByTestId("app-card-error")).toHaveTextContent("A store you added removed this app.");
    expect(screen.getByTestId("app-card-check")).toHaveTextContent(/^Stopped$/);
    expect(opener).toHaveBeenLastCalledWith(REF, "link-1", { runAnyway: false });
    await user.click(screen.getByTestId("app-card-run-anyway"));
    expect(opener).toHaveBeenLastCalledWith(REF, "link-1", { runAnyway: true });
    await waitFor(() => expect(screen.queryByTestId("app-card-error")).not.toBeInTheDocument());
  });

  it("the card's Open shows it is opening while the app's files are fetched, and a second press opens nothing more", async () => {
    fakeEngine.on("appList", () => [installed({ run: { status: "needs-files" } })]);
    let finish: () => void = () => {};
    const opener = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    setAppOpener(opener);
    const { user } = renderApp(<MessageBubble message={cardMessage()} peerPubKey="peer" contactName="Ana" linkId="link-1" />);
    act(() => fakeEngine.update({ links: [ana(true)] }));
    const open = await screen.findByTestId("app-card-open");
    await user.click(open);
    expect(open).toHaveAttribute("aria-busy", "true");
    await user.click(open);
    expect(opener).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await waitFor(() => expect(open).not.toHaveAttribute("aria-busy"));
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

  it("a store added that removed an installed app stops it on the page at once, and a running one is stopped", async () => {
    const removedRun = { status: "removed" as const, by: [{ store: "s", name: "Ghostly", reason: "Malware", at: 1 }] };
    const LINK = "https://raw.githubusercontent.com/g/s/HEAD/ghostly-store.json";
    let added = false;
    const store = { key: "s", fingerprint: "abcd efgh ijkl mnop", url: LINK, preloaded: false, name: "Ghostly", kind: "curated" as const, sequence: 1,
      expires: 2_000_000_000, expired: false, fetchedAt: 1, apps: [{ ref: REF, sequence: 7, digest: DIGEST, urls: [URL_], title: "Chess", tagline: "Play chess with a contact" }],
      removed: [{ ref: REF, digest: DIGEST, reason: "Malware", at: 1 }] };
    fakeEngine.on("appList", () => [installed(added ? { run: removedRun } : {})]).on("appStoreList", () => (added ? [store] : [])).on("appCheckUpdates", () => [])
      .on("appStorePreview", ({ url }) => ({ url, key: "s", name: "Ghostly", kind: "curated", sequence: 1, apps: 1, fingerprint: "abcd efgh ijkl mnop", expires: 9e9, expired: false }))
      .on("appStoreAdd", () => { added = true; return store; });
    const takeDown = vi.fn();
    // Chess runs in a chat: the store's removal stops it there too, as after Refresh or an update check.
    const unregister = registerRunningApp({ ref: REF, digest: DIGEST, runAnyway: false, takeDown, stop: () => {} });
    try {
      const { user } = renderApp(<Apps />, { route: "/apps" });
      const row = await screen.findByTestId("installed-app");
      expect(within(row).getByTestId("installed-app-open")).toBeInTheDocument();
      await user.click(screen.getByTestId("apps-add"));
      await user.type(screen.getByTestId("apps-add-url"), LINK);
      await user.click(screen.getByTestId("apps-add-check"));
      await user.click(within(await screen.findByTestId("apps-add-store")).getByTestId("apps-add-store-confirm"));
      await waitFor(() => expect(within(row).getByTestId("installed-app-hint")).toHaveTextContent("Stopped"));
      expect(within(row).queryByTestId("installed-app-open")).not.toBeInTheDocument();
      expect(takeDown).toHaveBeenCalledWith({ why: "removed", store: "Ghostly" });
    } finally { unregister(); }
  });

  it("Refresh shows it is working until the store is read: a turning ring, busy, no second click", async () => {
    let finish: () => void = () => {};
    const store = { key: "s", fingerprint: "abcd efgh ijkl mnop", url: "https://raw.githubusercontent.com/g/s/HEAD/ghostly-store.json", preloaded: false,
      name: "Ghostly", kind: "curated" as const, sequence: 1, expires: 2_000_000_000, expired: false, fetchedAt: 1, apps: [], removed: [] };
    fakeEngine.on("appList", () => []).on("appStoreList", () => [store]).on("appCheckUpdates", () => [])
      .on("appStoreRefresh", () => new Promise<typeof store[]>((resolve) => { finish = () => resolve([store]); }));
    const { user } = renderApp(<Apps />, { route: "/apps" });
    const refresh = await screen.findByTestId("app-store-refresh");
    await user.click(refresh);
    expect(refresh).toHaveAttribute("aria-busy", "true");
    expect(refresh).toHaveAttribute("aria-disabled", "true");
    await user.click(refresh);
    expect(fakeEngine.callsTo("appStoreRefresh")).toHaveLength(1);
    expect(within(refresh).getByTestId("button-spinner")).toBeInTheDocument();
    expect(refresh).toHaveTextContent("Refresh");
    await act(async () => { finish(); });
    await waitFor(() => expect(refresh).not.toHaveAttribute("aria-busy"));
    expect(within(refresh).queryByTestId("button-spinner")).not.toBeInTheDocument();
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

  it("Open on an app whose files here are damaged says so, and the page then offers Get its files", async () => {
    let run: InstalledAppView["run"] = { status: "ok" };
    fakeEngine.on("appList", () => [installed({ view: "full", run })]).on("appStoreList", () => []).on("appCheckUpdates", () => [])
      .on("appFetchFiles", () => ({ status: "ok" as const }));
    // The engine dropped the files it found damaged and told every page to read the list again.
    setAppOpener(vi.fn(async () => {
      run = { status: "needs-files" };
      fakeEngine.emit({ kind: "apps-checked" });
      throw new Error("damaged: This app's stored files do not match what was installed");
    }));
    const { user } = renderApp(<Apps />, { route: "/apps" });
    await user.click(await screen.findByTestId("installed-app-open"));
    expect(await screen.findByText("Its files on this device are damaged. Get its files again.")).toBeInTheDocument();
    expect(screen.queryByText("Ghostly won't install it")).not.toBeInTheDocument();
    expect(await screen.findByTestId("installed-app-hint")).toHaveTextContent("Needs its files");
    await user.click(screen.getByRole("button", { name: detailsOf("Chess") }));
    run = { status: "ok" };
    await user.click(await screen.findByTestId("app-fetch-files"));
    expect(fakeEngine.callsTo("appFetchFiles")).toHaveLength(1);
    expect(await screen.findByTestId("app-open")).toBeInTheDocument();
  });

  it("Get its files that finds no copy says so on the screen, and offline says offline", async () => {
    fakeEngine.on("appList", () => [installed({ view: "full", run: { status: "needs-files" } })]).on("appStoreList", () => []).on("appCheckUpdates", () => [])
      .on("appFetchFiles", () => ({ status: "needs-files" as const }));
    const { user } = renderApp(<Apps />, { route: "/apps" });
    await user.click(await screen.findByRole("button", { name: detailsOf("Chess") }));
    await user.click(await screen.findByTestId("app-fetch-files"));
    expect(await screen.findByTestId("app-details-error")).toHaveTextContent("Couldn't get its files: none of the links it came from has this version now");
    expect(screen.getByTestId("app-fetch-files")).toBeInTheDocument();
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    try {
      await user.click(screen.getByTestId("app-fetch-files"));
      await waitFor(() => expect(screen.getByTestId("app-details-error")).toHaveTextContent("You are offline."));
    } finally { online.mockRestore(); }
    expect(fakeEngine.callsTo("appFetchFiles")).toHaveLength(2);
  });

  it("lists installed apps and stores; uninstall offers an export first", async () => {
    fakeEngine.on("appList", () => [installed({ unknownPublisher: false, listedBy: [{ key: "s", name: "Ghostly", kind: "curated" }] })])
      .on("appStoreList", () => [{ key: "s", fingerprint: "abcd efgh ijkl mnop", url: "https://raw.githubusercontent.com/g/s/HEAD/ghostly-store.json", preloaded: false,
        name: "Ghostly", kind: "curated", sequence: 1, expires: 2_000_000_000, expired: false, fetchedAt: 1,
        apps: [{ ref: REF, sequence: 7, digest: DIGEST, urls: [URL_], title: "Chess", tagline: "Play chess with a contact" }], removed: [] }])
      .on("appCheckUpdates", () => []).on("appDataExportText", () => []).on("appUninstall", () => undefined);
    const { user } = renderApp(<Apps />, { route: "/apps" });
    const row = await screen.findByTestId("installed-app");
    expect(row).toHaveTextContent("Chess");
    expect(screen.getByTestId("app-store")).toHaveTextContent("Ghostly");
    expect(screen.getByTestId("app-store")).toHaveTextContent("Curated");
    expect(appCalls()).toContain("appCheckUpdates");
    await user.click(within(row).getByRole("button", { name: detailsOf("Chess") }));
    expect(screen.getByTestId("app-store-line")).toHaveTextContent("In Ghostly");
    await user.click(screen.getByTestId("app-uninstall-open"));
    expect(screen.getByTestId("app-uninstall")).toHaveTextContent("Export the data first");
    // The files people picked for it go with it; the files themselves are not touched.
    const forgot: string[] = [];
    setLinkedFiles({ pick: async () => [], list: async () => [], read: async () => new Uint8Array(0), forget: async (ref, id) => { forgot.push(`${ref} ${id}`); } });
    await user.click(screen.getByTestId("app-uninstall-confirm"));
    expect(fakeEngine.callsTo("appUninstall")).toEqual([{ ref: REF }]);
    await waitFor(() => expect(forgot).toEqual([`${REF} all`]));
    setLinkedFiles(null);
    expect(fetches).toEqual([]);
  });

  it("an installed app's row is named with all it shows, then details, so a stopped app says so to a screen reader", async () => {
    const run = { status: "removed" as const, by: [{ store: "s", name: "Ghostly", reason: "Malware", at: 1 }] };
    fakeEngine.on("appList", () => [installed({ run })]).on("appStoreList", () => []).on("appCheckUpdates", () => []);
    renderApp(<Apps />, { route: "/apps" });
    const details = within(await screen.findByTestId("installed-app")).getByRole("button", { name: "Chess 1.2.0 Stopped: details" });
    expect(details).toHaveAccessibleName(shownInName(details));
  });

  it("an installed app's row holds its title, version and line in its name, in the order it shows them (Label in Name)", async () => {
    fakeEngine.on("appList", () => [installed()]).on("appStoreList", () => []).on("appCheckUpdates", () => []);
    renderApp(<Apps />, { route: "/apps" });
    const details = within(await screen.findByTestId("installed-app")).getByRole("button", { name: /^Chess 1\.2\.0 / });
    expect(details).toHaveAccessibleName("Chess 1.2.0 Unknown publisher · Play chess with a contact: details");
    expect(details).toHaveAccessibleName(shownInName(details));
  });

  it("names each row's buttons with its app or store, so a screen reader tells two stores' Removes apart", async () => {
    const UNREAD = "https://raw.githubusercontent.com/g/s/HEAD/ghostly-store.json";
    fakeEngine.on("appList", () => [installed()]).on("appCheckUpdates", () => []).on("appStoreList", () => [
      { key: "u", fingerprint: "abcd efgh ijkl mnop", url: UNREAD, preloaded: true, sequence: 0, expired: false, apps: [], removed: [] },
      { key: "s", fingerprint: "qrst uvwx yz12 3456", url: "https://example.com/hunt.json", preloaded: false, name: "Hunt", kind: "curated", sequence: 1,
        expires: 2_000_000_000, expired: false, fetchedAt: 1, apps: [{ ref: `${KEY}/snake`, sequence: 1, digest: DIGEST, urls: [URL_], title: "Snake", tagline: "Eat, grow." }], removed: [] },
    ]);
    renderApp(<Apps />, { route: "/apps" });
    expect(await screen.findByTestId("installed-app-open")).toHaveAccessibleName("Open Chess");
    const [unread, hunt] = await screen.findAllByTestId("app-store");
    expect(within(unread!).getByTestId("app-store-refresh")).toHaveAccessibleName(`Read ${UNREAD}`);
    expect(within(unread!).getByTestId("app-store-remove")).toHaveAccessibleName(`Remove ${UNREAD}`);
    expect(within(hunt!).getByTestId("app-store-refresh")).toHaveAccessibleName("Refresh Hunt");
    expect(within(hunt!).getByTestId("app-store-remove")).toHaveAccessibleName("Remove Hunt");
    expect(within(hunt!).getByTestId("app-listing-install")).toHaveAccessibleName("Install Snake");
  });

  it("the focus goes to Add once an uninstalled app's row or a removed store's block is gone, not lost on the page", async () => {
    let apps = [installed()];
    let stores = [{ key: "s", fingerprint: "abcd efgh ijkl mnop", url: "https://raw.githubusercontent.com/g/s/HEAD/ghostly-store.json", preloaded: false,
      name: "Ghostly", kind: "curated" as const, sequence: 1, expires: 2_000_000_000, expired: false, fetchedAt: 1, apps: [], removed: [] }];
    fakeEngine.on("appList", () => apps).on("appStoreList", () => stores).on("appCheckUpdates", () => [])
      .on("appUninstall", () => { apps = []; return undefined; }).on("appStoreRemove", () => { stores = []; return undefined; });
    const { user } = renderApp(<Apps />, { route: "/apps" });
    await user.click(within(await screen.findByTestId("installed-app")).getByRole("button", { name: detailsOf("Chess") }));
    await user.click(screen.getByTestId("app-uninstall-open"));
    await user.click(screen.getByTestId("app-uninstall-confirm"));
    await waitFor(() => expect(screen.queryByTestId("installed-app")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("apps-add")).toHaveFocus());

    screen.getByTestId("app-store-remove").focus();
    await user.click(screen.getByTestId("app-store-remove"));
    await user.click(screen.getByTestId("app-store-remove-confirm"));
    await waitFor(() => expect(screen.queryByTestId("app-store")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("apps-add")).toHaveFocus());
  });

  it("a store's Remove asks first, names the installed apps it lists, and Cancel gives the focus back to Remove", async () => {
    let stores = [{ key: "s", fingerprint: "abcd efgh ijkl mnop", url: "https://raw.githubusercontent.com/g/s/HEAD/ghostly-store.json", preloaded: false,
      name: "Hunt", kind: "curated" as const, sequence: 1, expires: 2_000_000_000, expired: false, fetchedAt: 1,
      apps: [{ ref: REF, sequence: 7, digest: DIGEST, urls: [URL_], title: "Chess", tagline: "Play chess with a contact" },
        { ref: `${KEY}/other`, sequence: 1, digest: DIGEST, urls: [URL_], title: "Snake", tagline: "Eat, grow." }], removed: [] }];
    fakeEngine.on("appList", () => [installed({ unknownPublisher: false, listedBy: [{ key: "s", name: "Hunt", kind: "curated" }] })])
      .on("appStoreList", () => stores).on("appCheckUpdates", () => []).on("appStoreRemove", () => { stores = []; return undefined; });
    const { user } = renderApp(<Apps />, { route: "/apps" });
    const remove = await screen.findByTestId("app-store-remove");
    remove.focus();
    await user.keyboard("{Enter}");
    // One press removes nothing: the question takes the place of the buttons, and Enter again does not remove.
    const question = screen.getByTestId("app-store-remove-question");
    expect(question).toHaveTextContent("Remove Hunt?");
    expect(question).toHaveTextContent("Chess");
    expect(question).not.toHaveTextContent("Snake");
    expect(question).toHaveTextContent("updates or takedowns");
    expect(fakeEngine.callsTo("appStoreRemove")).toEqual([]);
    expect(within(question).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("app-store-remove-question")).not.toBeInTheDocument();
    expect(screen.getByTestId("app-store-remove")).toHaveFocus();
    expect(fakeEngine.callsTo("appStoreRemove")).toEqual([]);

    // Escape is Cancel too; the second Remove is the one that removes.
    await user.keyboard("{Enter}");
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("app-store-remove")).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.click(screen.getByTestId("app-store-remove-confirm"));
    expect(fakeEngine.callsTo("appStoreRemove")).toEqual([{ key: "s" }]);
    await waitFor(() => expect(screen.queryByTestId("app-store")).not.toBeInTheDocument());
  });

  it("a store that lists none of the installed apps says only how to get it back", async () => {
    fakeEngine.on("appList", () => []).on("appStoreList", () => [{ key: "s", fingerprint: "abcd efgh ijkl mnop", url: "https://raw.githubusercontent.com/g/s/HEAD/ghostly-store.json",
      preloaded: false, name: "Hunt", kind: "curated", sequence: 1, expires: 2_000_000_000, expired: false, fetchedAt: 1, apps: [], removed: [] }])
      .on("appCheckUpdates", () => []);
    const { user } = renderApp(<Apps />, { route: "/apps" });
    await user.click(await screen.findByTestId("app-store-remove"));
    const question = screen.getByTestId("app-store-remove-question");
    expect(question).toHaveTextContent("Remove Hunt?");
    expect(question).not.toHaveTextContent("updates or takedowns");
    expect(question).toHaveTextContent("its link");
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
    expect(within(within(row).getByTestId("installed-app-hint")).getByText("Play chess with a contact")).toHaveAttribute("dir", "auto");
    expect(screen.getByText(unread)).toHaveAttribute("dir", "auto");
    expect(screen.getByText("Ghostly")).toHaveAttribute("dir", "auto");
    expect(screen.getByText("Snake")).toHaveAttribute("dir", "auto");
    expect(screen.getByText("Eat, grow.")).toHaveAttribute("dir", "auto");
    await user.click(within(row).getByRole("button", { name: detailsOf(title) }));
    const details = screen.getByTestId("app-details");
    expect(within(details).getByRole("heading", { name: title })).toHaveAttribute("dir", "auto");
    expect(within(details).getByText("Play chess with a contact")).toHaveAttribute("dir", "auto");
    expect(within(details).getByText("Chess for two.")).toHaveAttribute("dir", "auto");
  });

  // Aligned to their own start, an English title and tagline sat at the far left of their lines in Arabic, away from
  // the icon on the right; the row with the version went left to right after its title.
  it("lines up an app's title and tagline with the page, beside its icon, whatever their own direction", async () => {
    // Built in: its row's line is the tagline alone, not after "Unknown publisher ·".
    fakeEngine.on("appList", () => [installed({ builtIn: true })])
      .on("appStoreList", () => [
        { key: "s", fingerprint: "abcd efgh ijkl mnop", url: "https://raw.githubusercontent.com/g/s/HEAD/ghostly-store.json", preloaded: false,
          name: "Ghostly", kind: "curated", sequence: 1, expires: 2_000_000_000, expired: false, fetchedAt: 1,
          apps: [{ ref: `${KEY}/other`, sequence: 1, digest: DIGEST, urls: [URL_], title: "Snake", tagline: "Eat, grow." }], removed: [] },
      ]).on("appCheckUpdates", () => []);
    const { user } = renderApp(<Apps />, { route: "/apps" });
    const row = await screen.findByTestId("installed-app");
    const title = within(row).getByText("Chess");
    expect(title).toHaveAttribute("dir", "auto");
    expect(title.parentElement).not.toHaveAttribute("dir");
    expect(within(row).getByText("Play chess with a contact")).toHaveClass("text-match-parent");
    expect(screen.getByText("Snake")).toHaveClass("text-match-parent");
    expect(screen.getByText("Eat, grow.")).toHaveClass("text-match-parent");
    await user.click(within(row).getByRole("button", { name: detailsOf("Chess") }));
    const details = screen.getByTestId("app-details");
    expect(within(details).getByRole("heading", { name: "Chess" })).toHaveClass("text-match-parent");
    expect(within(details).getByText("Play chess with a contact")).toHaveClass("text-match-parent");
  });

  it("breaks a publisher's or a store's word with no space anywhere, so on a phone it pushes no screen sideways (nor cuts it off in Arabic)", async () => {
    // 80 characters, a tagline's limit, with nowhere to break: a link, a German compound, a name in Latin letters.
    const long = `https://example.com/${"a".repeat(60)}`;
    const wraps = (el: HTMLElement) => expect(el.className).toContain("[overflow-wrap:anywhere]");
    // A version has no space either, and a bundle allows 64 characters: "Version 1.0.0-rc.1+sha.…" ran 29 px off a 375 px phone.
    const version = `1.0.0-rc.1+sha.${"0123456789abcdef".repeat(3)}`;
    fakeEngine.on("appPreview", () => preview({ manifest: { ...preview().manifest, version, tagline: long, description: `${long}2` } }));
    const install = renderApp(<AppInstallDialog source={{ url: URL_ }} onClose={() => {}} />);
    const sheet = await screen.findByTestId("app-install");
    await within(sheet).findByText(long);
    wraps(within(sheet).getByText(long));
    wraps(within(sheet).getByText(`${long}2`));
    // Broken over lines in Arabic, its "-" was drawn at the left of "1.0.0": "-1.0.0". It keeps its own direction.
    expect(within(sheet).getByText(version)).toMatchObject({ tagName: "BDI", dir: "ltr" });
    expect(within(sheet).getByText(version).parentElement).toHaveTextContent(`Version ${version}`);
    wraps(within(sheet).getByText(version).parentElement!);
    install.unmount();

    const app = installed({ title: long, version, tagline: `${long}3`, description: `${long}4` });
    const details = renderApp(<InstalledAppDialog app={app} onClose={() => {}} onOpen={() => {}} />);
    wraps(within(screen.getByTestId("app-details")).getByText(`${long}3`));
    wraps(within(screen.getByTestId("app-details")).getByText(`${long}4`));
    expect(within(screen.getByTestId("app-details")).getByText(version)).toMatchObject({ tagName: "BDI", dir: "ltr" });
    wraps(within(screen.getByTestId("app-details")).getByText(version).parentElement!);
    await details.user.click(screen.getByTestId("app-uninstall-open"));
    wraps(within(screen.getByTestId("app-uninstall")).getByRole("heading"));
    details.unmount();
    // Open of a chat app: "Open <title> in a chat" ran off a 320 px phone with a 40-letter one-word title.
    const picker = renderApp(<AppChatPicker app={app} onClose={() => {}} />);
    wraps(within(screen.getByTestId("app-chat-picker")).getByRole("heading"));
    picker.unmount();

    fakeEngine.on("appStorePreview", () => ({ key: "s", fingerprint: "abcd efgh ijkl mnop", url: "https://raw.githubusercontent.com/g/s/HEAD/ghostly-store.json",
      name: `${long}5`, description: `${long}6`, kind: "curated", sequence: 1, expires: 2_000_000_000, expired: false, apps: 1 }));
    const { user } = renderApp(<AddAppDialog onClose={() => {}} onStoreAdded={() => {}} />);
    await user.type(screen.getByTestId("apps-add-url"), "https://raw.githubusercontent.com/g/s/HEAD/ghostly-store.json");
    await user.click(screen.getByTestId("apps-add-check"));
    const store = await screen.findByTestId("apps-add-store");
    wraps(within(store).getByText(`${long}5`));
    wraps(within(store).getByText(`${long}6`));
  });

  it("names a store not read yet by its whole link, over two lines on a phone, so the part after the host that names it shows", async () => {
    // Cut on one line, a 375 px phone showed "https://raw.githubusercontent.com/MiguelMedei…": two GitHub stores looked the same.
    const unread = "https://raw.githubusercontent.com/MiguelMedeiros/ghostly-store/main/index.json";
    fakeEngine.on("appList", () => []).on("appCheckUpdates", () => []).on("appStoreList", () => [
      { key: "u", fingerprint: "abcd efgh ijkl mnop", url: unread, preloaded: true, sequence: 0, expired: false, apps: [], removed: [] },
      { key: "s", fingerprint: "qrst uvwx yz12 3456", url: "https://example.com/hunt.json", preloaded: false, name: "Hunt", kind: "curated", sequence: 1,
        expires: 2_000_000_000, expired: false, fetchedAt: 1, apps: [], removed: [] },
    ]);
    renderApp(<Apps />, { route: "/apps" });
    const [first, named] = await screen.findAllByTestId("app-store");
    const link = within(first!).getByText(unread);
    expect(link).not.toHaveClass("truncate");
    expect(link.className).toContain("[overflow-wrap:anywhere]");
    // A store's own name stays on one line, cut at its end.
    expect(within(named!).getByText("Hunt")).toHaveClass("truncate");
  });

  it("a store's apps show without a tap when it is the only store or lists a few; a long list beside others waits behind its name, which says it opens", async () => {
    const listings = (n: number, name: string) => Array.from({ length: n }, (_, i) => ({ ref: `${KEY}/${name}${i}`, sequence: 1, digest: DIGEST, urls: [URL_], title: `${name} ${i}`, tagline: "A game" }));
    const store = (key: string, name: string, n: number) => ({ key, fingerprint: "abcd efgh ijkl mnop", url: `https://raw.githubusercontent.com/g/${key}/HEAD/ghostly-store.json`, preloaded: false,
      name, kind: "curated" as const, sequence: 1, expires: 2_000_000_000, expired: false, fetchedAt: 1, apps: listings(n, name), removed: [] });
    let stores = [store("s", "Ghostly Store", 1)];
    fakeEngine.on("appList", () => []).on("appCheckUpdates", () => []).on("appStoreList", () => stores);
    const first = renderApp(<Apps />, { route: "/apps" });
    // A new profile: the official store and its one app, whose Install is there to press.
    const only = await screen.findByTestId("app-store");
    expect(within(only).getByTestId("app-listing-install")).toBeInTheDocument();
    const name = within(only).getByRole("button", { name: /^Ghostly Store/ });
    expect(name).toHaveAttribute("aria-expanded", "true");
    expect(within(name).getByTestId("app-store-chevron")).toBeInTheDocument();
    // Closed by the person, it stays closed; and opens again.
    await first.user.click(name);
    expect(name).toHaveAttribute("aria-expanded", "false");
    expect(within(only).queryByTestId("app-listing")).not.toBeInTheDocument();
    await first.user.click(name);
    expect(within(only).getByTestId("app-listing-install")).toBeInTheDocument();
    first.unmount();

    stores = [store("s", "Ghostly Store", 1), store("b", "Big", 7), { ...store("u", "Unread", 0), fetchedAt: undefined as unknown as number }];
    const { user } = renderApp(<Apps />, { route: "/apps" });
    const [few, many, unread] = await screen.findAllByTestId("app-store");
    expect(within(few).getAllByTestId("app-listing")).toHaveLength(1);
    expect(within(many).queryByTestId("app-listing")).not.toBeInTheDocument();
    const opener = within(many).getByRole("button", { name: /^Big/ });
    expect(opener).toHaveAttribute("aria-expanded", "false");
    expect(within(opener).getByTestId("app-store-chevron")).toBeInTheDocument();
    await user.click(opener);
    expect(within(many).getAllByTestId("app-listing")).toHaveLength(7);
    // A store not read yet opens nothing, and says nothing of opening.
    expect(within(unread).queryByTestId("app-store-chevron")).not.toBeInTheDocument();
  });

  it("a store at the format's limit of 4096 listings opens with its first 50, Show more for the next, and a search over them all", async () => {
    const apps = Array.from({ length: 4096 }, (_, i) => ({ ref: `${KEY}/app${i}`, sequence: 1, digest: DIGEST, urls: [URL_], title: `App ${i}`, tagline: `Tagline ${i}` }));
    fakeEngine.on("appList", () => [installed({ ref: `${KEY}/app4000` })]).on("appCheckUpdates", () => [])
      .on("appStoreList", () => [{ key: "s", fingerprint: "abcd efgh ijkl mnop", url: "https://raw.githubusercontent.com/g/s/HEAD/ghostly-store.json", preloaded: false,
        name: "Big", kind: "indexed", sequence: 1, expires: 2_000_000_000, expired: false, fetchedAt: 1, apps,
        removed: [{ ref: `${KEY}/app4001`, digest: DIGEST, reason: "Malware", at: 1 }] }]);
    const { user } = renderApp(<Apps />, { route: "/apps" });
    const listing = await screen.findByTestId("app-store-listing");
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

  it("Show more from the keyboard moves the focus to the first listing it added, not to the page once the button is gone", async () => {
    const apps = Array.from({ length: 120 }, (_, i) => ({ ref: `${KEY}/app${i}`, sequence: 1, digest: DIGEST, urls: [URL_], title: `App ${i}`, tagline: `Tagline ${i}` }));
    fakeEngine.on("appList", () => [installed({ ref: `${KEY}/app100` })]).on("appCheckUpdates", () => [])
      .on("appStoreList", () => [{ key: "s", fingerprint: "abcd efgh ijkl mnop", url: "https://raw.githubusercontent.com/g/s/HEAD/ghostly-store.json", preloaded: false,
        name: "Big", kind: "indexed", sequence: 1, expires: 2_000_000_000, expired: false, fetchedAt: 1, apps, removed: [] }]);
    const { user } = renderApp(<Apps />, { route: "/apps" });
    await screen.findByTestId("app-store-listing");
    const rows = () => within(screen.getByTestId("app-store-listing")).getAllByTestId("app-listing");
    screen.getByTestId("app-store-more").focus();
    await user.keyboard("{Enter}");
    expect(rows()).toHaveLength(100);
    expect(within(rows()[50]).getByTestId("app-listing-install")).toHaveFocus();

    // The last page takes the button away. Its first listing is installed, with no button: the row itself takes the focus.
    screen.getByTestId("app-store-more").focus();
    await user.keyboard("{Enter}");
    expect(rows()).toHaveLength(120);
    expect(screen.queryByTestId("app-store-more")).not.toBeInTheDocument();
    expect(rows()[100]).toHaveFocus();
    expect(document.body).not.toHaveFocus();
  });

  it("a store's search says what it found once the typing settles: how many apps, or that none matches", async () => {
    const apps = Array.from({ length: 60 }, (_, i) => ({ ref: `${KEY}/app${i}`, sequence: 1, digest: DIGEST, urls: [URL_], title: `App ${i}`, tagline: `Tagline ${i}` }));
    fakeEngine.on("appList", () => []).on("appCheckUpdates", () => [])
      .on("appStoreList", () => [{ key: "s", fingerprint: "abcd efgh ijkl mnop", url: "https://raw.githubusercontent.com/g/s/HEAD/ghostly-store.json", preloaded: false,
        name: "Big", kind: "indexed", sequence: 1, expires: 2_000_000_000, expired: false, fetchedAt: 1, apps, removed: [] }]);
    const { user } = renderApp(<Apps />, { route: "/apps" });
    const filter = await screen.findByTestId("app-store-filter");
    const status = screen.getByTestId("app-store-found");
    expect(status).toHaveAttribute("role", "status");
    expect(status.textContent).toBe("");
    await user.type(filter, "App 5");
    expect(status.textContent).toBe("");
    await waitFor(() => expect(status).toHaveTextContent(/^11 apps$/));
    await user.type(filter, "9");
    await waitFor(() => expect(status).toHaveTextContent(/^1 app$/));
    await user.type(filter, "9");
    await waitFor(() => expect(status).toHaveTextContent(/^No app in this store matches\.$/));
    await user.clear(filter);
    await waitFor(() => expect(status.textContent).toBe(""));
  });

  it("a search goes away with its box: a store read again with 50 listings or fewer shows them all, and comes back with an empty box", async () => {
    let n = 60;
    const stores = (): AppStoreSummary[] => [{ key: "s", fingerprint: "abcd efgh ijkl mnop", url: "https://raw.githubusercontent.com/g/s/HEAD/ghostly-store.json", preloaded: false,
      name: "Big", kind: "indexed", sequence: 1, expires: 2_000_000_000, expired: false, fetchedAt: 1,
      apps: Array.from({ length: n }, (_, i) => ({ ref: `${KEY}/app${i}`, sequence: 1, digest: DIGEST, urls: [URL_], title: `App ${i}`, tagline: `Tagline ${i}` })), removed: [] }];
    fakeEngine.on("appList", () => []).on("appCheckUpdates", () => []).on("appStoreList", stores)
      .on("appStoreRefresh", () => { n = n === 60 ? 40 : 60; return stores(); });
    const { user } = renderApp(<Apps />, { route: "/apps" });
    await screen.findByTestId("app-store-listing");
    const rows = () => within(screen.getByTestId("app-store-listing")).queryAllByTestId("app-listing");
    await user.type(screen.getByTestId("app-store-filter"), "App 5");
    expect(rows()).toHaveLength(11);

    await user.click(screen.getByTestId("app-store-refresh"));
    await waitFor(() => expect(screen.queryByTestId("app-store-filter")).not.toBeInTheDocument());
    expect(rows()).toHaveLength(40);

    await user.click(screen.getByTestId("app-store-refresh"));
    expect(await screen.findByTestId("app-store-filter")).toHaveValue("");
    expect(rows()).toHaveLength(50);
  });

  // The row with the version goes the page's way, from the icon: in its title's direction, an English title sat at the
  // far left of an Arabic card.
  it("gives the card's title its own direction, and its row the page's", async () => {
    fakeEngine.on("appList", () => []);
    renderApp(<MessageBubble message={cardMessage()} peerPubKey="peer" contactName="Ana" linkId="link-1" />);
    const row = await screen.findByTestId("app-card-title");
    expect(row).not.toHaveAttribute("dir");
    expect(within(row).getByText(CARD.title)).toHaveAttribute("dir", "auto");
  });

  // A title may have 40 characters: cut as one text with the version, a phone showed no version at all.
  const LONG = "Schachweltmeisterschaftsvorbereitungsapp";
  const BETA = "1.2.0-beta.12";

  it("a card with a long title cuts the title alone and keeps the version whole after it, up to half the line", async () => {
    fakeEngine.on("appList", () => []);
    const card: AppCard = { ...CARD, title: LONG, version: BETA };
    renderApp(<MessageBubble message={cardMessage({ card, text: statusCardText(card) })} peerPubKey="peer" contactName="Ana" linkId="link-1" />);
    const title = await screen.findByTestId("app-card-title");
    expect(title).toHaveTextContent(`${LONG} ${BETA}`);
    expect(within(title).getByText(LONG)).toHaveClass("truncate", "min-w-0");
    // A longer version is cut at its end, past half the line, not the title (e2e/web/apps-long-version.spec.ts lays it out).
    expect(within(title).getByText(BETA)).toHaveClass("shrink-0", "max-w-[50%]", "truncate");
    expect(within(title).getByText(BETA)).toHaveAttribute("dir", "ltr");
    expect(within(title).getByText(LONG)).not.toContainElement(within(title).getByText(BETA));
  });

  it("an installed app with a long title cuts the title alone in its row and keeps the version whole after it, up to half the line", async () => {
    fakeEngine.on("appList", () => [installed({ title: LONG, version: BETA })]).on("appStoreList", () => []).on("appCheckUpdates", () => []);
    renderApp(<Apps />, { route: "/apps" });
    const row = await screen.findByTestId("installed-app");
    expect(within(row).getByText(LONG)).toHaveClass("truncate", "min-w-0");
    expect(within(row).getByText(BETA)).toHaveClass("shrink-0", "max-w-[50%]", "truncate");
    expect(within(row).getByText(BETA)).toHaveAttribute("dir", "ltr");
    expect(within(row).getByText(LONG)).not.toContainElement(within(row).getByText(BETA));
    // The version stays in the details button's name, right after the title, as the row shows it.
    expect(within(row).getByRole("button", { name: detailsOf(`${LONG} ${BETA}`) })).toBeInTheDocument();
  });
});

describe("an app that comes with Ghostly (WISP 1200 § Built-in apps)", () => {
  beforeEach(appsOn);

  const offer: BuiltInAppOffer = { ref: REF, publisher: KEY, name: "chess", fingerprint: "yz7m oxuc bd4u 8aqt", digest: DIGEST, url: URL_, title: "Chess", tagline: "Play chess with a contact" };
  /** The engine's two lists, as it keeps them: offered until installed or removed. */
  function engineWith(state: { installed: boolean; removed: boolean }) {
    return fakeEngine.on("appList", () => (state.installed ? [installed({ permissions: ["chat", "name"] })] : []))
      .on("appBuiltIns", () => (state.installed || state.removed ? [] : [offer]))
      .on("appStoreList", () => []).on("appCheckUpdates", () => [])
      .on("appPreview", () => preview({ carried: true, asks: ["chat", "name"], manifest: { ...preview().manifest, permissions: ["chat", "name"] } }))
      .on("appInstall", () => { state.installed = true; return installed({ permissions: ["chat", "name"] }); })
      .on("appUninstall", () => { state.removed = true; });
  }

  it("shows under Installed before anything of it is installed; Open asks what it may do, says nothing is downloaded, and Allow and open installs it", async () => {
    engineWith({ installed: false, removed: false });
    const { user } = renderApp(<Apps />, { route: "/apps" });
    const row = await screen.findByTestId("built-in-app");
    expect(row).toHaveTextContent("Chess");
    expect(within(row).getByTestId("built-in-app-hint")).toHaveTextContent("Comes with Ghostly · Play chess with a contact");
    expect(screen.queryByTestId("apps-none")).not.toBeInTheDocument();
    expect(screen.queryByTestId("installed-app")).not.toBeInTheDocument();
    // Listing it read nothing of the app: no preview, no install.
    expect(appCalls()).not.toContain("appPreview");

    await user.click(within(row).getByRole("button", { name: "Open Chess" }));
    const screenOf = await screen.findByTestId("app-install");
    expect(fakeEngine.callsTo("appPreview")).toEqual([{ builtIn: REF }]);
    await within(screenOf).findByTestId("app-carried-line");
    expect(within(screenOf).getByTestId("app-carried-line")).toHaveTextContent("Comes with Ghostly. Nothing is downloaded.");
    expect(within(screenOf).queryByTestId("app-ip-line")).not.toBeInTheDocument();
    expect(screenOf).toHaveTextContent("Talk to the same app on your contact's side");
    expect(screenOf).toHaveTextContent("See your name in this chat");
    expect(within(screenOf).getByTestId("app-install-confirm")).toHaveTextContent("Allow and open");
    expect(fakeEngine.callsTo("appInstall")).toEqual([]);

    await user.click(within(screenOf).getByTestId("app-install-confirm"));
    await waitFor(() => expect(fakeEngine.callsTo("appInstall")).toEqual([{ stage: STAGE, digest: DIGEST, grant: ["chat", "name"], asks: ["chat", "name"] }]));
    // Installed: its own row now, and (an app that runs in a chat) the question of which chat.
    expect(await screen.findByTestId("installed-app")).toHaveTextContent("Chess");
    expect(screen.queryByTestId("built-in-app")).not.toBeInTheDocument();
    expect(await screen.findByTestId("app-chat-picker")).toBeInTheDocument();
    expect(fetches).toEqual([]);
  });

  it("Allow and open puts the focus in the question of which chat, and back on the app's Open once it is closed", async () => {
    engineWith({ installed: false, removed: false });
    const { user } = renderApp(<Apps />, { route: "/apps" });
    await user.click(await screen.findByTestId("built-in-app-open"));
    const screenOf = await screen.findByTestId("app-install");
    await user.click(await within(screenOf).findByTestId("app-install-confirm"));
    const picker = await screen.findByTestId("app-chat-picker");
    await screen.findByTestId("installed-app");
    // The row behind the question never takes the focus from it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(picker).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("app-chat-picker")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("installed-app-open")).toHaveFocus());
  });

  it("its row's line keeps Ghostly's words apart from the tagline, which reads in its own direction (an English tagline in Arabic)", async () => {
    engineWith({ installed: false, removed: false });
    renderApp(<Apps />, { route: "/apps", language: "ar" });
    const hint = within(await screen.findByTestId("built-in-app")).getByTestId("built-in-app-hint");
    const tagline = within(hint).getByText("Play chess with a contact");
    expect(tagline).toHaveAttribute("dir", "auto");
    expect(tagline).toHaveClass("truncate");
    expect(tagline.textContent).toBe("Play chess with a contact");
    expect(hint).toHaveTextContent("يأتي مع Ghostly · Play chess with a contact");
  });

  it("Cancel on its first open installs nothing, and it stays offered", async () => {
    engineWith({ installed: false, removed: false });
    const { user } = renderApp(<Apps />, { route: "/apps" });
    await user.click(await screen.findByTestId("built-in-app-open"));
    const screenOf = await screen.findByTestId("app-install");
    await within(screenOf).findByTestId("app-install-confirm");
    await user.click(within(screenOf).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("app-install")).not.toBeInTheDocument();
    expect(fakeEngine.callsTo("appInstall")).toEqual([]);
    expect(screen.getByTestId("built-in-app")).toBeInTheDocument();
  });

  it("carries no stranger's warning on a profile that never read a store: not on its first open, its row or its details", async () => {
    // As the engine says it of a new profile: no curated store lists it (none was read), and the client's list pins it.
    let have = false;
    fakeEngine.on("appList", () => (have ? [installed({ builtIn: true })] : [])).on("appBuiltIns", () => (have ? [] : [offer]))
      .on("appStoreList", () => []).on("appCheckUpdates", () => [])
      .on("appPreview", () => preview({ carried: true })).on("appInstall", () => { have = true; return installed({ builtIn: true }); });
    const { user } = renderApp(<Apps />, { route: "/apps" });
    await user.click(await screen.findByTestId("built-in-app-open"));
    const screenOf = await screen.findByTestId("app-install");
    const name = await within(screenOf).findByTestId("app-publisher-name");
    expect(name).toHaveTextContent("Publisher");
    expect(name).not.toHaveClass("text-test-money-ink");
    expect(within(screenOf).getByTestId("app-publisher")).toHaveTextContent("yz7m oxuc bd4u 8aqt");
    expect(screenOf).not.toHaveTextContent("Unknown publisher");
    expect(screenOf).not.toHaveTextContent("Not in any of your stores");
    expect(within(screenOf).queryByTestId("app-store-line")).not.toBeInTheDocument();

    await user.click(within(screenOf).getByTestId("app-install-confirm"));
    const row = await screen.findByTestId("installed-app");
    expect(within(row).getByTestId("installed-app-hint")).toHaveTextContent(/^Play chess with a contact$/);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(within(row).getByRole("button", { name: detailsOf("Chess") }));
    const details = await screen.findByTestId("app-details");
    expect(within(details).getByTestId("app-publisher-name")).toHaveTextContent("Publisher");
    expect(within(details).getByTestId("app-store-line")).toHaveTextContent("Comes with Ghostly");
    expect(details).not.toHaveTextContent("Unknown publisher");
    expect(details).not.toHaveTextContent("Not in any of your stores");
  });

  it("a later version of it, which the client's list does not pin, is a stranger's again", async () => {
    fakeEngine.on("appList", () => [installed()]).on("appBuiltIns", () => []).on("appStoreList", () => []).on("appCheckUpdates", () => []);
    const { user } = renderApp(<Apps />, { route: "/apps" });
    const row = await screen.findByTestId("installed-app");
    expect(within(row).getByTestId("installed-app-hint")).toHaveTextContent("Unknown publisher · Play chess with a contact");
    // The tagline reads in its own direction, apart from Ghostly's words.
    expect(within(row).getByText("Play chess with a contact")).toHaveAttribute("dir", "auto");
    await user.click(within(row).getByRole("button", { name: detailsOf("Chess") }));
    const details = await screen.findByTestId("app-details");
    expect(within(details).getByTestId("app-publisher-name")).toHaveTextContent("Unknown publisher");
    expect(within(details).getByTestId("app-store-line")).toHaveTextContent("Not in any of your stores");
  });

  it("Remove asks first, as a store's Remove does: Cancel and Escape keep it and give the focus back to Remove", async () => {
    engineWith({ installed: false, removed: false });
    const { user } = renderApp(<Apps />, { route: "/apps" });
    const remove = within(await screen.findByTestId("built-in-app")).getByRole("button", { name: "Remove Chess" });
    remove.focus();
    await user.keyboard("{Enter}");
    // One press removes nothing: the question takes the place of the buttons, and Enter again does not remove.
    const question = screen.getByTestId("built-in-app-remove-question");
    expect(question).toHaveTextContent("Remove Chess?");
    expect(question).toHaveTextContent("not be offered again");
    expect(question).toHaveTextContent("from a store");
    expect(screen.queryByTestId("built-in-app-open")).not.toBeInTheDocument();
    expect(within(question).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("built-in-app-remove-question")).not.toBeInTheDocument();
    expect(screen.getByTestId("built-in-app-remove")).toHaveFocus();

    await user.keyboard("{Enter}");
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("built-in-app-remove-question")).not.toBeInTheDocument();
    expect(screen.getByTestId("built-in-app-remove")).toHaveFocus();
    expect(fakeEngine.callsTo("appUninstall")).toEqual([]);
    expect(screen.getByTestId("built-in-app")).toBeInTheDocument();
  });

  it("Remove, then Remove in its question, takes it off the list for good, and the focus goes to Add", async () => {
    engineWith({ installed: false, removed: false });
    const { user } = renderApp(<Apps />, { route: "/apps" });
    const row = await screen.findByTestId("built-in-app");
    await user.click(within(row).getByRole("button", { name: "Remove Chess" }));
    expect(fakeEngine.callsTo("appUninstall")).toEqual([]);
    await user.click(screen.getByTestId("built-in-app-remove-confirm"));
    await waitFor(() => expect(fakeEngine.callsTo("appUninstall")).toEqual([{ ref: REF }]));
    await waitFor(() => expect(screen.queryByTestId("built-in-app")).not.toBeInTheDocument());
    expect(await screen.findByTestId("apps-none")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("apps-add")).toHaveFocus());
  });

  it("an engine from before built-in apps offers none, and the page is as it was", async () => {
    fakeEngine.on("appList", () => []).on("appStoreList", () => []).on("appCheckUpdates", () => []);
    renderApp(<Apps />, { route: "/apps" });
    expect(await screen.findByTestId("apps-none")).toBeInTheDocument();
    expect(screen.queryByTestId("built-in-app")).not.toBeInTheDocument();
  });
});
