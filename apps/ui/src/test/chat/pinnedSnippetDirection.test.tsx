import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PinnedBar } from "../../components/chat/PinnedBar";
import { replyIndex } from "../../lib/replies";
import type { ChatMessage } from "../../lib/types";
import { renderApp } from "../render";

// covers: chat.pins groups.pins

/**
 * The pinned bar's line takes its direction from the message, as the reply bar's does: a Latin message in an Arabic
 * app (or an Arabic one in an English app) is cut at its end. In the page's direction it lost its start instead
 * ("… to cut on a narrow phone"). The 1:1 chat and the group page both draw this same bar.
 */
const WIRE = "P".repeat(22);
const pin = { id: WIRE, messageId: `peer_${WIRE}` } as never;

function bar(text: string) {
  const message: ChatMessage = { id: `peer_${WIRE}`, text, sender: "peer", timestamp: 1_700_000_000_000 };
  return <PinnedBar pin={pin} index={replyIndex([message])} />;
}

describe("the pinned message's line, in the other script's direction", () => {
  it("a Latin message in an Arabic app takes its own direction", () => {
    renderApp(bar("A long message from Alice that wraps over a few lines to cut on a narrow phone"), { language: "ar" });
    const snippet = screen.getByTestId("pinned-snippet");
    expect(snippet).toHaveAttribute("dir", "auto");
    expect(snippet).toHaveClass("truncate");
  });

  it("an Arabic message in an English app takes its own direction", () => {
    renderApp(bar("رسالة طويلة من أليس تمتد على عدة أسطر لتقطع على هاتف ضيق"), { language: "en" });
    expect(screen.getByTestId("pinned-snippet")).toHaveAttribute("dir", "auto");
  });

  it("the line for a message not in this chat's history takes its own direction too", () => {
    renderApp(<PinnedBar pin={pin} index={replyIndex([])} />, { language: "ar" });
    expect(screen.getByTestId("pinned-snippet")).toHaveAttribute("dir", "auto");
  });
});
