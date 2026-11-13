import "fake-indexeddb/auto";
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setBrowserHost, type BrowserHost } from "@ghostly/browser/host";
import { Chat } from "../../pages/Chat";
import { saveInviteCode, saveSession } from "../../lib/storage";
import { renderApp } from "../render";

// covers: invite.clipboard

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

/*
 * A chat that waits for its contact copies its invite again from ⋮: a secret, so the host copies it marked (out of
 * clipboard history and clipboard managers), as the invite card's Copy does. Never the page's own copy, which marks
 * nothing.
 */

const code = "ghostly1-invite";
const link = `https://ghostly.tools/#${code}`;

async function openMenu(copySecret: (text: string) => Promise<void>) {
  setBrowserHost({ copySecret } as Partial<BrowserHost> as BrowserHost);
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: "peer".padEnd(52, "p"), encKeyB64: "a2V5", participationSeedB64: "cGFydA", messages: [], createdAt: Date.now() });
  saveInviteCode("chat-1", code);
  const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
  utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined);
  await utils.user.click(screen.getByTestId("chat-options"));
  return { ...utils, menu: within(await screen.findByTestId("chat-options-menu")) };
}

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe("⋮ → Copy invite link", () => {
  it("copies the invite marked, through the host, and never with the page's clipboard", async () => {
    const copySecret = vi.fn(async () => {});
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
    const { user, menu } = await openMenu(copySecret);
    await user.click(menu.getByTestId("chat-copy-invite"));
    expect(copySecret).toHaveBeenCalledWith(link);
    expect(writeText).not.toHaveBeenCalled();
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("a refused marked copy copies nothing unmarked: it shows the link to copy by hand", async () => {
    const copySecret = vi.fn(async () => { throw new Error("refused"); });
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const { user, menu } = await openMenu(copySecret);
    await user.click(menu.getByTestId("chat-copy-invite"));
    expect(copySecret).toHaveBeenCalledWith(link);
    expect(writeText).not.toHaveBeenCalled();
    expect(await screen.findByTestId("link-qr-url")).toHaveValue(link);
  });
});
