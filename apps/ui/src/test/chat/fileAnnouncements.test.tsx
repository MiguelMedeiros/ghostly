import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANNOUNCE_CLEAR_MS, ANNOUNCE_WINDOW_MS, MessageAnnouncer, type Announceable } from "../../components/chat/MessageAnnouncer";
import type { FileTransferState } from "../../lib/platform";
import type { ChatFile } from "../../lib/types";
import type { Language } from "../../lib/settings";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.accessibility, files.large.offer, files.large.resume

// agents#2509: a 1:1 file was heard once, as "📎 name" when it came; that it waited for an answer, and every later
// step (declined, cancelled, paused by the contact, arrived), were never read out.

const MB = 1024 ** 2;
const HISTORY: Announceable[] = [{ id: "h1", sender: "peer", text: "an old one" }];
const nameOf = () => "Alice";
const incoming: ChatFile = { id: "c-in-1", name: "report.pdf", size: 40 * MB, mime: "application/pdf" };
const outgoing: ChatFile = { id: "c-out-1", name: "holiday.mov", size: 300 * MB, mime: "video/quicktime" };
const fileMessage = (file: ChatFile, sender: "peer" | "me"): Announceable => ({ id: `m-${file.id}`, sender, text: `📎 ${file.name}`, file });
const moving = (file: ChatFile, direction: "in" | "out", share: number, patch: Partial<FileTransferState> = {}): FileTransferState =>
  ({ state: "transferring", direction, transferred: Math.round(share * file.size), size: file.size, ...patch });

/** Every line the live region took, in order: what a screen reader was given to read. */
let heard: string[] = [];
let observer: MutationObserver | null = null;
const region = () => screen.getByTestId("chat-announcement");

function listen() {
  heard = [];
  observer = new MutationObserver(() => { const text = region().textContent ?? ""; if (text) heard.push(text); });
  observer.observe(region(), { childList: true, characterData: true, subtree: true });
}
const flush = () => act(async () => { await Promise.resolve(); });
/** Time passing a little at a time, each step drawn: a line shown and cleared within one step would never be seen. */
const wait = async (ms: number) => {
  for (let left = ms; left > 0; left -= 100) { act(() => { vi.advanceTimersByTime(Math.min(100, left)); }); await flush(); }
};
const transfers = async (now: Record<string, FileTransferState>) => { act(() => fakeEngine.update({ transfers: now })); await flush(); };

function setup(messages: readonly Announceable[], language?: Language, start: Record<string, FileTransferState> = {}) {
  fakeEngine.update({ links: [linkView({ id: "c" })], transfers: start });
  const view = renderApp(<MessageAnnouncer chat="c" messages={messages} nameOf={nameOf} />, language ? { language } : undefined);
  listen();
  return async (next: readonly Announceable[], active = true) => {
    view.rerender(<MessageAnnouncer chat="c" messages={next} nameOf={nameOf} active={active} />);
    await flush();
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { observer?.disconnect(); observer = null; vi.useRealTimers(); });

describe("a 1:1 file, read out to a screen reader", () => {
  it("an offer says it waits for an answer; the contact's pause and resume and its arrival are each read once, its progress never", async () => {
    const update = setup(HISTORY);
    const offer = fileMessage(incoming, "peer");
    await transfers({ [incoming.id]: moving(incoming, "in", 0, { stage: "asking" }) });
    await update([...HISTORY, offer]);
    await wait(ANNOUNCE_WINDOW_MS);
    expect(heard).toEqual(["Alice wants to send report.pdf (40.0 MB) · waiting for your answer"]);
    await wait(ANNOUNCE_CLEAR_MS);
    expect(region()).toHaveTextContent("");

    // Accept is this person's own: the button said it.
    await transfers({ [incoming.id]: moving(incoming, "in", 0) });
    for (let share = 0.05; share < 0.5; share += 0.05) {
      await transfers({ [incoming.id]: moving(incoming, "in", share, { rate: 5 * MB }) });
      await wait(250);
    }
    expect(heard).toHaveLength(1);

    await transfers({ [incoming.id]: moving(incoming, "in", 0.5, { stage: "paused", pausedBy: "peer" }) });
    expect(region()).toHaveTextContent(/^Alice paused report\.pdf$/);
    await wait(ANNOUNCE_CLEAR_MS);
    await transfers({ [incoming.id]: moving(incoming, "in", 0.5, { stage: "paused", pausedBy: "peer" }) });
    await transfers({ [incoming.id]: moving(incoming, "in", 0.55) });
    expect(region()).toHaveTextContent(/^Alice resumed report\.pdf$/);
    for (let share = 0.6; share < 1; share += 0.1) await transfers({ [incoming.id]: moving(incoming, "in", share, { rate: 6 * MB }) });
    await transfers({ [incoming.id]: moving(incoming, "in", 1, { stage: "verifying" }) });
    await transfers({ [incoming.id]: { state: "done", direction: "in", transferred: incoming.size, size: incoming.size } });
    await wait(ANNOUNCE_CLEAR_MS * 2);
    expect(heard).toEqual([
      "Alice wants to send report.pdf (40.0 MB) · waiting for your answer",
      "Alice paused report.pdf",
      "Alice resumed report.pdf",
      "report.pdf arrived, ready to save",
    ]);
    expect(region()).toHaveTextContent("");
  });

  it("sent from here: the contact's answer and the file's arrival are read; this person's own pause and resume are not", async () => {
    const mine = fileMessage(outgoing, "me");
    const update = setup(HISTORY);
    await transfers({ [outgoing.id]: moving(outgoing, "out", 0, { stage: "asking" }) });
    await update([...HISTORY, mine]);
    await wait(ANNOUNCE_WINDOW_MS * 2);
    expect(heard).toEqual([]);

    await transfers({ [outgoing.id]: moving(outgoing, "out", 0.01) });
    await transfers({ [outgoing.id]: moving(outgoing, "out", 0.2, { rate: 9 * MB }) });
    await wait(ANNOUNCE_CLEAR_MS);
    await transfers({ [outgoing.id]: moving(outgoing, "out", 0.3, { stage: "paused", pausedBy: "me" }) });
    await transfers({ [outgoing.id]: moving(outgoing, "out", 0.31) });
    await transfers({ [outgoing.id]: moving(outgoing, "out", 1, { stage: "verifying" }) });
    await transfers({ [outgoing.id]: { state: "done", direction: "out", transferred: outgoing.size, size: outgoing.size } });
    await wait(ANNOUNCE_CLEAR_MS * 2);
    expect(heard).toEqual(["Alice accepted holiday.mov", "Alice received holiday.mov"]);
  });

  it("declined or cancelled by the contact, or failed, is read once; this person's own Decline and Cancel are not", async () => {
    const sent = [0, 1, 2].map(i => ({ ...outgoing, id: `c-out-${i}`, name: `sent ${i}.bin` }));
    const got = [0, 1].map(i => ({ ...incoming, id: `c-in-${i}`, name: `got ${i}.bin` }));
    const all = [...HISTORY, ...sent.map(f => fileMessage(f, "me")), ...got.map(f => fileMessage(f, "peer"))];
    // Already in the chat as it opens: its history is not read, what it does next is.
    const start = Object.fromEntries([...sent.map(f => [f.id, moving(f, "out", 0, { stage: "asking" })]), ...got.map(f => [f.id, moving(f, "in", 0.4)])]);
    setup(all, undefined, start);
    const failed = (f: ChatFile, direction: "in" | "out", error: string): FileTransferState => ({ state: "failed", direction, transferred: 0, size: f.size, error });
    const steps: [ChatFile, FileTransferState][] = [
      [sent[0], failed(sent[0], "out", "Declined by your contact")],
      [sent[1], failed(sent[1], "out", "Cancelled by your contact")],
      [sent[2], failed(sent[2], "out", "Connection lost")],
      [got[0], failed(got[0], "in", "You cancelled it")],
      [got[1], failed(got[1], "in", "Cancelled by the sender")],
    ];
    let now = { ...start };
    for (const [f, state] of steps) {
      now = { ...now, [f.id]: state };
      await transfers(now);
      await transfers(now);
    }
    await wait(ANNOUNCE_CLEAR_MS * 6);
    // Several at once are read one after the other, each once.
    expect(heard).toEqual(["Alice declined sent 0.bin", "Alice cancelled sent 1.bin", "sent 2.bin: Not sent", "Alice cancelled got 1.bin"]);
  });

  it("an offer this person declines: its arrival only", async () => {
    const update = setup(HISTORY);
    await transfers({ [incoming.id]: moving(incoming, "in", 0, { stage: "asking" }) });
    await update([...HISTORY, fileMessage(incoming, "peer")]);
    await wait(ANNOUNCE_WINDOW_MS + ANNOUNCE_CLEAR_MS);
    await transfers({ [incoming.id]: { state: "failed", direction: "in", transferred: 0, size: incoming.size, error: "You declined it" } });
    await wait(ANNOUNCE_CLEAR_MS);
    expect(heard).toEqual(["Alice wants to send report.pdf (40.0 MB) · waiting for your answer"]);
  });

  it("a small file that arrives at once is its arrival line only", async () => {
    const update = setup(HISTORY);
    const small: ChatFile = { id: "c-in-9", name: "notes.txt", size: 3_000, mime: "text/plain" };
    await transfers({ [small.id]: moving(small, "in", 0) });
    await update([...HISTORY, fileMessage(small, "peer")]);
    await transfers({ [small.id]: { state: "done", direction: "in", transferred: small.size, size: small.size } });
    await wait(ANNOUNCE_WINDOW_MS + ANNOUNCE_CLEAR_MS);
    expect(heard).toEqual(["Alice: 📎 notes.txt"]);
  });

  it("in Arabic, in the page's language", async () => {
    const update = setup(HISTORY, "ar");
    await transfers({ [incoming.id]: moving(incoming, "in", 0, { stage: "asking" }) });
    await update([...HISTORY, fileMessage(incoming, "peer")]);
    await wait(ANNOUNCE_WINDOW_MS);
    expect(heard).toEqual([expect.stringMatching(/^يريد Alice إرسال report\.pdf \(.+\) · في انتظار ردك$/)]);
    await wait(ANNOUNCE_CLEAR_MS);
    await transfers({ [incoming.id]: { state: "failed", direction: "in", transferred: 0, size: incoming.size, error: "Cancelled by the sender" } });
    expect(heard[1]).toBe("ألغى Alice report.pdf");
  });

  it("a chat kept open behind another reads nothing out; a group's file is not followed here", async () => {
    const group: ChatFile = { id: "group-g1-in-1", name: "minutes.pdf", size: 40 * MB, mime: "application/pdf" };
    const start = { [incoming.id]: moving(incoming, "in", 0.3), [group.id]: moving(group, "in", 0.3) };
    const messages = [...HISTORY, fileMessage(incoming, "peer"), fileMessage(group, "peer")];
    const update = setup(messages, undefined, start);
    await transfers({ ...start, [group.id]: { state: "done", direction: "in", transferred: group.size, size: group.size } });
    await update(messages, false);
    await transfers({ [incoming.id]: moving(incoming, "in", 0.3, { stage: "paused", pausedBy: "peer" }), [group.id]: { state: "done", direction: "in", transferred: group.size, size: group.size } });
    await wait(ANNOUNCE_CLEAR_MS);
    expect(heard).toEqual([]);
  });
});
