import { act, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatRow, type ChatRowProps } from "../../components/ChatRow";
import { renderApp } from "../render";

// covers: chats.mute

/*
 * Another page of the app (another profile's, often) writes its keys many times a second, and the browser calls every
 * `storage` listener on the window for each write. A row of the chat list added its own (two for its mute, one for its
 * contact's face): 900 calls per write with 300 chats. The rows share one listener per store now.
 */

const CHATS = 300;
const props = (i: number) => ({ chatId: `chat-${i}`, density: "compact", active: false, label: `Contact ${i}`, named: true, keyLabel: "abcdef...uvwxyz", peerPubKey: `peer-${i}`,
  time: "12:00", unread: 1, pinned: false, syncing: false, creator: false, onOpen: () => {}, onTogglePin: () => {}, onDelete: () => {}, deleteLabel: "Delete" }) as ChatRowProps;
const List = ({ n }: { n: number }) => <>{Array.from({ length: n }, (_, i) => <ChatRow key={i} {...props(i)} />)}</>;

/** The window's `storage` listeners now. */
let listening: Set<unknown>;
beforeEach(() => {
  listening = new Set();
  const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type === "storage") listening.add(listener);
    add(type, listener, options);
  });
  vi.spyOn(window, "removeEventListener").mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    if (type === "storage") listening.delete(listener);
    remove(type, listener, options);
  });
});
afterEach(() => { vi.restoreAllMocks(); });

const rowOf = (chat: string) => screen.getAllByTestId("chat-row").find(r => r.dataset.chat === chat)!;
/** Another page of the app writing `key`. */
const writtenElsewhere = (key: string, value: string | null) => act(() => {
  if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
  window.dispatchEvent(new StorageEvent("storage", { key, newValue: value, storageArea: localStorage }));
});

describe("the chat list and the window's storage listeners", () => {
  it(`${CHATS} rows add a few listeners, not three each`, () => {
    const { rerender } = renderApp(<List n={0} />);
    const without = listening.size;
    rerender(<List n={CHATS} />);
    expect(listening.size - without).toBeLessThanOrEqual(2);
    rerender(<List n={0} />);
    expect(listening.size).toBe(without);
  });

  it("a mute made in another page still shows on its row, and only on its row", () => {
    renderApp(<List n={CHATS} />);
    expect(rowOf("chat-7")).not.toHaveAttribute("data-muted");
    writtenElsewhere("ghostly_mute_chat-7", "forever");
    expect(rowOf("chat-7")).toHaveAttribute("data-muted", "true");
    expect(within(rowOf("chat-7")).getByTestId("chat-row-mute")).toHaveAttribute("data-muted", "forever");
    expect(rowOf("chat-8")).not.toHaveAttribute("data-muted");
    // Another profile's key for a chat of the same id is not this one's.
    writtenElsewhere("ghostly_abcde12345_mute_chat-8", "forever");
    expect(rowOf("chat-8")).not.toHaveAttribute("data-muted");
    writtenElsewhere("ghostly_mute_chat-7", null);
    expect(rowOf("chat-7")).not.toHaveAttribute("data-muted");
  });
});
