import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ChatAppPanel, ChatAppResume } from "../../components/apps/ChatAppPanel";
import { AddAppDialog } from "../../components/apps/AddAppDialog";
import { Apps } from "../../pages/Apps";
import { forgetAppsAvailable } from "../../lib/apps/flag";
import { forgetInstalledApps } from "../../lib/apps/installed";
import { setAppOpener } from "../../lib/apps/open";
import type { AppOpener } from "../../lib/apps/open";
import { appWithContact, chatApp, requestOpenInChat, takeOpenRequest } from "../../lib/apps/running";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import type { InstalledAppView } from "@ghostly/browser/engine/apps";
import { Route, Routes, useLocation } from "react-router-dom";
import { webOpener } from "../../lib/apps/webOpener";
import type { AppsPlatform } from "../../lib/platform";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { windowIs } from "../viewport";

// covers: apps.view

// The runner's header is answered here, never fetched; the frame is a stand-in (the broker has its own tests).
vi.mock("../../lib/apps/runnerCheck", () => ({ runnerAvailable: vi.fn(async () => true), runnerPolicy: vi.fn(async () => true), forgetRunnerCheck: () => {}, isRunnerPolicy: () => true }));
const started: { container: HTMLElement; frame: HTMLIFrameElement; stop: ReturnType<typeof vi.fn> }[] = [];
vi.mock("../../lib/apps/broker", async (actual) => ({
  ...(await actual<typeof import("../../lib/apps/broker")>()),
  startApp: ({ container, launch, onStop }: { container: HTMLElement; launch: { title: string }; onStop?: (reason: string) => void }) => {
    const frame = document.createElement("iframe");
    frame.title = launch.title;
    container.appendChild(frame);
    const stop = vi.fn(() => { frame.remove(); onStop?.("stopped"); });
    started.push({ container, frame, stop });
    return { frame, phase: "running", stop };
  },
}));

const REF = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo/chess";
/** Where the next app opened shows, as its manifest says (absent: in a chat). */
let view: "chat" | "full" | undefined;
const host = {
  runnerUrl: "/app-frame.html",
  entry: async () => ({ ref: REF, version: "1.2.0", title: "Chess", permissions: ["chat"], entry: "<!doctype html>", ...(view && { view }) }),
} as unknown as AppsPlatform;

/** Ana's chat: live over Iroh, or not. */
const ana = (live: boolean): LinkView => linkView({
  id: "link-1", peerPubKeyZ32: "peer", profile: "paired-chat/1", peerNick: "Ana",
  pairing: (live ? { status: "ready", transport: "iroh/1" } : { status: "waiting" }) as LinkView["pairing"],
  dataLink: live ? "open" : "idle", peerOnline: live,
});

let open: AppOpener;
beforeEach(() => {
  started.length = 0;
  view = undefined;
  open = webOpener({ apps: () => host, closeLabel: () => "Close" });
});
afterEach(() => {
  document.querySelectorAll("[data-place=alone]").forEach((node) => node.remove());
});

/** The chat page as Chat.tsx lays it out: its column (the resume bar, a button that opens the app, the message field) and the panel. */
function panel(live = true) {
  const view = renderApp(<div className="chat-pane">
    <div className="chat-column">
      <ChatAppResume linkId="link-1" />
      <button type="button" data-testid="opener">Open Chess</button>
      <textarea aria-label="Message" />
    </div>
    <ChatAppPanel linkId="link-1" sessionId="s1" contact={{ name: "Ana", named: true }} peerKey="peer" />
  </div>);
  act(() => fakeEngine.update({ links: [ana(live)] }));
  return view;
}

describe("a mini-app in a chat (WISP 1200 § Per client, web)", () => {
  it("has the chat's look in its header: the app, with the contact, and the chat's connection", async () => {
    windowIs(false);
    panel();
    // Nothing shows before it is opened, but its box is there.
    expect(screen.getByTestId("mini-app")).not.toBeVisible();
    await act(() => open(REF, "link-1"));
    const app = screen.getByTestId("mini-app");
    expect(app).toBeVisible();
    expect(app).toHaveAccessibleName("Chess with Ana");
    expect(within(app).getByTestId("mini-app-title")).toHaveTextContent("Chess");
    expect(within(app).getByTestId("mini-app-with")).toHaveTextContent("with Ana");
    expect(within(app).getByTestId("mini-app-avatar")).toBeInTheDocument();
    // The same control as the chat's header: live, over Iroh.
    const connection = within(app).getByTestId("app-connection-options");
    expect(connection).toHaveAttribute("data-state", "connected");
    expect(connection).toHaveAttribute("data-transport", "iroh/1");
    // Its own test ids: the chat header's stay the only `connection-options` on the page.
    expect(screen.queryByTestId("connection-options")).not.toBeInTheDocument();
    // The frame runs in the panel's own box.
    expect(started).toHaveLength(1);
    expect(within(app).getByTestId("mini-app-frame")).toContainElement(started[0]!.frame);
  });

  it("says when the contact is not connected", async () => {
    windowIs(false);
    panel(false);
    await act(() => open(REF, "link-1"));
    expect(within(screen.getByTestId("mini-app")).getByTestId("app-connection-options")).toHaveAttribute("data-state", "waiting");
    act(() => fakeEngine.update({ links: [ana(true)] }));
    expect(within(screen.getByTestId("mini-app")).getByTestId("app-connection-options")).toHaveAttribute("data-state", "connected");
  });

  it("on a wide screen sits beside the chat, goes full width and back, and Close stops it", async () => {
    windowIs(false);
    const { user } = panel();
    await act(() => open(REF, "link-1"));
    const app = screen.getByTestId("mini-app");
    expect(app).toHaveAttribute("data-place", "beside");
    expect(within(app).queryByTestId("mini-app-back")).not.toBeInTheDocument();
    const wide = within(app).getByTestId("mini-app-wide");
    expect(wide).toHaveAccessibleName("Full width");
    await user.click(wide);
    expect(app).toHaveAttribute("data-place", "wide");
    expect(wide).toHaveAttribute("aria-pressed", "true");
    expect(wide).toHaveAccessibleName("Show the chat");
    await user.click(wide);
    expect(app).toHaveAttribute("data-place", "beside");
    // Layout changes never moved the frame.
    expect(started[0]!.frame.isConnected).toBe(true);

    await user.click(within(app).getByRole("button", { name: "Close" }));
    expect(started[0]!.stop).toHaveBeenCalled();
    expect(chatApp("link-1")).toBeUndefined();
    expect(app).not.toBeVisible();
  });

  it("on a phone covers the chat, and Back keeps it running: the chat brings it back as it was", async () => {
    windowIs(true);
    const { user } = panel();
    await act(() => open(REF, "link-1"));
    const app = screen.getByTestId("mini-app");
    expect(app).toHaveAttribute("data-place", "phone");
    expect(within(app).queryByTestId("mini-app-wide")).not.toBeInTheDocument();
    expect(within(app).getByTestId("mini-app-with")).toHaveTextContent("with Ana");
    const frame = started[0]!.frame;

    await user.click(within(app).getByTestId("mini-app-back"));
    expect(app).not.toBeVisible();
    expect(started[0]!.stop).not.toHaveBeenCalled();
    expect(frame.isConnected).toBe(true);
    // Under the chat's header, one tap away.
    const resume = screen.getByTestId("mini-app-resume");
    expect(resume).toHaveTextContent("Back to Chess");
    await user.click(resume);
    expect(app).toBeVisible();
    expect(screen.queryByTestId("mini-app-resume")).not.toBeInTheDocument();

    // Opened again from the chat (its card, or + → Apps): the same app, not a new one.
    await user.click(within(app).getByTestId("mini-app-back"));
    await act(() => open(REF, "link-1"));
    expect(app).toBeVisible();
    expect(started).toHaveLength(1);
    expect(frame.isConnected).toBe(true);
  });

  it("a full-screen app covers the whole chat at every width, with Back to it, and never sits beside it", async () => {
    windowIs(false);
    view = "full";
    const { user } = panel();
    await act(() => open(REF, "link-1"));
    const app = screen.getByTestId("mini-app");
    expect(app).toHaveAttribute("data-place", "full");
    expect(app).toHaveAttribute("data-view", "full");
    // The chat's look stays: the contact and the connection.
    expect(within(app).getByTestId("mini-app-with")).toHaveTextContent("with Ana");
    expect(within(app).getByTestId("app-connection-options")).toBeInTheDocument();
    // No way to put it beside the chat; Back has the focus.
    expect(within(app).queryByTestId("mini-app-wide")).not.toBeInTheDocument();
    const back = within(app).getByTestId("mini-app-back");
    expect(back).toHaveFocus();
    expect(chatApp("link-1")?.view).toBe("full");

    // Back: the chat, with the app one tap away and still running.
    await user.click(back);
    expect(app).not.toBeVisible();
    expect(started[0]!.stop).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("mini-app-resume"));
    expect(app).toHaveAttribute("data-place", "full");
    // Escape goes Back too, never closes it.
    await user.keyboard("{Escape}");
    expect(app).not.toBeVisible();
    expect(started[0]!.stop).not.toHaveBeenCalled();
    expect(screen.getByTestId("mini-app-resume")).toHaveFocus();
  });

  it("a full-screen app on a phone is as any app there: over the chat, with Back", async () => {
    windowIs(true);
    view = "full";
    panel();
    await act(() => open(REF, "link-1"));
    const app = screen.getByTestId("mini-app");
    expect(app).toHaveAttribute("data-place", "phone");
    expect(app).toHaveAttribute("data-view", "full");
    expect(within(app).getByTestId("mini-app-back")).toHaveFocus();
    expect(within(app).queryByTestId("mini-app-wide")).not.toBeInTheDocument();
  });

  it("an app whose manifest names no view is a chat app", async () => {
    windowIs(false);
    panel();
    await act(() => open(REF, "link-1"));
    expect(chatApp("link-1")?.view).toBe("chat");
    expect(screen.getByTestId("mini-app")).toHaveAttribute("data-place", "beside");
  });

  it("stops the app when its chat closes", async () => {
    windowIs(false);
    const { unmount } = panel();
    await act(() => open(REF, "link-1"));
    unmount();
    expect(started[0]!.stop).toHaveBeenCalled();
    expect(chatApp("link-1")).toBeUndefined();
  });

  it("opened alone is full screen with its title only", async () => {
    await open(REF, null);
    const app = await waitFor(() => screen.getByTestId("mini-app"));
    expect(app).toHaveAttribute("data-place", "alone");
    expect(within(app).getByTestId("mini-app-title")).toHaveTextContent("Chess");
    expect(within(app).queryByTestId("mini-app-with")).not.toBeInTheDocument();
    expect(within(app).queryByTestId("app-connection-options")).not.toBeInTheDocument();
  });

  it("names a Desktop app window after the app and the contact, and the app alone outside a chat", async () => {
    windowIs(false);
    panel();
    const t = ((key: string, vars: Record<string, string>) => key === "apps.view.with" ? `${vars.title} with ${vars.name}` : key) as never;
    expect(appWithContact("Chess", "link-1", t)).toBe("Chess with Ana");
    expect(appWithContact("Chess", null, t)).toBe("Chess");
    expect(appWithContact("Chess", "link-other", t)).toBe("Chess");
  });
});

describe("keys and focus in a mini-app", () => {
  it("beside the chat: the focus goes into the panel, Escape there closes it, and the focus goes back to what opened it", async () => {
    windowIs(false);
    const { user } = panel();
    screen.getByTestId("opener").focus();
    await act(() => open(REF, "link-1"));
    const app = screen.getByTestId("mini-app");
    // Not modal: the chat beside it stays reachable.
    expect(app).not.toHaveAttribute("aria-modal");
    expect(app.parentElement!.querySelector(".chat-column")).not.toHaveAttribute("inert");
    expect(app).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(started[0]!.stop).toHaveBeenCalled();
    expect(screen.getByTestId("opener")).toHaveFocus();
  });

  it("full width: Escape goes back beside the chat", async () => {
    windowIs(false);
    const { user } = panel();
    await act(() => open(REF, "link-1"));
    await user.click(screen.getByTestId("mini-app-wide"));
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("mini-app")).toHaveAttribute("data-place", "beside");
    expect(started[0]!.stop).not.toHaveBeenCalled();
  });

  it("on a phone: modal, Back has the focus, the chat under it is inert, and Escape goes Back to the chat's way back in", async () => {
    windowIs(true);
    const { user } = panel();
    screen.getByTestId("opener").focus();
    await act(() => open(REF, "link-1"));
    const app = screen.getByRole("dialog", { name: "Chess with Ana" });
    expect(app).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("mini-app-back")).toHaveFocus();
    const column = app.parentElement!.querySelector(".chat-column")!;
    expect(column).toHaveAttribute("inert");
    await user.keyboard("{Escape}");
    expect(app).not.toBeVisible();
    expect(started[0]!.stop).not.toHaveBeenCalled();
    expect(column).not.toHaveAttribute("inert");
    expect(screen.getByTestId("mini-app-resume")).toHaveFocus();
    // Back in, then closed: the focus goes to what opened it.
    await user.click(screen.getByTestId("mini-app-resume"));
    expect(screen.getByTestId("mini-app-back")).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByTestId("opener")).toHaveFocus();
  });

  it("alone: modal over an inert page, Close has the focus, Escape closes and the focus comes back", async () => {
    const page = document.createElement("div");
    page.className = "two-pane";
    // The lock screen is outside the app's shell: it stays reachable over the app.
    const lock = document.createElement("div");
    document.body.append(lock);
    const button = document.createElement("button");
    page.append(button);
    document.body.append(page);
    button.focus();
    await open(REF, null);
    const app = screen.getByTestId("mini-app");
    expect(app).toHaveAttribute("aria-modal", "true");
    expect(page.inert).toBe(true);
    expect(lock.inert).toBe(false);
    expect(within(app).getByRole("button", { name: "Close" })).toHaveFocus();
    app.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(screen.queryByTestId("mini-app")).not.toBeInTheDocument();
    expect(page.inert).toBe(false);
    expect(button).toHaveFocus();
    page.remove();
    lock.remove();
  });
});

describe("opening an app from the Apps page", () => {
  const DIGEST = "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4";
  const installed = (appView: "chat" | "full"): InstalledAppView => ({
    ref: REF, name: "chess", publisher: REF.split("/")[0]!, fingerprint: "yz7m oxuc bd4u 8aqt", title: "Chess", tagline: "Play chess", version: "1.2.0",
    sequence: 7, digest: DIGEST, permissions: ["chat"], view: appView, from: "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp", icon: false,
    installedAt: 1, updatedAt: 1, run: { status: "ok" }, listedBy: [], unknownPublisher: false,
  });
  let opener: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    forgetAppsAvailable();
    forgetInstalledApps();
    vi.stubEnv("VITE_APPS_TEST", "1");
    fakeEngine.appRunner = "/app-frame.html";
    opener = vi.fn(async () => {});
    setAppOpener(opener as unknown as AppOpener);
    saveSession({ id: "chat-ana", mySeedB64: "s", peerPubKeyB64: "peer", encKeyB64: "e", nick: "Ana", profile: "paired-chat/1", createdAt: 1, messages: [] } as unknown as ChatSession);
    // A chat that never paired: no app can open there.
    saveSession({ id: "chat-bo", mySeedB64: "s", peerPubKeyB64: "peer-bo", encKeyB64: "e", nick: "Bo", createdAt: 1, messages: [] } as unknown as ChatSession);
    fakeEngine.update({ links: [ana(true), linkView({ id: "link-bo", peerPubKeyZ32: "peer-bo" })] });
    fakeEngine.on("appStoreList", () => [] as never).on("appCheckUpdates", () => []);
  });
  afterEach(() => { vi.unstubAllEnvs(); setAppOpener(null); takeOpenRequest("link-1"); });

  function Where() { return <p data-testid="where">{useLocation().pathname}</p>; }

  it("a chat app asks which chat, lists only paired 1:1 chats, and opens there: never alone", async () => {
    fakeEngine.on("appList", () => [installed("chat")] as never);
    const { user } = renderApp(<Routes><Route path="/apps" element={<Apps />} /><Route path="*" element={<Where />} /></Routes>, { route: "/apps" });
    await user.click(await screen.findByTestId("installed-app-open"));
    const picker = screen.getByRole("dialog", { name: "Open Chess in a chat" });
    const chats = within(picker).getAllByTestId("app-chat-picker-chat");
    expect(chats).toHaveLength(1);
    expect(chats[0]).toHaveTextContent("Ana");
    expect(opener).not.toHaveBeenCalled();
    await user.click(chats[0]!);
    // To that chat, which opens it once it shows (Chat.tsx).
    expect(screen.getByTestId("where")).toHaveTextContent("chat-ana");
    expect(opener).not.toHaveBeenCalled();
    expect(takeOpenRequest("link-1")?.app.ref).toBe(REF);
  });

  it("a full-screen app opens alone from the Apps page", async () => {
    fakeEngine.on("appList", () => [installed("full")] as never);
    const { user } = renderApp(<Apps />, { route: "/apps" });
    await user.click(await screen.findByTestId("installed-app-open"));
    expect(screen.queryByTestId("app-chat-picker")).not.toBeInTheDocument();
    expect(opener).toHaveBeenCalledWith(REF, null, {});
  });

  it("an open request not taken within a minute is dropped", () => {
    vi.useFakeTimers();
    try {
      requestOpenInChat("link-1", { app: installed("chat") });
      vi.advanceTimersByTime(61_000);
      expect(takeOpenRequest("link-1")).toBeUndefined();
      requestOpenInChat("link-1", { app: installed("chat"), options: { runAnyway: true } });
      expect(takeOpenRequest("link-1")).toMatchObject({ options: { runAnyway: true } });
      expect(takeOpenRequest("link-1")).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });
});

describe("focus on the Apps page", () => {
  beforeEach(() => {
    forgetAppsAvailable();
    forgetInstalledApps();
    vi.stubEnv("VITE_APPS_TEST", "1");
    fakeEngine.appRunner = "/app-frame.html";
    setAppOpener(vi.fn(async () => {}));
  });
  afterEach(() => { vi.unstubAllEnvs(); setAppOpener(null); });

  it("the Add dialog's one field has the focus", () => {
    renderApp(<AddAppDialog onClose={() => {}} onStoreAdded={() => {}} />);
    expect(screen.getByTestId("apps-add-url")).toHaveFocus();
  });

  it("after Install from a store's listing, the focus goes to the app's Open, not the page", async () => {
    const DIGEST = "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4", URL_ = "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp";
    const app = { ref: REF, name: "chess", publisher: REF.split("/")[0], fingerprint: "yz7m oxuc bd4u 8aqt", title: "Chess", tagline: "Play chess", version: "1.2.0",
      sequence: 7, digest: DIGEST, permissions: ["chat"], from: URL_, icon: false, installedAt: 1, updatedAt: 1, run: { status: "ok" }, listedBy: [], unknownPublisher: false };
    let list: unknown[] = [];
    fakeEngine.on("appList", () => list as never)
      .on("appStoreList", () => [{ key: "s", fingerprint: "abcd efgh ijkl mnop", url: "https://raw.githubusercontent.com/g/s/HEAD/ghostly-store.json", preloaded: false,
        name: "Ghostly", kind: "curated", sequence: 1, expires: 2_000_000_000, expired: false, fetchedAt: 1,
        apps: [{ ref: REF, sequence: 7, digest: DIGEST, urls: [URL_], title: "Chess", tagline: "Play chess" }], removed: [] }] as never)
      .on("appCheckUpdates", () => [])
      .on("appPreview", () => ({ digest: DIGEST, ref: REF, publisher: app.publisher, fingerprint: app.fingerprint, from: URL_, icon: null, install: "new", asks: ["chat"],
        run: { status: "ok" }, listedBy: [], unknownPublisher: false,
        manifest: { ghostlyApp: 1, publisher: app.publisher, name: "chess", version: "1.2.0", sequence: 7, kind: "mini-app", title: "Chess", tagline: "Play chess",
          entry: "index.html", permissions: ["chat"], runtime: { host: ">=1.2", clients: ["web", "desktop"] }, license: "MIT", files: [] } }) as never)
      .on("appInstall", () => { list = [app]; return app as never; });
    const { user } = renderApp(<Apps />, { route: "/apps" });
    const store = await screen.findByTestId("app-store");
    await user.click(within(store).getByRole("button", { name: /Ghostly/ }));
    await user.click(within(store).getByTestId("app-listing-install"));
    await user.click(await screen.findByTestId("app-install-confirm"));
    await waitFor(() => expect(within(screen.getByTestId("installed-app")).getByTestId("installed-app-open")).toHaveFocus());
  });
});
