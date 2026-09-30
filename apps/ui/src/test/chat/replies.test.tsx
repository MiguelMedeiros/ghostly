import { act, fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageReply } from "@ghostly/browser/shared/types";
import { MessageBubble } from "../../components/MessageBubble";
import { MessageInput } from "../../components/MessageInput";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { jumpToMessage, quoteFor, replyIndex, replyTarget, REPLY_FLASH_MS, type NameOf } from "../../lib/replies";
import type { ChatMessage } from "../../lib/types";
import { renderApp } from "../render";

// covers: chat.replies

const WIRE = "A".repeat(22), OTHER = "B".repeat(22);
/** An old message (history: no entry animation) from the contact, unless the patch says otherwise. */
const message = (patch: Partial<ChatMessage> = {}): ChatMessage => ({ id: `peer_${WIRE}`, text: "lunch at noon?", sender: "peer", timestamp: 1_700_000_000_000, ...patch });
const names: NameOf = (from) => from === "me" ? "You" : from === "peer" ? "Alice" : undefined;

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("starting a reply on a message", () => {
  it("its ⋮ says Reply first", async () => {
    const onReply = vi.fn();
    const { user } = renderApp(<MessageBubble message={message()} peerPubKey="peer" onReply={onReply} />);
    await user.click(screen.getByTestId("message-options"));
    const items = within(screen.getByTestId("message-menu")).getAllByRole("button");
    expect(items[0]).toHaveTextContent("Reply");
    await user.click(screen.getByTestId("message-reply"));
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("message-menu")).not.toBeInTheDocument();
  });

  it("a pointer finds a reply button beside it, on either side", async () => {
    const onReply = vi.fn();
    const { user, unmount } = renderApp(<MessageBubble message={message()} peerPubKey="peer" onReply={onReply} />);
    await user.click(screen.getByTestId("message-reply-action"));
    unmount();
    renderApp(<MessageBubble message={message({ id: `me_${WIRE}`, sender: "me" })} peerPubKey="peer" onReply={onReply} />);
    fireEvent.click(screen.getByTestId("message-reply-action"));
    expect(onReply).toHaveBeenCalledTimes(2);
  });

  it("a finger swiping it right past the threshold replies; a short, a vertical or a mouse drag does not", () => {
    const onReply = vi.fn();
    const { container } = renderApp(<MessageBubble message={message()} peerPubKey="peer" onReply={onReply} />);
    const row = container.querySelector<HTMLElement>("[data-message-row]")!;
    const swipe = (dx: number, dy = 0, pointerType = "touch") => {
      fireEvent.pointerDown(row, { pointerType, button: 0, clientX: 20, clientY: 20, pointerId: 1 });
      fireEvent.pointerMove(row, { pointerType, clientX: 20 + dx / 2, clientY: 20 + dy / 2, pointerId: 1 });
      fireEvent.pointerMove(row, { pointerType, clientX: 20 + dx, clientY: 20 + dy, pointerId: 1 });
      fireEvent.pointerUp(row, { pointerType, clientX: 20 + dx, clientY: 20 + dy, pointerId: 1 });
    };
    swipe(30);
    swipe(10, 80);
    swipe(90, 0, "mouse");
    expect(onReply).not.toHaveBeenCalled();
    // While it moves, the message follows and the reply mark shows.
    fireEvent.pointerDown(row, { pointerType: "touch", button: 0, clientX: 20, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(row, { pointerType: "touch", clientX: 50, clientY: 21, pointerId: 1 });
    fireEvent.pointerMove(row, { pointerType: "touch", clientX: 90, clientY: 22, pointerId: 1 });
    expect(screen.getByTestId("swipe-reply-hint")).toBeInTheDocument();
    expect(container.querySelector<HTMLElement>("[data-message-bubble]")!.style.transform).toBe("translateX(70px)");
    fireEvent.pointerUp(row, { pointerType: "touch", clientX: 90, clientY: 22, pointerId: 1 });
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("swipe-reply-hint")).not.toBeInTheDocument();
  });

  it("without onReply (a compatibility chat, a notice) there is none of it", async () => {
    const { user } = renderApp(<MessageBubble message={message()} peerPubKey="peer" />);
    expect(screen.queryByTestId("message-reply-action")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("message-options"));
    expect(screen.queryByTestId("message-reply")).not.toBeInTheDocument();
    expect(replyTarget(message({ sender: "system", systemEvent: { type: "join" } }))).toBeUndefined();
    expect(replyTarget(message({ id: "me_1700000000000", sender: "system", callEvent: { type: "call_ended" } }))).toBeUndefined();
    expect(replyTarget(message())).toBe(WIRE);
  });
});

describe("the composer's quote bar", () => {
  function Composer({ onSend }: { onSend: (text: string) => Promise<string | null> }) {
    const [replying, setReplying] = useState<ChatMessage | null>(null);
    return <LockScreenProvider>
      <button onClick={() => setReplying(message())}>answer lunch</button>
      <button onClick={() => setReplying(message({ id: `me_${OTHER}`, sender: "me", text: "line one\nline two" }))}>answer mine</button>
      <MessageInput onSend={onSend} reply={replying ? { key: replying.id, name: replying.sender === "me" ? "You" : "Alice", snippet: replying.text.replace(/\s+/g, " "),
        mine: replying.sender === "me", onCancel: () => setReplying(null) } : undefined} />
    </LockScreenProvider>;
  }
  const field = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");

  it("names whom I answer and a line of it, takes the focus, and ✕ lets go", async () => {
    const { user } = renderApp(<Composer onSend={async () => null} />);
    expect(screen.queryByTestId("composer-reply")).not.toBeInTheDocument();
    await user.click(screen.getByText("answer lunch"));
    const bar = screen.getByTestId("composer-reply");
    expect(within(bar).getByTestId("reply-quote-name")).toHaveTextContent("Alice");
    expect(within(bar).getByTestId("reply-quote-snippet")).toHaveTextContent("lunch at noon?");
    expect(field()).toHaveFocus();
    await user.click(screen.getByText("answer mine"));
    expect(within(screen.getByTestId("composer-reply")).getByTestId("reply-quote-name")).toHaveTextContent("You");
    expect(within(screen.getByTestId("composer-reply")).getByTestId("reply-quote-snippet")).toHaveTextContent("line one line two");
    await user.click(screen.getByTestId("composer-reply-cancel"));
    expect(screen.queryByTestId("composer-reply")).not.toBeInTheDocument();
    expect(field()).toHaveFocus();
  });

  it("Escape in the field lets go of it, and keeps the draft", async () => {
    const { user } = renderApp(<Composer onSend={async () => null} />);
    await user.click(screen.getByText("answer lunch"));
    await user.type(field(), "yes");
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("composer-reply")).not.toBeInTheDocument();
    expect(field()).toHaveValue("yes");
  });
});

describe("the quote on a reply's bubble", () => {
  const quoted = (reply: MessageReply, list: ChatMessage[]) => quoteFor(reply, replyIndex(list), names);

  it("shows the original as it is here, not as the wire said, and a tap scrolls to it and marks it a moment", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const original = message();
    const reply = message({ id: `me_${OTHER}`, sender: "me", text: "yes!", replyTo: { id: WIRE, snippet: "something else", from: "peer", messageId: original.id } });
    const quote = quoted(reply.replyTo!, [original, reply]);
    expect(quote).toEqual({ state: "found", name: "Alice", snippet: "lunch at noon?", mine: false, targetId: original.id });
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { user } = renderApp(<div data-message-list>
      <MessageBubble message={original} peerPubKey="peer" />
      <MessageBubble message={reply} peerPubKey="peer" quote={quote} />
    </div>);
    const block = screen.getByTestId("message-quote");
    expect(block).toHaveAttribute("data-state", "found");
    expect(within(block).getByTestId("reply-quote-name")).toHaveTextContent("Alice");
    expect(within(block).getByTestId("reply-quote-snippet")).toHaveTextContent("lunch at noon?");
    await user.click(block);
    const row = document.querySelector(`[data-message-id="${original.id}"]`)!;
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ block: "center" }));
    expect(row).toHaveAttribute("data-reply-flash");
    // A tap on the quote is only the jump: it does not open the reply's details.
    expect(screen.queryByTestId("message-details")).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(REPLY_FLASH_MS + 10); });
    expect(row).not.toHaveAttribute("data-reply-flash");
  });

  it("finds an original by the id both sides know, when the reply came before it or with only its id", () => {
    const original = message();
    expect(quoted({ id: WIRE, snippet: "" }, [original])).toMatchObject({ state: "found", name: "Alice", snippet: "lunch at noon?" });
  });

  it("an original that was here and is gone says it was deleted, and a tap says it is not here", async () => {
    const reply = message({ id: `peer_${OTHER}`, text: "?", replyTo: { id: WIRE, snippet: "lunch at noon?", from: "me", messageId: `me_${WIRE}` } });
    const quote = quoted(reply.replyTo!, [reply]);
    expect(quote).toMatchObject({ state: "deleted", name: "You", snippet: "" });
    const { user } = renderApp(<MessageBubble message={reply} peerPubKey="peer" quote={quote} />);
    expect(screen.getByTestId("reply-quote-snippet")).toHaveTextContent("Original message deleted");
    await user.click(screen.getByTestId("message-quote"));
    expect(screen.getByTestId("reply-quote-note")).toHaveTextContent("The original is not in this chat");
  });

  it("an original never here shows the replier's line, marked as not found here", () => {
    const quote = quoted({ id: WIRE, snippet: "a line they sent", from: "peer" }, []);
    expect(quote).toEqual({ state: "unverified", name: "Alice", snippet: "a line they sent", mine: false });
    renderApp(<MessageBubble message={message({ id: `peer_${OTHER}` })} peerPubKey="peer" quote={quote} />);
    expect(screen.getByTestId("message-quote")).toHaveAttribute("data-state", "unverified");
    expect(screen.getByTestId("reply-quote-snippet")).toHaveTextContent("a line they sent");
    expect(screen.getByTestId("reply-quote-note")).toHaveTextContent("Not found in this chat");
  });

  it("only an id, and nothing here by it: the original is not available", () => {
    const quote = quoted({ id: WIRE, snippet: "" }, []);
    expect(quote).toEqual({ state: "missing", name: undefined, snippet: "", mine: false });
    renderApp(<MessageBubble message={message({ id: `peer_${OTHER}` })} peerPubKey="peer" quote={quote} />);
    expect(screen.getByTestId("reply-quote-snippet")).toHaveTextContent("Original message not available");
    expect(screen.queryByTestId("reply-quote-name")).not.toBeInTheDocument();
  });

  it("a jump to what is not on the page is refused", () => {
    expect(jumpToMessage("nowhere")).toBe(false);
  });
});
