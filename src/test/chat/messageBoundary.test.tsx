import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { MessageBubble } from "../../components/MessageBubble";
import type { ChatMessage } from "../../lib/types";
import { renderApp } from "../render";

// covers: chat.rich.time, chat.rich.code, chat.paired.links

/*
 * What a peer puts in one message stays in that message's bubble: a bubble that throws shows a note where it was,
 * and the app-wide "Something went wrong" never takes the chat down.
 */
const SENT = Date.UTC(2026, 8, 25, 12);
const message = (patch: Partial<ChatMessage>): ChatMessage => ({ id: "m1", text: "hi", sender: "peer", timestamp: SENT, ...patch });
const chat = (...messages: ChatMessage[]) => renderApp(
  <ErrorBoundary>{messages.map(m => <MessageBubble key={m.id} message={m} peerPubKey="peer" />)}</ErrorBoundary>,
);

afterEach(() => vi.restoreAllMocks());

describe("one message that cannot be drawn", () => {
  it("shows a note in its place, and the rest of the chat as it is", () => {
    // React reports the error it caught; the boundary logs it too.
    vi.spyOn(console, "error").mockImplementation(() => {});
    chat(message({ id: "bad", text: { not: "text" } as never }), message({ id: "good", text: "still here" }));
    expect(screen.getByTestId("message-unshowable")).toHaveTextContent("This message could not be shown.");
    expect(screen.getByTestId("message-text")).toHaveTextContent("still here");
    expect(screen.queryByTestId("app-error")).toBeNull();
  });
});

describe("what a peer can put in a message", () => {
  it("a sending time no date holds leaves the time as text", () => {
    chat(message({ text: "see you at 14:00 UTC", timestamp: Number.MAX_SAFE_INTEGER }));
    expect(screen.getByTestId("message-text")).toHaveTextContent("see you at 14:00 UTC");
    expect(screen.queryByTestId("rich-time")).toBeNull();
    expect(screen.queryByTestId("message-unshowable")).toBeNull();
    expect(screen.queryByTestId("app-error")).toBeNull();
  });

  it("a direction override cannot make a link show another address", () => {
    chat(message({ text: "look ‮ https://evil.example/‮moc.elgoog.www//:sptth" }));
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("dir", "ltr");
    expect(link.parentElement?.tagName).toBe("BDI");
    expect(link.textContent).toBe("https://evil.example/%E2%80%AEmoc.elgoog.www//:sptth");
  });

  it("deeply nested JSON shows as written, at once", () => {
    const deep = "[".repeat(8191) + "1" + "]".repeat(8191);
    const start = performance.now();
    chat(message({ text: deep }));
    expect(performance.now() - start).toBeLessThan(1000);
    expect(screen.queryByTestId("rich-codeblock")).toBeNull();
    expect(screen.getByTestId("message-text").textContent).toBe(deep);
  });
});
