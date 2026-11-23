import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IncomingCallNotification } from "../../components/IncomingCallNotification";
import { renderApp } from "../render";

// covers: calls.audio

/**
 * Two chats can ring at once, each with its own card. The second card's return target is the first card's box: once
 * that card is gone, the focus goes back past it to where it was before either rang (the composer), not to the page.
 */
function card(peerName: string) {
  return (
    <IncomingCallNotification peerName={peerName} hasVideo={false}
      onAcceptAudio={vi.fn()} onAcceptVideo={vi.fn()} onReject={vi.fn()} />
  );
}

function composer() {
  const input = document.createElement("input");
  input.setAttribute("aria-label", "Message");
  document.body.append(input);
  input.focus();
  return input;
}

describe("the focus after a ringing card goes", () => {
  it("one card: back to the composer", async () => {
    const input = composer();
    const a = renderApp(card("Casper"));
    expect(input).not.toHaveFocus();
    await act(async () => a.unmount());
    expect(input).toHaveFocus();
    input.remove();
  });

  it("two cards, the first's ringing ends, then the second is declined: back to the composer, not the page", async () => {
    const input = composer();
    const a = renderApp(card("Casper"));
    const b = renderApp(card("Wendy"));
    await act(async () => a.unmount());
    // The focus is in the card still ringing; the one gone takes nothing.
    expect(document.activeElement).toHaveAttribute("data-testid", "incoming-call");
    await act(async () => b.unmount());
    expect(document.activeElement).not.toBe(document.body);
    expect(input).toHaveFocus();
    input.remove();
  });

  it("two cards, the second goes first: back to the first card, then to the composer", async () => {
    const input = composer();
    const a = renderApp(card("Casper"));
    const b = renderApp(card("Wendy"));
    await act(async () => b.unmount());
    expect(a.getByRole("alertdialog")).toHaveFocus();
    await act(async () => a.unmount());
    expect(input).toHaveFocus();
    input.remove();
  });
});
