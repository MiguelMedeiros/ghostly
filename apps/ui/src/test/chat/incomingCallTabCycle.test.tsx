import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IncomingCallNotification } from "../../components/IncomingCallNotification";
import { renderApp } from "../render";

// covers: app.keyboard, calls.audio

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

/** The focused control's name, as a screen reader says it: the round buttons have only their label. */
const focusedName = () => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "";

const ring = (hasVideo: boolean) => <IncomingCallNotification peerName="Casper" hasVideo={hasVideo} onAcceptAudio={vi.fn()} onAcceptVideo={vi.fn()} onReject={vi.fn()} onDelete={vi.fn()} />;

/**
 * The ringing card's Delete chat sits under its answers: Tab goes Decline, Accept, then Delete chat, and from there
 * round to Decline again, never to the page behind the card; Shift+Tab goes the other way round. The keyboard-only
 * call spec expected Tab from Accept to wrap to Decline once Delete chat was added.
 */
describe("the ringing card's Tab cycle", () => {
  it("an audio call: Decline, Accept, Delete chat, and round again both ways", async () => {
    const { user } = renderApp(<><button>Behind</button>{ring(false)}</>);
    const card = screen.getByRole("alertdialog");
    expect(card).toHaveFocus();
    const stops: string[] = [];
    for (let i = 0; i < 4; i++) {
      await user.tab();
      stops.push(focusedName());
    }
    expect(stops).toEqual(["Decline", "Accept audio call", "Delete chat", "Decline"]);
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Delete chat" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Accept audio call" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Behind" })).not.toHaveFocus();
  });

  it("a video call: Accept video comes before Delete chat", async () => {
    const { user } = renderApp(ring(true));
    const names: string[] = [];
    for (let i = 0; i < 5; i++) {
      await user.tab();
      names.push(focusedName());
    }
    expect(names).toEqual(["Decline", "Accept audio call", "Accept video call", "Delete chat", "Decline"]);
  });

  it("Shift+Tab from the card itself goes to Delete chat, its last stop", async () => {
    const { user } = renderApp(ring(false));
    expect(screen.getByRole("alertdialog")).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Delete chat" })).toHaveFocus();
  });
});
