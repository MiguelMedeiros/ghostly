import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { saveSession, setStorageProfile as setProfile } from "../../lib/storage";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.replies, chat.reactions, chat.pins, chat.forward

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

/**
 * A large file sent from this page whose copy into this device failed (no room): the page made its row, but the file
 * never went to the engine, which has no row of it. Reply was refused at Send ("That message is not in this chat"),
 * React and Pin were refused with nothing said, and Forward refused too: none of them is offered, as Delete for
 * everyone is not.
 */
const PEER = "peer".padEnd(52, "p");
const SENT = "me_1700000000500";
const FILE = "chat-1-out-AbCdEfGhIjKlMnOp";
const file = (patch: object = {}) => ({ id: SENT, text: "", sender: "me", timestamp: 1_700_000_000_500,
  file: { id: FILE, name: "notes.txt", size: 3000, mime: "text/plain" }, ...patch });

function openChat(messages: object[]) {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", createdAt: 1_700_000_000_000, messages: messages as never });
  const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
  utils.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", dataLink: "open" } as never)] });
  return utils;
}

afterEach(() => { localStorage.clear(); setProfile(""); });

describe("a file that never left this device", () => {
  it("offers Reply, React, Pin and Forward while it went", async () => {
    const { user } = openChat([file({ delivery: "delivered" })]);
    const bubble = (await screen.findByText("notes.txt")).closest<HTMLElement>(`[data-message-id="${SENT}"]`)!;
    expect(within(bubble).getByTestId("message-reply-action")).toBeInTheDocument();
    await user.click(within(bubble).getByTestId("message-options"));
    for (const id of ["message-reply", "message-react", "message-pin", "message-forward"]) expect(screen.getByTestId(id)).toBeInTheDocument();
  });

  it("offers no Reply, React, Pin or Forward, which the engine has no row for", async () => {
    const { user, engine } = openChat([file()]);
    const bubble = (await screen.findByText("notes.txt")).closest<HTMLElement>(`[data-message-id="${SENT}"]`)!;
    act(() => engine.update({ transfers: { [FILE]: { state: "failed", direction: "out", transferred: 0, size: 3000, error: "Not enough space on this device to send it", retry: false } } } as never));
    await waitFor(() => expect(within(bubble).getByTestId("message-delivery")).toHaveAttribute("data-delivery", "failed"));
    expect(within(bubble).queryByTestId("message-reply-action")).toBeNull();
    await user.click(within(bubble).getByTestId("message-options"));
    expect(screen.getByTestId("message-delete")).toBeInTheDocument();
    for (const id of ["message-reply", "message-react", "message-pin", "message-forward"]) expect(screen.queryByTestId(id)).toBeNull();
  });
});
