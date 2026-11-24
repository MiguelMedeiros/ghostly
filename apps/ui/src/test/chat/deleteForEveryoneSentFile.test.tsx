import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { saveSession, setStorageProfile as setProfile } from "../../lib/storage";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.paired.delete-message, files.paired.send

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

/**
 * A file or a voice message sent from this page: the page makes its row itself (`me_<time>`, the file with its id),
 * with no `ref`, and the engine's row never adds one. Delete for everyone read only `ref`, so a file sent here never
 * offered it, while Reply, React and Pin, which read the id from the file's, did (WISP 400 § Delete for everyone).
 */
const PEER = "peer".padEnd(52, "p");
const SENT = "me_1700000000500";
const file = (patch: object = {}) => ({ id: SENT, text: "", sender: "me", timestamp: 1_700_000_000_500, delivery: "delivered",
  file: { id: "chat-1-out-AbCdEfGhIjKlMnOp", name: "notes.txt", size: 3000, mime: "text/plain" }, ...patch });

function openChat(messages: object[]) {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", createdAt: 1_700_000_000_000, messages: messages as never });
  const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
  utils.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", dataLink: "open" } as never)] });
  return utils;
}

afterEach(() => { localStorage.clear(); setProfile(""); });

describe("Delete for everyone on a file sent from this page", () => {
  it("is offered on a sent file whose row has no ref, and asks the engine for that row", async () => {
    const { user, engine } = openChat([file()]);
    engine.on("removeMessage", () => ({ error: null }));
    const bubble = (await screen.findByText("notes.txt")).closest<HTMLElement>(`[data-message-id="${SENT}"]`)!;
    await user.click(within(bubble).getByTestId("message-options"));
    await user.click(screen.getByTestId("message-delete-everyone"));
    await user.click(screen.getByTestId("message-delete-confirm"));
    await waitFor(() => expect(engine.callsTo("removeMessage")).toEqual([{ linkId: "link-1", messageId: SENT }]));
  });

  it("is not offered while the file still waits to be sent", async () => {
    const { user } = openChat([file({ delivery: "waiting" })]);
    const bubble = (await screen.findByText("notes.txt")).closest<HTMLElement>(`[data-message-id="${SENT}"]`)!;
    await user.click(within(bubble).getByTestId("message-options"));
    expect(screen.queryByTestId("message-delete-everyone")).toBeNull();
  });
});
