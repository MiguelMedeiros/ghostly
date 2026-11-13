import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledAppView } from "@ghostly/browser/engine/apps";
import { ChatAppsDialog } from "../../components/apps/ChatAppsDialog";
import { forgetInstalledApps } from "../../lib/apps/installed";
import { setAppOpener } from "../../lib/apps/open";
import type { AppOpener } from "../../lib/apps/open";
import { requestOpenInChat, setChatApp, takeOpenRequest, updateChatApp, type ChatApp } from "../../lib/apps/running";
import type { RunningApp } from "../../lib/apps/broker";
import { saveSession } from "../../lib/storage";
import { Chat } from "../../pages/Chat";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { windowIs } from "../viewport";
import { hideApps, showApps } from "./showApps";

// covers: apps.view

/*
 * Why an app did not open in a chat shows where the person is. While an app covers the chat (a full-screen one, or any
 * on a phone), + → Apps is under it, out of sight: the reason is a card over the app, and + → Apps does not come up
 * with it later, once the person goes Back.
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const REF = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo/chess";
const PEER = "peer".padEnd(52, "p");
const chess = (): InstalledAppView => ({
  ref: REF, name: "chess", publisher: REF.split("/")[0]!, fingerprint: "yz7m oxuc bd4u 8aqt", title: "Chess", tagline: "Play chess", version: "1.2.0",
  sequence: 7, digest: "d", permissions: ["chat"], view: "chat", from: "https://raw.githubusercontent.com/a/chess/HEAD/app.ghostlyapp", icon: false, installedAt: 1, updatedAt: 1,
  run: { status: "ok" }, listedBy: [], unknownPublisher: false,
});
/** An app shown in Ana's chat: a full-screen one covers it at every width. */
const shownApp = (patch: Partial<ChatApp> = {}): ChatApp => ({
  ref: "k/cinema", title: "Cinema", shown: true, wide: false, view: "full",
  running: { frame: document.createElement("iframe"), phase: "running", stop: () => {} } as unknown as RunningApp, ...patch,
});

beforeEach(() => {
  forgetInstalledApps();
  fakeEngine.on("appList", () => [chess()]).on("appBuiltIns", () => []);
});
afterEach(() => {
  setChatApp("link-1", null);
  takeOpenRequest("link-1");
  hideApps();
  forgetInstalledApps();
  vi.restoreAllMocks();
});

describe("an app opened from the Apps page in a chat an app covers", () => {
  function openChat() {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1 });
    const view = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
    view.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
    view.engine.update({ links: [linkView({ id: "link-1", peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
    return view;
  }

  it.each([
    ["a full-screen app, on a wide screen", false, shownApp()],
    ["any app, on a phone", true, shownApp({ view: "chat", ref: "k/notes", title: "Notes" })],
  ])("%s: why it did not open shows over the app, and + → Apps never comes up with it after Back", async (_, phone, covering) => {
    windowIs(phone);
    showApps();
    setAppOpener(vi.fn(async () => { throw new Error("offline: no network"); }) as unknown as AppOpener);
    openChat();
    await screen.findByTestId("mini-app");
    act(() => setChatApp("link-1", covering));
    act(() => requestOpenInChat("link-1", { app: chess() }));

    const card = await screen.findByTestId("chat-app-why");
    expect(card).toHaveAttribute("data-tone", "error");
    expect(screen.getByTestId("chat-app-why-title")).toHaveTextContent("Chess with Ana");
    expect(screen.getByTestId("chat-app-why-text")).toHaveTextContent("You are offline.");
    expect(screen.queryByTestId("chat-apps")).not.toBeInTheDocument();

    // Back to the chat: nothing old comes up.
    act(() => updateChatApp("link-1", { shown: false }));
    await act(async () => {});
    expect(screen.queryByTestId("chat-apps")).not.toBeInTheDocument();
  });

  it("with the chat in sight (the app beside it), why shows in + → Apps as before", async () => {
    showApps();
    setAppOpener(vi.fn(async () => { throw new Error("offline: no network"); }) as unknown as AppOpener);
    openChat();
    await screen.findByTestId("mini-app");
    act(() => setChatApp("link-1", shownApp({ view: "chat" })));
    act(() => requestOpenInChat("link-1", { app: chess() }));
    expect(await screen.findByTestId("chat-apps-error")).toHaveTextContent("You are offline.");
    expect(screen.queryByTestId("chat-app-why")).not.toBeInTheDocument();
  });
});

describe("+ → Apps, when the app it opened covers it and the card to the contact then fails", () => {
  it("hands why to the chat, to show over the app, and goes: it never comes up later with that error", async () => {
    windowIs(true);
    showApps();
    // Opened, shown over the chat (a phone): then the card does not go.
    setAppOpener(vi.fn(async () => { setChatApp("link-1", shownApp({ view: "chat", ref: REF, title: "Chess" })); }) as unknown as AppOpener);
    fakeEngine.on("sendMessage", () => ({ error: "offline: no network" }));
    const onClose = vi.fn();
    const onCovered = vi.fn();
    const { user } = renderApp(<ChatAppsDialog linkId="link-1" name="Ana" onClose={onClose} onCovered={onCovered} />);
    await user.click(await screen.findByTestId("chat-app-open"));
    await waitFor(() => expect(onCovered).toHaveBeenCalledWith("You are offline.", "Chess"));
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByTestId("chat-apps-error")).not.toBeInTheDocument();
  });

  it("with the dialog in sight (the app beside the chat), why stays in it", async () => {
    windowIs(false);
    showApps();
    setAppOpener(vi.fn(async () => { setChatApp("link-1", shownApp({ view: "chat", ref: REF, title: "Chess" })); }) as unknown as AppOpener);
    fakeEngine.on("sendMessage", () => ({ error: "offline: no network" }));
    const onClose = vi.fn();
    const onCovered = vi.fn();
    const { user } = renderApp(<ChatAppsDialog linkId="link-1" name="Ana" onClose={onClose} onCovered={onCovered} />);
    await user.click(await screen.findByTestId("chat-app-open"));
    expect(await screen.findByTestId("chat-apps-error")).toHaveTextContent("You are offline.");
    expect(onCovered).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
