import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appCardId, statusCardText, type AppCard } from "@ghostly/core";
import type { InstalledAppView } from "@ghostly/browser/engine/apps";
import { MessageBubble } from "../../components/MessageBubble";
import { forgetAppsAvailable } from "../../lib/apps/flag";
import { forgetAppIcons } from "../../lib/apps/icons";
import { forgetInstalledApps, refreshInstalledApps } from "../../lib/apps/installed";
import { setAppOpener } from "../../lib/apps/open";
import type { ChatMessage } from "../../lib/types";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.chat.card

// The runner page's header, asked once by the real check: answered here, never fetched in a test.
vi.mock("../../lib/apps/runnerCheck", () => ({ runnerAvailable: vi.fn(async () => true), runnerPolicy: vi.fn(async () => true), forgetRunnerCheck: () => {}, isRunnerPolicy: () => true }));

/**
 * An installed app's icon is read from the engine once for its version, and that one picture shows in every card and
 * row that names the app: a chat with twenty of its cards asked the engine twenty times, and twenty more each time they
 * showed again, each one a copy of the icon and a picture of its own. A new version shows its own icon.
 */

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const REF = `${KEY}/chess`;
const DIGEST = "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4";
const NEXT = "Fq8m0Uc3vH2JkTn4zR7wYx1aBdE5gS6iL9oP0rQ2sTu";
const URL_ = "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp";
const app = (digest: string) => ({
  ref: REF, name: "chess", publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", title: "Chess", tagline: "Play chess with a contact",
  version: "1.0.0", sequence: digest === DIGEST ? 7 : 8, digest, permissions: ["chat"], view: "chat", from: URL_, icon: true,
  installedAt: 1, updatedAt: 1, run: { status: "ok" }, listedBy: [], unknownPublisher: true,
}) as unknown as InstalledAppView;
const CARD: AppCard = { kind: "app", id: appCardId(REF), ref: REF, digest: DIGEST, sequence: 7, title: "Chess", version: "1.0.0", url: URL_, opened: true };
const message = (i: number) => ({ id: `m${i}`, text: statusCardText(CARD), card: CARD, sender: "peer", timestamp: Date.now() }) as ChatMessage;
const cards = () => <>{Array.from({ length: 20 }, (_, i) => <MessageBubble key={i} message={message(i)} peerPubKey="peer" contactName="Ana" linkId="link-1" />)}</>;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

let installed: InstalledAppView;
let made: string[];
beforeEach(() => {
  forgetAppsAvailable();
  forgetInstalledApps();
  forgetAppIcons();
  vi.stubEnv("VITE_APPS_TEST", "1");
  fakeEngine.appRunner = "/app-frame.html";
  setAppOpener(vi.fn(async () => {}));
  // Chromium, as the e2e suite runs: happy-dom's own user agent names AppleWebKit and no other engine.
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36");
  installed = app(DIGEST);
  made = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => { const url = `blob:icon-${made.length}`; made.push(url); return url; });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  fakeEngine.on("appList", () => [installed]).on("appFile", () => new Uint8Array([137, 80, 78, 71, installed.sequence]));
});
afterEach(() => {
  forgetInstalledApps();
  forgetAppIcons();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setAppOpener(null);
});

const pictures = () => screen.getAllByTestId("app-icon").map((icon) => icon.querySelector("img")?.getAttribute("src"));

describe("an installed app's icon", () => {
  it("is read once for twenty cards, and not again when they show again", async () => {
    await refreshInstalledApps();
    const shown = renderApp(cards());
    expect(await screen.findAllByTestId("app-icon", {}, { timeout: 3000 })).toHaveLength(20);
    await settle();
    expect(pictures()).toEqual(Array.from({ length: 20 }, () => "blob:icon-0"));
    shown.unmount();
    renderApp(cards());
    await settle();
    expect(pictures()).toEqual(Array.from({ length: 20 }, () => "blob:icon-0"));
    expect(fakeEngine.callsTo("appFile")).toHaveLength(1);
    expect(made).toHaveLength(1);
  });

  it("of a new version is that version's own", async () => {
    await refreshInstalledApps();
    renderApp(cards());
    await screen.findAllByTestId("app-icon", {}, { timeout: 3000 });
    await settle();
    expect(pictures()[0]).toBe("blob:icon-0");
    installed = app(NEXT);
    await act(() => refreshInstalledApps());
    await settle();
    expect(pictures()).toEqual(Array.from({ length: 20 }, () => "blob:icon-1"));
    expect(fakeEngine.callsTo("appFile")).toHaveLength(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:icon-0");
  });
});
