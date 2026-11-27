import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
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
 * React, Pin and Save were refused with nothing said, and Forward (or a choice with it in) refused too: none of them
 * is offered, as Delete for everyone is not.
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

const OFFERED = ["message-reply", "message-react", "message-pin", "message-save", "message-forward", "message-select-start"];
const HELLO = { id: "peer_1700000000400", text: "hello", sender: "peer", timestamp: 1_700_000_000_400 };

async function neverSent(messages: object[] = [file()]) {
  const utils = openChat(messages);
  const bubble = (await screen.findByText("notes.txt")).closest<HTMLElement>(`[data-message-id="${SENT}"]`)!;
  act(() => utils.engine.update({ transfers: { [FILE]: { state: "failed", direction: "out", transferred: 0, size: 3000, error: "Not enough space on this device to send it", retry: false } } } as never));
  await waitFor(() => expect(within(bubble).getByTestId("message-delivery")).toHaveAttribute("data-delivery", "failed"));
  return { ...utils, bubble };
}

describe("a file that never left this device", () => {
  it("offers Reply, React, Pin, Save, Forward and Select while it went", async () => {
    const { user } = openChat([file({ delivery: "delivered" })]);
    const bubble = (await screen.findByText("notes.txt")).closest<HTMLElement>(`[data-message-id="${SENT}"]`)!;
    expect(within(bubble).getByTestId("message-reply-action")).toBeInTheDocument();
    await user.click(within(bubble).getByTestId("message-options"));
    for (const id of OFFERED) expect(screen.getByTestId(id)).toBeInTheDocument();
  });

  it("offers no Reply, React, Pin, Save, Forward or Select, which the engine has no row for", async () => {
    const { user, bubble } = await neverSent();
    expect(within(bubble).queryByTestId("message-reply-action")).toBeNull();
    await user.click(within(bubble).getByTestId("message-options"));
    expect(screen.getByTestId("message-delete")).toBeInTheDocument();
    for (const id of OFFERED) expect(screen.queryByTestId(id)).toBeNull();
  });

  it("a long press opens its details, not a choice to forward", async () => {
    const { bubble } = await neverSent();
    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(within(bubble).getByText("notes.txt"), { pointerType: "touch", button: 0 });
      act(() => { vi.advanceTimersByTime(600); });
    } finally {
      vi.useRealTimers();
    }
    expect(screen.queryByTestId("select-bar")).toBeNull();
    expect(document.querySelector(`[data-message-id="${SENT}"][data-details-open]`)).not.toBeNull();
  });

  it("cannot be chosen into a forward started on another message", async () => {
    const { user } = await neverSent([HELLO, file()]);
    const hello = screen.getByText("hello").closest<HTMLElement>(`[data-message-id="${HELLO.id}"]`)!;
    await user.click(within(hello).getByTestId("message-options"));
    await user.click(screen.getByTestId("message-select-start"));
    expect(screen.getByTestId("select-count")).toHaveTextContent("1 selected");
    const row = document.querySelector<HTMLElement>(`[data-message-id="${SENT}"]`)!;
    expect(within(row).getByTestId("message-select")).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(within(row).getByText("notes.txt"));
    fireEvent.keyDown(within(row).getByTestId("message-select"), { key: " " });
    expect(screen.getByTestId("select-count")).toHaveTextContent("1 selected");
  });
});
