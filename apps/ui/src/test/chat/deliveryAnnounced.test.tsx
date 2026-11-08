import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANNOUNCE_CLEAR_MS, ANNOUNCE_WINDOW_MS, MessageAnnouncer, type Announceable } from "../../components/chat/MessageAnnouncer";
import type { Language } from "../../lib/settings";
import { renderApp } from "../render";

// covers: app.accessibility, chat.paired.send, chat.waiting

// A text of mine that turned "Not sent", or started waiting for the contact, changed only its mark: a screen reader
// was never told, so the person moved on not knowing it had to be sent again.

const nameOf = () => "Alice";
const mine = (id: string, text: string, delivery?: string): Announceable => ({ id, sender: "me", text, delivery });
const HISTORY: Announceable[] = [{ id: "h1", sender: "peer", text: "an old one" }, mine("h2", "my old one", "delivered")];
const turned = (list: readonly Announceable[], id: string, delivery: string) => list.map(m => m.id === id ? { ...m, delivery } : m);

/** Every line the live region took, in order: what a screen reader was given to read. */
let heard: string[] = [];
let observer: MutationObserver | null = null;
const region = () => screen.getByTestId("chat-announcement");
const flush = () => act(async () => { await Promise.resolve(); });
/** Time passing a little at a time, each step drawn: a line shown and cleared within one step would never be seen. */
const wait = async (ms: number) => {
  for (let left = ms; left > 0; left -= 100) { act(() => { vi.advanceTimersByTime(Math.min(100, left)); }); await flush(); }
};

function setup(messages: readonly Announceable[], language?: Language) {
  const view = renderApp(<MessageAnnouncer chat="c" messages={messages} nameOf={nameOf} />, language ? { language } : undefined);
  heard = [];
  observer = new MutationObserver(() => { const text = region().textContent ?? ""; if (text) heard.push(text); });
  observer.observe(region(), { childList: true, characterData: true, subtree: true });
  return async (next: readonly Announceable[], chat = "c") => {
    view.rerender(<MessageAnnouncer chat={chat} messages={next} nameOf={nameOf} />);
    await flush();
  };
}

const setOnline = (value: boolean) => {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => value });
  act(() => { window.dispatchEvent(new Event(value ? "online" : "offline")); });
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  observer?.disconnect();
  observer = null;
  vi.useRealTimers();
  setOnline(true);
});

describe("a text of mine that needs me, read out to a screen reader", () => {
  it("one that turns not sent is said once, politely, with what it was", async () => {
    const start = [...HISTORY, mine("m1", "see you at noon", "sent")];
    const update = setup(start);
    await update(turned(start, "m1", "failed"));
    await wait(ANNOUNCE_WINDOW_MS + ANNOUNCE_CLEAR_MS + 200);
    expect(heard).toEqual(["Not sent: see you at noon"]);
    expect(region()).toHaveAttribute("aria-live", "polite");
    expect(region()).toHaveTextContent("");
  });

  it("one that starts waiting for the contact is said once", async () => {
    const start = [...HISTORY, mine("m1", "are you there?", "queued")];
    const update = setup(start);
    await update(turned(start, "m1", "waiting"));
    await wait(ANNOUNCE_WINDOW_MS + ANNOUNCE_CLEAR_MS + 200);
    expect(heard).toEqual(["Waiting for your contact to be online: are you there?"]);
  });

  it("one I just sent that fails at once is said too", async () => {
    const update = setup(HISTORY);
    await update([...HISTORY, mine("m1", "hello", "sending")]);
    await update([...HISTORY, mine("m1", "hello", "failed")]);
    await wait(ANNOUNCE_WINDOW_MS + ANNOUNCE_CLEAR_MS + 200);
    expect(heard).toEqual(["Not sent: hello"]);
  });

  it("the chat's texts that were not sent before it opened are not said", async () => {
    const start = [...HISTORY, mine("m1", "one", "failed"), mine("m2", "two", "waiting")];
    const update = setup(start);
    await wait(ANNOUNCE_WINDOW_MS * 2);
    // Another update of the same chat (a reaction, a read mark) is no step of theirs either.
    await update(start.map(m => ({ ...m })));
    await wait(ANNOUNCE_WINDOW_MS * 2);
    expect(heard).toEqual([]);
  });

  it("older history loaded above, with texts not sent, is not said", async () => {
    const update = setup(HISTORY);
    await update([mine("o1", "older one", "failed"), mine("o2", "older two", "waiting"), ...HISTORY]);
    await wait(ANNOUNCE_WINDOW_MS * 2);
    expect(heard).toEqual([]);
  });

  it("twenty texts failing at once are one line, a count", async () => {
    const texts = Array.from({ length: 20 }, (_, i) => mine(`b${i}`, `text ${i}`, "sent"));
    const update = setup([...HISTORY, ...texts]);
    let now: Announceable[] = [...HISTORY, ...texts];
    // They fail one after another within the window, each its own update, as the engine reports them.
    for (const m of texts) { now = turned(now, m.id, "failed"); await update(now); }
    await wait(ANNOUNCE_WINDOW_MS + ANNOUNCE_CLEAR_MS * 2 + 200);
    expect(heard).toEqual(["20 messages not sent"]);
  });

  it("sent, delivered and sending again are not said", async () => {
    const start = [...HISTORY, mine("m1", "hi", "sending")];
    const update = setup(start);
    await update(turned(start, "m1", "sent"));
    await update(turned(start, "m1", "delivered"));
    await wait(ANNOUNCE_WINDOW_MS * 2);
    expect(heard).toEqual([]);
  });

  it("one sent again before the line is said is no news", async () => {
    const start = [...HISTORY, mine("m1", "hi", "sent")];
    const update = setup(start);
    await update(turned(start, "m1", "failed"));
    await update(turned(start, "m1", "sending"));
    await wait(ANNOUNCE_WINDOW_MS * 2);
    expect(heard).toEqual([]);
  });

  it("not sent and waiting together are two lines, not sent first", async () => {
    const start = [...HISTORY, mine("m1", "a", "queued"), mine("m2", "b", "queued"), mine("m3", "c", "sent")];
    const update = setup(start);
    await update(turned(turned(turned(start, "m1", "waiting"), "m2", "waiting"), "m3", "failed"));
    await wait(ANNOUNCE_WINDOW_MS + ANNOUNCE_CLEAR_MS * 3);
    expect(heard).toEqual(["Not sent: c", "2 messages waiting for your contact to be online"]);
  });

  it("offline, a text that waits is not said (it waits for this device): one not sent still is", async () => {
    setOnline(false);
    const start = [...HISTORY, mine("m1", "a", "queued"), mine("m2", "b", "sent")];
    const update = setup(start);
    await update(turned(turned(start, "m1", "waiting"), "m2", "failed"));
    await wait(ANNOUNCE_WINDOW_MS + ANNOUNCE_CLEAR_MS * 2);
    expect(heard).toEqual(["Not sent: b"]);
  });

  it("a contact's message, a file of mine and a chat's note are not delivery news", async () => {
    const start: Announceable[] = [...HISTORY,
      { id: "f1", sender: "me", text: "📎 a.pdf", delivery: "sent", file: { id: "file-1", name: "a.pdf", size: 3, mime: "application/pdf" } },
      { id: "e1", sender: "me", text: "joined", delivery: "sent", systemEvent: { kind: "x" } }];
    const update = setup(start);
    await update(turned(turned(start, "f1", "failed"), "e1", "failed"));
    await wait(ANNOUNCE_WINDOW_MS * 2);
    expect(heard).toEqual([]);
  });

  it("is said in the person's language", async () => {
    const texts = Array.from({ length: 3 }, (_, i) => mine(`b${i}`, `t${i}`, "sent"));
    const start = [...HISTORY, mine("m1", "oi", "sent"), ...texts];
    const update = setup(start, "pt");
    await update(turned(start, "m1", "failed"));
    await wait(ANNOUNCE_WINDOW_MS + ANNOUNCE_CLEAR_MS + 200);
    let now = start;
    for (const m of texts) now = turned(now, m.id, "failed");
    await update(now);
    await wait(ANNOUNCE_WINDOW_MS + ANNOUNCE_CLEAR_MS + 200);
    expect(heard).toEqual(["Não enviada: oi", "3 mensagens não enviadas"]);
  });

  it("a long chat: a text failing reads my texts still on their way and the new rows, not the whole history", async () => {
    const history = Array.from({ length: 5_000 }, (_, i) => i % 2 ? mine(`d${i}`, `old ${i}`, "delivered") : { id: `p${i}`, sender: "peer", text: `old ${i}` });
    const start = [...history, mine("m1", "late", "sent"), mine("m2", "later", "sending")];
    const update = setup(start);
    let reads = 0;
    const counted = (rows: Announceable[]) => new Proxy(rows, {
      get(target, key, receiver) { if (typeof key === "string" && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver); },
    });
    await update(counted(turned([...start, { id: "p-new", sender: "peer", text: "hey" }], "m1", "failed")));
    expect(reads).toBeLessThan(50);
    await wait(ANNOUNCE_WINDOW_MS + ANNOUNCE_CLEAR_MS * 2);
    expect(heard).toEqual(["Not sent: late", "Alice: hey"]);
  });

  it("another chat opened: the last one's pending step is not said in it", async () => {
    const start = [...HISTORY, mine("m1", "hi", "sent")];
    const update = setup(start);
    await update(turned(start, "m1", "failed"));
    await update([mine("x1", "elsewhere", "failed")], "other");
    await wait(ANNOUNCE_WINDOW_MS * 2);
    expect(heard).toEqual([]);
  });
});
