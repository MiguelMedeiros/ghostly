import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MessageReaction } from "@ghostly/browser/shared/types";
import { MessageBubble } from "../../components/MessageBubble";
import type { ChatMessage } from "../../lib/types";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.reactions, chat.waiting

/*
 * A control of a message that its own press takes out of the page (my reaction's chip taken back, the red mark once
 * the message is sent again) had the focus: it stays on the message, so Tab goes on from there, not from the page's top.
 */
const r = (e: string, n = 1, at = n): MessageReaction => ({ e, n, at });
const message = (patch: Partial<ChatMessage> = {}): ChatMessage => ({ id: "m1", text: "lunch at noon?", sender: "peer", timestamp: 1_700_000_000_000, ...patch });
const row = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-message-row]")!;

describe("a message's control that goes away under the keyboard focus", () => {
  it("my reaction taken back from its chip leaves the focus on the message", async () => {
    const bubble = (reactions: ChatMessage["reactions"]) => <MessageBubble message={message({ reactions })} peerPubKey="peer" onReact={() => {}} reactionName={() => "Alice"} />;
    const { user, container, rerender } = renderApp(bubble({ me: r("❤️") }));
    const chip = screen.getByTestId("reaction-chip");
    chip.focus();
    await user.keyboard("{Enter}");
    // The engine takes it back: the chip, alone of its emoji, goes.
    rerender(bubble({ me: r("", 2) }));
    expect(screen.queryByTestId("reaction-chip")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(row(container));
    // A stop of its own only while it holds that focus.
    act(() => row(container).blur());
    expect(row(container)).not.toHaveAttribute("tabindex");
  });

  it("the red mark of a message sent again leaves the focus on the message", async () => {
    const bubble = (delivery: ChatMessage["delivery"]) => <MessageBubble message={message({ sender: "me", delivery })} peerPubKey="peer" />;
    const { user, engine, container, rerender } = renderApp(bubble("failed"));
    act(() => engine.update({ links: [linkView()] }));
    engine.on("retryMessage", () => undefined);
    screen.getByRole("button", { name: "Not sent. Send again" }).focus();
    await user.keyboard("{Enter}");
    expect(engine.callsTo("retryMessage")).toHaveLength(1);
    // On its way again: the mark is no button any more.
    rerender(bubble("sending"));
    expect(screen.getByTestId("message-delivery").tagName).toBe("SPAN");
    expect(document.activeElement).toBe(row(container));
  });

  it("a focus the person moved elsewhere meanwhile is left where it is", async () => {
    const bubble = (reactions: ChatMessage["reactions"]) => <><MessageBubble message={message({ reactions })} peerPubKey="peer" onReact={() => {}} reactionName={() => "Alice"} /><textarea data-testid="composer" /></>;
    const { user, rerender } = renderApp(bubble({ me: r("❤️") }));
    screen.getByTestId("reaction-chip").focus();
    await user.keyboard("{Enter}");
    screen.getByTestId("composer").focus();
    rerender(bubble({ me: r("", 2) }));
    expect(document.activeElement).toBe(screen.getByTestId("composer"));
  });
});
