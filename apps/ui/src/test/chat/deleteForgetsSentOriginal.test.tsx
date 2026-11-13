import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { getPrefix, saveSession, setStorageProfile as setProfile } from "../../lib/storage";
import { keepSentOriginal, sentOriginal } from "../../lib/sentOriginals";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.paired.delete-message

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

/**
 * A 1:1 message I sent translated, deleted here or for everyone: what I typed goes with it (lib/sentOriginals.ts), as a
 * group message's does. The chat page's delete never forgot it, so the original stayed on this device.
 */
const PEER = "peer".padEnd(52, "p");
const ID = "me_w1";

function openChat() {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", createdAt: 1_700_000_000_000,
    messages: [
      { id: ID, ref: "w1", text: "ciao a tutti", sender: "me", timestamp: 1_700_000_000_500, delivery: "delivered" } as never,
      { id: "me_w2", ref: "w2", text: "come stai", sender: "me", timestamp: 1_700_000_000_600, delivery: "delivered" } as never,
    ] });
  keepSentOriginal("chat-1", ID, { to: "it", original: "hello everyone" });
  keepSentOriginal("chat-1", "me_w2", { to: "it", original: "how are you" });
  const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
  utils.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", dataLink: "open" } as never)] });
  return utils;
}

const stored = () => localStorage.getItem(`${getPrefix()}sent_originals_chat-1`) ?? "";

afterEach(() => { localStorage.clear(); setProfile(""); });

describe("Deleting a 1:1 message I sent translated", () => {
  it("here, forgets what I typed, and keeps the other message's", async () => {
    const { user } = openChat();
    const bubble = (await screen.findByText("ciao a tutti")).closest<HTMLElement>("[data-message-id]")!;
    await user.click(within(bubble).getByTestId("message-options"));
    await user.click(screen.getByTestId("message-delete"));
    await user.click(screen.getByTestId("message-delete-confirm"));
    await waitFor(() => expect(screen.queryByText("ciao a tutti")).not.toBeInTheDocument());
    expect(sentOriginal("chat-1", ID)).toBeUndefined();
    expect(stored()).not.toContain("hello everyone");
    expect(sentOriginal("chat-1", "me_w2")).toEqual({ to: "it", original: "how are you" });
  });

  it("for everyone, forgets what I typed once the engine took the removal", async () => {
    const { user, engine } = openChat();
    engine.on("removeMessage", () => ({ error: null }));
    const bubble = (await screen.findByText("ciao a tutti")).closest<HTMLElement>("[data-message-id]")!;
    await user.click(within(bubble).getByTestId("message-options"));
    await user.click(screen.getByTestId("message-delete-everyone"));
    await user.click(screen.getByTestId("message-delete-confirm"));
    await waitFor(() => expect(engine.callsTo("removeMessage")).toHaveLength(1));
    await waitFor(() => expect(sentOriginal("chat-1", ID)).toBeUndefined());
    expect(stored()).not.toContain("hello everyone");
    expect(sentOriginal("chat-1", "me_w2")).toEqual({ to: "it", original: "how are you" });
  });
});
