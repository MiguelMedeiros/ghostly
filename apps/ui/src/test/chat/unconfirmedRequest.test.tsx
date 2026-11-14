import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import type { ChatMessage } from "../../lib/types";
import { renderApp } from "../render";

const message = (patch: Partial<ChatMessage> = {}): ChatMessage => ({ id: "m1", text: "Hi, it's me", sender: "peer", timestamp: 1_700_000_000_000, ...patch });

describe("a contact request's text in the chat (WISP 8xx § Accept)", () => {
  it("says Not confirmed until the requester's app confirmed it, and nothing once it did", () => {
    const { rerender } = renderApp(<MessageBubble message={message({ unconfirmed: true })} peerPubKey="peer" />);
    const mark = screen.getByTestId("message-unconfirmed");
    expect(mark).toHaveTextContent("Not confirmed");
    expect(mark).toHaveAttribute("title", "Sent with a contact request. Their app has not confirmed yet that it sent this.");
    rerender(<MessageBubble message={message()} peerPubKey="peer" />);
    expect(screen.queryByTestId("message-unconfirmed")).toBeNull();
  });
});
