import "fake-indexeddb/auto";
import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appCardId, type AppCard } from "@ghostly/core";
import type { BuiltInAppOffer, InstalledAppView } from "@ghostly/browser/engine/apps";
import { AppCardView } from "../../components/apps/AppCardView";
import { forgetAppsAvailable } from "../../lib/apps/flag";
import { forgetInstalledApps } from "../../lib/apps/installed";
import { registerRunningApp, setAppOpener, type AppOpener } from "../../lib/apps/open";
import { requestOpenInChat, takeOpenRequest } from "../../lib/apps/running";
import { saveSession } from "../../lib/storage";
import { Chat } from "../../pages/Chat";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { hideApps, showApps } from "./showApps";

// covers: apps.chat.card chat.paired.block

/*
 * A blocked contact's app frames are dropped (the engine's `blockedChat`): an app opened with them would wait for them
 * for good, its panel saying "Connected", and each Open sent them another card. So a blocked contact's chat says why
 * apps don't work with them, + → Apps and their cards open nothing, and an app running with them stops at the block,
 * as a call with them ends.
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));
vi.mock("../../lib/apps/runnerCheck", () => ({ runnerAvailable: vi.fn(async () => true), runnerPolicy: vi.fn(async () => true), forgetRunnerCheck: () => {}, isRunnerPolicy: () => true }));

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const REF = `${KEY}/chess`;
const PEER = "peer".padEnd(52, "p");
const chess = (): InstalledAppView => ({
  ref: REF, name: "chess", publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", title: "Chess", tagline: "Play chess", version: "1.2.0",
  sequence: 7, digest: "d", permissions: ["chat"], view: "chat", from: "https://raw.githubusercontent.com/a/chess/HEAD/app.ghostlyapp", icon: false, installedAt: 1, updatedAt: 1,
  run: { status: "ok" }, listedBy: [], unknownPublisher: false,
});
const SNAKE: BuiltInAppOffer = { ref: `${KEY}/snake`, publisher: KEY, name: "snake", fingerprint: "yz7m oxuc bd4u 8aqt", digest: "e",
  url: "https://raw.githubusercontent.com/a/snake/HEAD/app.ghostlyapp", title: "Snake", tagline: "Eat, grow." };
const CARD: AppCard = { kind: "app", id: appCardId(REF), ref: REF, digest: "d", sequence: 7, title: "Chess", version: "1.2.0", url: chess().from, opened: true };
const LIVE = { profile: "paired-chat/1", pairing: { status: "ready" }, dataLink: "open", sessionOffers: { mine: ["apps/1"], peer: ["apps/1"] } };
const BLOCKED_LINE = "You blocked ⁨Ana⁩. Unblock them to use apps together";
let opened: ReturnType<typeof vi.fn<AppOpener>>;

beforeEach(() => {
  localStorage.clear();
  forgetAppsAvailable();
  forgetInstalledApps();
  showApps();
  opened = vi.fn<AppOpener>(async () => {});
  setAppOpener(opened);
  fakeEngine.on("appList", () => [chess()]).on("appBuiltIns", () => []).on("appStoreList", () => []).on("appCheckUpdates", () => []);
});
afterEach(() => {
  takeOpenRequest("link-1");
  setAppOpener(null);
  hideApps();
  forgetAppsAvailable();
  forgetInstalledApps();
  vi.restoreAllMocks();
});

function openChat(blocked: boolean) {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1 });
  const view = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
  view.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("setContactBlocked", () => undefined).on("sendMessage", () => ({ error: null }));
  view.engine.update({ links: [linkView({ id: "link-1", peerPubKeyZ32: PEER, label: "Ana", ...LIVE, ...(blocked && { blocked: true }) } as never)] });
  return view;
}

describe("Apps in a blocked contact's chat", () => {
  it("+ → Apps says why and opens nothing with them, nor an app that comes with Ghostly", async () => {
    fakeEngine.on("appBuiltIns", () => [SNAKE]);
    const { user } = openChat(true);
    await user.click(await screen.findByTestId("composer-more"));
    await user.click(await screen.findByTestId("composer-apps"));
    const dialog = await screen.findByTestId("chat-apps");
    expect(within(dialog).getByTestId("chat-apps-waiting")).toHaveTextContent(BLOCKED_LINE);
    expect(await within(dialog).findByTestId("chat-app-open")).toBeDisabled();
    expect(await within(dialog).findByTestId("chat-built-in-app-open")).toBeDisabled();
    expect(opened).not.toHaveBeenCalled();
  });

  it("an app the Apps page opens in their chat does not open: + → Apps says why", async () => {
    openChat(true);
    await screen.findByTestId("composer-more");
    act(() => requestOpenInChat("link-1", { app: chess() }));
    const dialog = await screen.findByTestId("chat-apps");
    expect(within(dialog).getByTestId("chat-apps-waiting")).toHaveTextContent(BLOCKED_LINE);
    expect(opened).not.toHaveBeenCalled();
  });

  it("an app running with them (beside the chat, or in a Desktop window) stops at the block", async () => {
    const stop = vi.fn();
    const unregister = registerRunningApp({ ref: REF, digest: "d", runAnyway: false, linkId: "link-1", takeDown: () => {}, stop });
    const other = vi.fn();
    const unregisterOther = registerRunningApp({ ref: REF, digest: "d", runAnyway: false, linkId: "link-2", takeDown: () => {}, stop: other });
    try {
      const { engine } = openChat(false);
      await screen.findByTestId("composer-more");
      expect(stop).not.toHaveBeenCalled();
      act(() => engine.update({ links: [linkView({ id: "link-1", peerPubKeyZ32: PEER, label: "Ana", ...LIVE, blocked: true } as never)] }));
      await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
      expect(other).not.toHaveBeenCalled();
    } finally { unregister(); unregisterOther(); }
  });

  it("their card of an app not installed here says why, and Join is off", async () => {
    fakeEngine.on("appList", () => []);
    fakeEngine.setState({ links: [linkView({ id: "link-1", peerPubKeyZ32: "peer", label: "Ana", ...LIVE, blocked: true } as never)] });
    renderApp(<AppCardView card={CARD} mine={false} contact="Ana" linkId="link-1" peerKey="peer" />);
    const card = screen.getByTestId("app-card");
    expect(await within(card).findByTestId("app-card-waiting")).toHaveTextContent(BLOCKED_LINE);
    expect(within(card).getByTestId("app-card-install")).toBeDisabled();
  });

  it("their app card says why, with no Open", async () => {
    fakeEngine.setState({ links: [linkView({ id: "link-1", peerPubKeyZ32: "peer", label: "Ana", ...LIVE, blocked: true } as never)] });
    renderApp(<AppCardView card={CARD} mine={false} contact="Ana" linkId="link-1" peerKey="peer" />);
    const card = screen.getByTestId("app-card");
    await waitFor(() => expect(within(card).getByTestId("app-card-check")).toHaveTextContent("Installed"));
    expect(within(card).getByTestId("app-card-waiting")).toHaveTextContent(BLOCKED_LINE);
    expect(within(card).getByTestId("app-card-open")).toBeDisabled();
  });

  it("unblocked, + → Apps opens apps with them again", async () => {
    const { user } = openChat(false);
    await user.click(await screen.findByTestId("composer-more"));
    await user.click(await screen.findByTestId("composer-apps"));
    const dialog = await screen.findByTestId("chat-apps");
    expect(within(dialog).queryByTestId("chat-apps-waiting")).toBeNull();
    await user.click(await within(dialog).findByTestId("chat-app-open"));
    await waitFor(() => expect(opened).toHaveBeenCalledWith(REF, "link-1", expect.anything()));
  });
});
