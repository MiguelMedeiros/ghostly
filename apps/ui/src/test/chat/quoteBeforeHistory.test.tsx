import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Chat } from "../../pages/Chat";
import { saveSession } from "../../lib/storage";
import type { ChatMessage } from "../../lib/types";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.replies

const PEER = "peer".padEnd(52, "p"), WIRE = "A".repeat(22), OTHER = "B".repeat(22);

describe("a reply to an older message, right after the app starts on a long chat", () => {
  it("does not say its original was deleted while the stored copy still leaves older messages out", async () => {
    // As a reload finds a long chat: its last rows only, the 4,800 older ones (the original among them) still in the engine.
    const reply: ChatMessage = { id: `peer_${OTHER}`, text: "still on?", sender: "peer", timestamp: 1_700_000_100_000,
      replyTo: { id: WIRE, snippet: "lunch at noon?", from: "me", messageId: `me_${WIRE}` } };
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", messages: [reply], older: 4_800, createdAt: 1_700_000_000_000 });
    const { engine } = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
    engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1" } as never)] });
    await screen.findByText("still on?");
    const quote = screen.getByTestId("message-quote");
    expect(quote).not.toHaveAttribute("data-state", "deleted");
    expect(screen.getByTestId("reply-quote-snippet")).toHaveTextContent("lunch at noon?");
  });
});
