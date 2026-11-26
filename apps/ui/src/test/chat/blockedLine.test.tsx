import "fake-indexeddb/auto";
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { saveSession } from "../../lib/storage";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.paired.block

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const BOB = "b".repeat(52);

/** A blocked contact's chat; the engine answers `setContactBlocked` with the contact's new state, as the real one does. */
async function openBlocked() {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: BOB, encKeyB64: "a2V5", participationSeedB64: "cGFydA", messages: [], createdAt: Date.now(), label: "Bob" });
  const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
  const link = (blocked: boolean) => linkView({ id: "link-1", peerPubKeyZ32: BOB, label: "Bob", ...(blocked && { blocked: true as const }) });
  utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined)
    .on("setContactBlocked", ({ blocked }) => { utils.engine.update({ links: [link(blocked)] }); return undefined; });
  utils.engine.update({ links: [link(true)] });
  await screen.findByTestId("chat-blocked");
  return { ...utils, unblockInChat: () => utils.engine.update({ links: [link(false)] }) };
}
const lineUnblock = () => within(screen.getByTestId("chat-blocked")).getByRole("button", { name: "Unblock contact" });

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe("a blocked contact's chat: the line's Unblock contact", () => {
  it("hands the focus to ⋮ once the line is gone, as the menu's Unblock contact does, not to the page", async () => {
    const { user, engine } = await openBlocked();
    await user.click(lineUnblock());
    expect(engine.callsTo("setContactBlocked")).toEqual([{ peerPubKeyZ32: BOB, blocked: false }]);
    await vi.waitFor(() => expect(screen.queryByTestId("chat-blocked")).toBeNull());
    expect(screen.getByTestId("chat-options")).toHaveFocus();
  });

  it("leaves the focus where it is when the contact is unblocked elsewhere (Settings, another device)", async () => {
    const { unblockInChat } = await openBlocked();
    // A control that stays (the composer is not drawn in this harness).
    const kept = screen.getByTestId("call-audio");
    kept.focus();
    unblockInChat();
    await vi.waitFor(() => expect(screen.queryByTestId("chat-blocked")).toBeNull());
    expect(kept).toHaveFocus();
  });

  it("takes a 44 px tap on a phone, in a line no taller than that there", async () => {
    await openBlocked();
    expect(lineUnblock()).toHaveClass("max-md:min-h-11", "max-md:px-2");
    expect(screen.getByTestId("chat-blocked")).toHaveClass("max-md:py-0");
  });
});
