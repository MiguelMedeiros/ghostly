import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import type { ChatMessage } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { installFakeAudio } from "./fakeMedia";

const MB = 1024 * 1024;
const peaks = Array.from({ length: 64 }, (_, i) => (i * 37) % 256);
let n = 0;

function voice(sender: "me" | "peer" = "peer"): ChatMessage {
  const id = `link-1-${sender === "me" ? "out" : "in"}-answer${++n}`;
  return {
    id: `${sender}_${n}`, text: "🎤 Voice message (14:50)", sender, nick: "Ana", timestamp: 1_700_000_000_000 + n,
    file: { id, name: "Voice message.wav", size: 86 * MB, mime: "audio/wav", voice: { duration: 890_000, peaks } },
  };
}

const show = (message: ChatMessage) => renderApp(<MessageBubble message={message} peerPubKey="peer" />);
const lastAction = () => {
  const calls = fakeEngine.callsTo("fileAction");
  return calls[calls.length - 1];
};

beforeEach(() => {
  installFakeAudio();
  fakeEngine.on("fileAction", () => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("a 1:1 voice message that needs an answer or is on its way", () => {
  it("one the engine asks about shows Download <size>, Decline and the room, and answers through the engine", async () => {
    const message = voice();
    const id = message.file!.id;
    fakeEngine.update({ links: [linkView({ id: "link-1" })], transfers: { [id]: { state: "transferring", stage: "asking", direction: "in", transferred: 0, size: message.file!.size, room: 12 * 1024 * MB } } });
    show(message);
    const bubble = screen.getByTestId("voice-bubble");
    expect(within(bubble).getByTestId("voice-download")).toHaveTextContent("Download 86.0 MB");
    expect(within(bubble).getByTestId("voice-room")).toHaveTextContent("Ana wants to send it · 12.0 GB left");
    fireEvent.click(within(bubble).getByTestId("voice-download"));
    await vi.waitFor(() => expect(lastAction()).toEqual({ linkId: "link-1", fileId: id, action: "accept" }));
    fireEvent.click(within(bubble).getByTestId("voice-decline"));
    await vi.waitFor(() => expect(lastAction()).toEqual({ linkId: "link-1", fileId: id, action: "decline" }));
  });

  it("Decline pressed from the keyboard keeps the focus in the bubble once the offer is gone", async () => {
    const message = voice();
    const id = message.file!.id;
    fakeEngine.update({ links: [linkView({ id: "link-1" })], transfers: { [id]: { state: "transferring", stage: "asking", direction: "in", transferred: 0, size: message.file!.size } } });
    const { user } = show(message);
    screen.getByTestId("voice-decline").focus();
    await user.keyboard("{Enter}");
    act(() => fakeEngine.update({ transfers: { [id]: { state: "failed", direction: "in", transferred: 0, size: message.file!.size, error: "Declined" } } }));
    expect(screen.queryByTestId("voice-decline")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("voice-bubble"));
  });

  it("while it arrives: Pause and Cancel; paused here: Resume", async () => {
    const message = voice();
    const id = message.file!.id;
    fakeEngine.update({ links: [linkView({ id: "link-1" })], transfers: { [id]: { state: "transferring", direction: "in", transferred: 34 * MB, size: message.file!.size } } });
    show(message);
    expect(screen.queryByTestId("voice-download")).toBeNull();
    fireEvent.click(screen.getByTestId("voice-pause-transfer"));
    await vi.waitFor(() => expect(lastAction()?.action).toBe("pause"));
    fireEvent.click(screen.getByTestId("voice-cancel"));
    await vi.waitFor(() => expect(lastAction()?.action).toBe("cancel"));
    act(() => fakeEngine.update({ transfers: { [id]: { state: "transferring", stage: "paused", direction: "in", transferred: 34 * MB, size: message.file!.size } } }));
    expect(screen.queryByTestId("voice-pause-transfer")).toBeNull();
    fireEvent.click(screen.getByTestId("voice-resume-transfer"));
    await vi.waitFor(() => expect(lastAction()?.action).toBe("resume"));
  });

  it("one of mine waiting for the contact's answer can be cancelled", async () => {
    const message = voice("me");
    const id = message.file!.id;
    fakeEngine.update({ links: [linkView({ id: "link-1" })], transfers: { [id]: { state: "transferring", stage: "asking", direction: "out", transferred: 0, size: message.file!.size } } });
    show(message);
    expect(screen.queryByTestId("voice-download")).toBeNull();
    expect(screen.queryByTestId("voice-pause-transfer")).toBeNull();
    fireEvent.click(screen.getByTestId("voice-cancel"));
    await vi.waitFor(() => expect(lastAction()).toEqual({ linkId: "link-1", fileId: id, action: "cancel" }));
  });

  // They took taps on 20 px of height on a phone, under a file's 44 px Accept, Decline, Pause, Resume and Cancel.
  it("Download, Decline, Pause, Resume and Cancel are a thumb's height on a phone, as a file's are", () => {
    const offer = voice();
    const moving = voice();
    const paused = voice();
    const transfer = (stage?: "asking" | "paused") => ({ state: "transferring" as const, stage, direction: "in" as const, transferred: stage === "asking" ? 0 : 34 * MB, size: 86 * MB });
    fakeEngine.update({ links: [linkView({ id: "link-1" })], transfers: { [offer.file!.id]: transfer("asking"), [moving.file!.id]: transfer(), [paused.file!.id]: transfer("paused") } });
    for (const message of [offer, moving, paused]) show(message);
    for (const id of ["voice-download", "voice-decline", "voice-pause-transfer", "voice-resume-transfer"]) expect(screen.getByTestId(id), id).toHaveClass("max-md:min-h-11", "max-md:px-4");
    for (const cancel of screen.getAllByTestId("voice-cancel")) expect(cancel).toHaveClass("max-md:min-h-11", "max-md:px-4");
  });
});
