import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IncomingCallNotification } from "../../components/IncomingCallNotification";
import { renderApp } from "../render";

// covers: calls.audio, calls.video

/**
 * A contact's newer offer takes the ringing call's place (useWebRTC), and may be the other kind: the card stays up and
 * only `hasVideo` changes. The focus must stay in the card, and the new kind is said once.
 */
function card(hasVideo: boolean, onCall = false) {
  return (
    <IncomingCallNotification peerName="Casper" hasVideo={hasVideo} onCall={onCall}
      onAcceptAudio={vi.fn()} onAcceptVideo={vi.fn()} onReject={vi.fn()} />
  );
}

/** The card's polite region: what it says, and every text it was given (a MutationObserver's count). */
function watchSaid() {
  const region = screen.getByTestId("incoming-call-kind-said");
  const texts: string[] = [];
  const observer = new MutationObserver(() => texts.push(region.textContent ?? ""));
  observer.observe(region, { subtree: true, childList: true, characterData: true });
  return { region, texts, stop: () => observer.disconnect() };
}

describe("the ringing call turns into the other kind", () => {
  it("video to audio with Accept video focused: the focus goes to Accept audio, and 'Now an audio call' is said once", async () => {
    const { rerender } = renderApp(card(true));
    const region = screen.getByTestId("incoming-call-kind-said");
    // Present and empty from the start: a region added with its text is not read by every screen reader.
    expect(region).toHaveAttribute("role", "status");
    expect(region).toHaveTextContent("");
    expect(screen.getByRole("alertdialog")).toContainElement(region);
    screen.getByRole("button", { name: "Accept video call" }).focus();
    const said = watchSaid();
    rerender(card(false));
    await act(async () => {});
    said.stop();
    expect(screen.queryByRole("button", { name: "Accept video call" })).not.toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole("button", { name: "Accept audio call" })).toHaveFocus();
    expect(region).toHaveTextContent("Now an audio call");
    expect(said.texts).toEqual(["Now an audio call"]);
  });

  it("audio to video: the focus stays where it was (never moved onto the camera), 'Now a video call' is said", async () => {
    const { rerender } = renderApp(card(false));
    screen.getByRole("button", { name: "Accept audio call" }).focus();
    rerender(card(true));
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Accept audio call" })).toHaveFocus();
    expect(screen.getByTestId("incoming-call-kind-said")).toHaveTextContent("Now a video call");
  });

  it("a newer offer of the same kind says nothing and keeps the focus", async () => {
    const { rerender } = renderApp(card(true));
    screen.getByRole("button", { name: "Accept video call" }).focus();
    const said = watchSaid();
    rerender(card(true));
    await act(async () => {});
    said.stop();
    expect(screen.getByRole("button", { name: "Accept video call" })).toHaveFocus();
    expect(said.region).toHaveTextContent("");
    expect(said.texts).toEqual([]);
  });

  it("the focus outside the card is left alone: the kind change does not pull it onto Accept", async () => {
    const { rerender } = renderApp(card(true));
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    rerender(card(false));
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Accept audio call" })).not.toHaveFocus();
  });
});
