import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { loadSession, saveSession } from "../../lib/storage";
import { servicesPlatform } from "../../lib/platform";
import type { ChatMessage } from "../../lib/types";
import { linkView } from "../fakeEngine";
import { everythingOnScreen } from "../onScreen";
import { pngHead } from "../pngHead";
import { renderApp } from "../render";

// covers: chat.scroll

/**
 * A picture open large from a message, or the message's details, stays open while messages come into the chat, in a
 * long chat too: the rows in the page are a window of its history (useRowWindow), and past its most rows a batch at the
 * bottom took the place of the row that drew it, closing it and leaving the focus on the page's body.
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const PEER = "peer".padEnd(52, "p");
const wire = (i: number) => `w${String(i).padStart(21, "0")}`;
const text = (i: number): ChatMessage => ({ id: `peer_${wire(i)}`, ref: wire(i), sender: "peer", timestamp: 1_700_000_000_000 + i * 1_000, text: `Message ${i}` });
const PICTURE = { id: "chat-1-in-picture", name: "beach.png", size: 3, mime: "image/png" };

/** `count` texts from the contact, the last one a picture. */
function history(count: number): ChatMessage[] {
  const messages = Array.from({ length: count }, (_, i) => text(i));
  messages[count - 1] = { ...messages[count - 1], text: "", file: PICTURE };
  return messages;
}

function openChat(count: number) {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: history(count), createdAt: 1_700_000_000_000 });
  const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
  utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
  utils.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
  return utils;
}

/** `n` more messages from the contact: in one change (a catch-up), or each in its own (a busy bot). */
function arrive(n: number, oneByOne: boolean) {
  const session = loadSession("chat-1")!;
  const from = session.messages.length;
  for (let i = 0; i < n; i++) {
    act(() => {
      const now = loadSession("chat-1")!;
      now.messages.push(...(oneByOne ? [text(from + i)] : Array.from({ length: n }, (_, k) => text(from + k))));
      saveSession(now);
      window.dispatchEvent(new Event("session-updated"));
    });
    if (!oneByOne) return;
  }
}

/** The picture's row, by its message's id. */
const pictureRow = (count: number) => document.querySelector<HTMLElement>(`[data-message-id="peer_${wire(count - 1)}"]`);

async function openPicture(count: number) {
  const row = pictureRow(count)!;
  const image = await within(row).findByRole("img", { name: "beach.png" });
  fireEvent.load(image);
  act(() => within(row).getByTestId("file-picture-open").click());
  expect(screen.getByTestId("avatar-viewer")).toBeInTheDocument();
}

beforeEach(() => {
  everythingOnScreen();
  vi.spyOn(servicesPlatform!, "getFile").mockResolvedValue(pngHead(640, 480));
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:beach");
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("something open from a message while messages come", () => {
  it.each([
    ["a long chat, a catch-up in one change", 5_000, false],
    ["a long chat, a busy bot one by one", 5_000, true],
    ["a short chat", 20, false],
  ])("a picture open large stays open: %s", { timeout: 20_000 }, async (_, count, oneByOne) => {
    openChat(count);
    await openPicture(count);
    // One by one, each a save of the whole history: seconds on a slow runner.
    arrive(120, oneByOne);
    expect(screen.getByTestId("avatar-viewer")).toBeInTheDocument();
    expect(pictureRow(count)).not.toBeNull();
    // Closed by the person: the focus goes back to the picture, never to the page's body.
    act(() => screen.getByTestId("avatar-viewer-close").click());
    expect(screen.queryByTestId("avatar-viewer")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(within(pictureRow(count)!).getByTestId("file-picture-open"));
  });

  it("a message's details stay open in a long chat while a catch-up comes", async () => {
    openChat(5_000);
    const row = pictureRow(5_000)!;
    await within(row).findByRole("img", { name: "beach.png" });
    fireEvent.doubleClick(row, { ctrlKey: true });
    expect(await screen.findByTestId("message-details")).toBeInTheDocument();
    arrive(120, false);
    expect(screen.getByTestId("message-details")).toBeInTheDocument();
    expect(pictureRow(5_000)).toHaveAttribute("data-details-open");
  });
});
