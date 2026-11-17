import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { replySnippet } from "@ghostly/core";
import { MessageBubble } from "../../components/MessageBubble";
import { MessageInput } from "../../components/MessageInput";
import { PinnedBar } from "../../components/chat/PinnedBar";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { previewText } from "../../lib/chatList";
import { messageSnippet, quoteFor, replyIndex, sentReply, type NameOf } from "../../lib/replies";
import type { ChatMessage } from "../../lib/types";
import { renderApp } from "../render";

// covers: chat.replies chat.pins
describe("a message with a link and formatting where it is quoted or pinned", () => {
  /**
   * The chat list reads "See the docs now"; a reply's quote, the reply bar and the pinned bar showed the markdown as
   * written, brackets, address and `**` (the 120-point line filled by the address). They read it as the chat list does:
   * spoilers covered, and a link whose words look like another address shows where it really goes. What a reply sends
   * (`r.s` on the wire) is left as it was: only what this side draws changes.
   */
  const WIRE = "L".repeat(22), OTHER = "M".repeat(22);
  const URL = "https://ghostly.tools/docs/getting-started/very/long/path";
  const TEXT = `See [the docs](${URL}) **now**`;
  const message = (text: string): ChatMessage => ({ id: `peer_${WIRE}`, text, sender: "peer", timestamp: 1_700_000_000_000 });
  const names: NameOf = (from) => from === "me" ? "You" : from === "peer" ? "Alice" : undefined;

  function quoteBubble(text: string) {
    const original = message(text);
    const reply: ChatMessage = { id: `me_${OTHER}`, sender: "me", text: "ok", timestamp: 1_700_000_001_000,
      replyTo: { id: WIRE, snippet: replySnippet(text), from: "peer", messageId: original.id } };
    const quote = quoteFor(reply.replyTo!, replyIndex([original, reply]), names);
    return <MessageBubble message={reply} peerPubKey="peer" quote={quote} />;
  }

  function composer(text: string) {
    const original = message(text);
    return <LockScreenProvider>
      <MessageInput onSend={async () => null} reply={{ key: original.id, name: "Alice", snippet: messageSnippet(original), mine: false, onCancel: () => {} }} />
    </LockScreenProvider>;
  }

  const pinned = (text: string) => <PinnedBar pin={{ id: WIRE, messageId: `peer_${WIRE}` } as never} index={replyIndex([message(text)])} />;

  it("reads as the chat list's line", () => {
    expect(previewText(TEXT)).toBe("See the docs now");
    expect(messageSnippet({ text: TEXT })).toBe("See the docs now");
  });

  it.each(["en", "ar"] as const)("the quote under a reply shows it plain (%s)", (language) => {
    renderApp(quoteBubble(TEXT), { language });
    expect(within(screen.getByTestId("message-quote")).getByTestId("reply-quote-snippet")).toHaveTextContent(/^See the docs now$/);
  });

  it.each(["en", "ar"] as const)("the reply bar above the composer shows it plain (%s)", (language) => {
    renderApp(composer(TEXT), { language });
    expect(within(screen.getByTestId("composer-reply")).getByTestId("reply-quote-snippet")).toHaveTextContent(/^See the docs now$/);
  });

  it.each(["en", "ar"] as const)("the pinned bar shows it plain (%s)", (language) => {
    renderApp(pinned(TEXT), { language });
    expect(screen.getByTestId("pinned-snippet")).toHaveTextContent(/^See the docs now$/);
  });

  it("a spoiler stays covered, in the link's words too, and its address is not shown", () => {
    const text = "See [the docs](https://ghostly.tools/docs) and ||the butler did it||, or [||this one||](https://ghostly.tools/secret)";
    expect(messageSnippet({ text })).toBe("See the docs and ▒▒▒, or ▒▒▒");
    renderApp(<>{quoteBubble(text)}{pinned(text)}</>);
    expect(within(screen.getByTestId("message-quote")).getByTestId("reply-quote-snippet")).toHaveTextContent(/^See the docs and ▒▒▒, or ▒▒▒$/);
    expect(screen.getByTestId("pinned-snippet")).toHaveTextContent(/^See the docs and ▒▒▒, or ▒▒▒$/);
  });

  it("a link whose words name another address shows the address it goes to", () => {
    const text = "Pay at [https://ghostly.tools/pay](https://other.example/pay)";
    const line = messageSnippet({ text });
    expect(line).toContain("other.example");
    expect(line).not.toContain("ghostly.tools");
    expect(line).not.toContain("[");
    renderApp(<>{quoteBubble(text)}{composer(text)}{pinned(text)}</>);
    for (const shown of [within(screen.getByTestId("message-quote")).getByTestId("reply-quote-snippet"),
      within(screen.getByTestId("composer-reply")).getByTestId("reply-quote-snippet"), screen.getByTestId("pinned-snippet")]) {
      expect(shown).toHaveTextContent(line);
    }
  });

  it("a line that came on the wire with its markdown (the original not here) is shown plain too", () => {
    const quote = quoteFor({ id: WIRE, snippet: "See [the docs](https://ghostly.tools/docs) **now**", from: "peer" }, replyIndex([]), names);
    expect(quote).toEqual({ state: "unverified", name: "Alice", snippet: "See the docs now", mine: false });
    const spoiled = quoteFor({ id: WIRE, snippet: "[https://ghostly.tools](https://other.example/x) ||secret||", from: "peer" }, replyIndex([]), names);
    expect(spoiled.snippet).toContain("other.example");
    expect(spoiled.snippet).not.toContain("secret");
  });

  it("what a reply sends is unchanged: the wire's line is the core snippet of the text", () => {
    expect(sentReply(message(TEXT))?.snippet).toBe(replySnippet(TEXT));
  });
});
