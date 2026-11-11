import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PinnedBar } from "../../components/chat/PinnedBar";
import { ReplyBar, ReplyQuote } from "../../components/chat/ReplyQuote";
import { previewText } from "../../lib/chatList";
import { messageSnippet, quoteFor, replyIndex, sentReply } from "../../lib/replies";
import type { ChatMessage } from "../../lib/types";
import { renderApp } from "../render";

// covers: chat.replies chat.pins

/**
 * A spoiler stays covered until its reader taps it in the bubble. A reply's quote, the reply bar, the pinned bar and
 * the line a reply sends showed its words, markers and all; they read it as the chat list does: ▒▒▒.
 */
const WIRE = "S".repeat(22);
const TEXT = "Spoiler: ||the butler did it||";
const message: ChatMessage = { id: `peer_${WIRE}`, text: TEXT, sender: "peer", timestamp: 1_700_000_000_000 };
const index = replyIndex([message]);

describe("a spoiler where its message is quoted or pinned", () => {
  it("the chat list covers it (what the others follow)", () => {
    expect(previewText(TEXT)).toBe("Spoiler: ▒▒▒");
  });

  it("the quote under a reply covers it", () => {
    const quote = quoteFor({ id: WIRE, snippet: "", from: "peer", messageId: message.id }, index, () => "Alice");
    renderApp(<ReplyQuote quote={quote} />);
    expect(screen.getByTestId("reply-quote-snippet")).toHaveTextContent(/^Spoiler: ▒▒▒$/);
  });

  it("the reply bar covers it", () => {
    renderApp(<ReplyBar name="Alice" snippet={messageSnippet(message)} mine={false} onCancel={() => {}} />);
    expect(screen.getByTestId("reply-quote-snippet")).toHaveTextContent(/^Spoiler: ▒▒▒$/);
  });

  it("the pinned bar covers it", () => {
    renderApp(<PinnedBar pin={{ id: WIRE, messageId: message.id } as never} index={index} />);
    expect(screen.getByTestId("pinned-snippet")).toHaveTextContent(/^Spoiler: ▒▒▒$/);
  });

  it("the line a reply sends covers it, so the contact's app never shows it either", () => {
    expect(sentReply(message)?.snippet).toBe("Spoiler: ▒▒▒");
  });

  it("other formatting in the line stays as it was", () => {
    expect(messageSnippet({ text: "**bold** and ~~gone~~" })).toBe("**bold** and ~~gone~~");
  });
});
