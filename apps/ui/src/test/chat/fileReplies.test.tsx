// happy-dom has no IndexedDB: the file store keeps what is sent in this one.
import "fake-indexeddb/auto";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { saveSession } from "../../lib/storage";
import type { ChatMessage } from "../../lib/types";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { installFakeAudio, installFakeMedia, removeFakeMedia } from "../voice/fakeMedia";

/** A 1x1 PNG and JPEG the sender's metadata strip reads as pictures (it refuses bytes that are not one). */
const TINY_PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0]);
const TINY_JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x12, 0x34, 0xff, 0xd9]);

// covers: chat.replies, files.voice.record

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const PEER = "peer".padEnd(52, "p"), WIRE = "A".repeat(22), MINE = "B".repeat(22);
const lunch: ChatMessage = { id: `peer_${WIRE}`, text: "lunch at noon?", sender: "peer", timestamp: 1_700_000_000_000 };
const plan: ChatMessage = { id: `me_${MINE}`, ref: MINE, text: "the plan", sender: "me", timestamp: 1_700_000_001_000 };

/** A paired chat, live, whose contact takes files, with a message of theirs and one of mine to answer. */
function openChat() {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", messages: [lunch, plan], createdAt: 1_700_000_000_000 });
  const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
  utils.engine.on("sendFile", () => undefined).on("sendMessage", () => ({ error: null }))
    .update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", capabilities: { files: true } } as never)] });
  return utils;
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!;
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const touch = { pointerId: 1, pointerType: "touch", button: 0, clientX: 300, clientY: 500 };
const mouse = { ...touch, pointerType: "mouse" };

/** Reply on a message from its reply button: the composer's quote bar names it. */
async function replyTo(id: string, text: string) {
  fireEvent.click(within(row(id)).getByTestId("message-reply-action"));
  await wait(0);
  expect(within(screen.getByTestId("composer-reply")).getByTestId("reply-quote-snippet")).toHaveTextContent(text);
}

/** Holds the mic for `ms` and lets go: a voice message is sent. */
async function record(ms = 2_000) {
  fireEvent.pointerDown(screen.getByTestId("voice-record"), touch);
  await wait(0);
  await wait(ms);
  fireEvent.pointerUp(screen.getByTestId("voice-record"), touch);
  await wait(0);
  await wait(0);
}

/** The rows of the files sent here, oldest first. */
const sentRows = () => [...document.querySelectorAll<HTMLElement>("[data-message-id^='me_']")].filter((el) => el.dataset.messageId !== plan.id);
const lastSent = () => sentRows().slice(-1)[0]!;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  installFakeMedia();
  installFakeAudio();
});

afterEach(() => {
  vi.useRealTimers();
  removeFakeMedia();
  vi.restoreAllMocks();
});

describe("a voice message or file sent while replying (Miguel: voice notes arrived with no quote)", () => {
  it("a voice message recorded after Reply goes as a reply, its bubble quotes it, and the bar goes", async () => {
    const { engine } = openChat();
    await screen.findByText("lunch at noon?");
    await replyTo(lunch.id, "lunch at noon?");
    await record();

    await vi.waitFor(() => expect(engine.callsTo("sendFile")).toHaveLength(1));
    const [sent] = engine.callsTo("sendFile");
    expect(sent!.replyTo).toBe(lunch.id);
    expect(sent!.file.voice).toBeTruthy();
    await vi.waitFor(() => expect(screen.queryByTestId("composer-reply")).not.toBeInTheDocument());
    // Mine quotes it at once.
    const quote = await vi.waitFor(() => within(lastSent()).getByTestId("message-quote"));
    expect(quote).toHaveAttribute("data-state", "found");
    expect(within(quote).getByTestId("reply-quote-snippet")).toHaveTextContent("lunch at noon?");

    // The next one answers nothing.
    await record();
    await vi.waitFor(() => expect(engine.callsTo("sendFile")).toHaveLength(2));
    expect(engine.callsTo("sendFile")[1]!.replyTo).toBeUndefined();
    await vi.waitFor(() => expect(sentRows()).toHaveLength(2));
    expect(within(lastSent()).queryByTestId("message-quote")).not.toBeInTheDocument();
  });

  it("a reply chosen while recording goes with the recording", async () => {
    const { engine } = openChat();
    await screen.findByText("lunch at noon?");
    // A click records hands-free.
    fireEvent.pointerDown(screen.getByTestId("voice-record"), mouse);
    await wait(0);
    fireEvent.pointerUp(screen.getByTestId("voice-record"), mouse);
    fireEvent.click(screen.getByTestId("voice-send"));
    await wait(0);
    expect(screen.getByTestId("voice-bar")).toHaveAttribute("data-mode", "locked");
    await replyTo(plan.id, "the plan");
    await wait(1_500);
    fireEvent.click(screen.getByTestId("voice-send"));
    // My own message, named as the chat knows it.
    await vi.waitFor(() => expect(engine.callsTo("sendFile").map((c) => c.replyTo)).toEqual([plan.id]));
    await vi.waitFor(() => expect(screen.queryByTestId("composer-reply")).not.toBeInTheDocument());
  });

  it("files from + → Document: the first carries the reply, the rest do not", async () => {
    const { engine } = openChat();
    await screen.findByText("lunch at noon?");
    await replyTo(lunch.id, "lunch at noon?");
    const files = [new File(["one"], "one.txt", { type: "text/plain" }), new File(["two"], "two.txt", { type: "text/plain" })];
    fireEvent.change(screen.getByTestId("file-input"), { target: { files } });
    await vi.waitFor(() => expect(engine.callsTo("sendFile").map((c) => [c.file.name, c.replyTo])).toEqual([["one.txt", lunch.id], ["two.txt", undefined]]));
    expect(screen.queryByTestId("composer-reply")).not.toBeInTheDocument();
  });

  it("a pasted picture with a caption: the picture carries the reply, the caption does not quote it again", async () => {
    const { engine } = openChat();
    await screen.findByText("lunch at noon?");
    await replyTo(lunch.id, "lunch at noon?");
    const picture = new File([TINY_PNG], "shot.png", { type: "image/png" });
    fireEvent.paste(screen.getByPlaceholderText("Message…"), { clipboardData: { files: [picture], items: [{ kind: "file", type: "image/png", getAsFile: () => picture }], types: ["Files"], getData: () => "" } });
    const sheet = await screen.findByTestId("attachment-sheet");
    fireEvent.change(within(sheet).getByTestId("attachment-caption"), { target: { value: "here it is" } });
    fireEvent.click(within(sheet).getByTestId("attachment-send"));
    await vi.waitFor(() => expect(engine.callsTo("sendMessage").map((c) => [c.text, c.replyTo])).toEqual([["here it is", undefined]]));
    expect(engine.callsTo("sendFile").map((c) => c.replyTo)).toEqual([lunch.id]);
  });

  it("the camera's photo carries it too", async () => {
    const { engine } = openChat();
    await screen.findByText("lunch at noon?");
    await replyTo(lunch.id, "lunch at noon?");
    const photo = new File([TINY_JPEG], "photo.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByTestId("camera-input"), { target: { files: [photo] } });
    await vi.waitFor(() => expect(engine.callsTo("sendFile").map((c) => [c.file.name, c.replyTo])).toEqual([["photo.jpg", lunch.id]]));
  });

  it("a text reply still goes as one", async () => {
    const { engine } = openChat();
    await screen.findByText("lunch at noon?");
    await replyTo(lunch.id, "lunch at noon?");
    fireEvent.change(screen.getByPlaceholderText("Message…"), { target: { value: "yes" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await wait(0);
    await wait(0);
    expect(engine.callsTo("sendMessage").map((c) => [c.text, c.replyTo])).toEqual([["yes", lunch.id]]);
    expect(screen.queryByTestId("composer-reply")).not.toBeInTheDocument();
  });
});
