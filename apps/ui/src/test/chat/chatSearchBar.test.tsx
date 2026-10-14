import "fake-indexeddb/auto";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { saveSession } from "../../lib/storage";
import type { ChatMessage } from "../../lib/types";
import { SEARCH_DEBOUNCE_MS } from "../../hooks/useChatSearch";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.search

const draws = vi.hoisted(() => ({ text: 0 }));
vi.mock("../../components/rich/RichText", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../components/rich/RichText")>();
  return { ...real, RichText: (props: Parameters<typeof real.RichText>[0]) => { draws.text++; return real.RichText(props); } };
});
vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const PEER = "peer".padEnd(52, "p");
const COUNT = 300;
const AT = 1_700_000_000_000;

/**
 * `COUNT` texts ("Message 0" to "Message 299"), a "Café" and a file named "Relatório Final.pdf" among the last ones:
 * both are in the page as the chat opens, so finding them draws no other rows.
 */
function history(): ChatMessage[] {
  const list: ChatMessage[] = Array.from({ length: COUNT }, (_, i) => ({ id: `m${i}`, sender: i % 3 ? "peer" : "me", timestamp: AT + i * 60_000, text: `Message ${i}`, delivery: "delivered" }));
  list.splice(280, 0, { id: "cafe", sender: "peer", timestamp: AT + 280 * 60_000 - 1, text: "Um Café amanhã?" });
  list.splice(260, 0, { id: "doc", sender: "peer", timestamp: AT + 260 * 60_000 - 1, text: "📎 Relatório Final.pdf", file: { id: "f1", name: "Relatório Final.pdf", size: 1024, mime: "application/pdf" } });
  return list;
}

/** The last three texts: all the page needs for a test of the bar's own keys and focus, a thirtieth of the rows to draw. */
const short = () => history().slice(-3);

// Each of these draws the whole Chat page, a hundred rows of it where the history is the long one: seconds on a busy
// machine, with nothing in them that waits for a time.
vi.setConfig({ testTimeout: 30_000 });

function openChat(visible = true, messages = history()) {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages, createdAt: AT });
  const utils = renderApp(<Chat sessionId="chat-1" visible={visible} onCallChange={() => {}} callLayer={null} />);
  utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
  utils.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
  return utils;
}

const settle = (ms = 50) => act(() => vi.advanceTimersByTimeAsync(ms));
const row = (id: string) => document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!;
const field = () => screen.getByTestId<HTMLInputElement>("chat-search-input");
const count = () => screen.getByTestId("chat-search-count").textContent;
const ctrlF = () => fireEvent.keyDown(window, { key: "f", ctrlKey: true });
const marked = () => [...document.querySelectorAll("[data-search-match]")].map(mark => mark.textContent);
const type = async (text: string) => { fireEvent.change(field(), { target: { value: text } }); await settle(SEARCH_DEBOUNCE_MS + 10); };

let scrolledTo: string[];
const last = () => scrolledTo[scrolledTo.length - 1];
// New words jump to their newest match in a task of its own, queued once the render with those words commits; on a
// busy runner that commit can land after `type`'s settle is over.
const jumpedTo = (id: string) => vi.waitFor(() => expect(last()).toBe(id));
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  draws.text = 0;
  scrolledTo = [];
  Element.prototype.scrollIntoView = function (this: HTMLElement) { if (this.dataset.messageId) scrolledTo.push(this.dataset.messageId); };
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("search inside a chat", () => {
  it("opens with Ctrl/Cmd+F, and from the chat's ⋮", async () => {
    const { user } = openChat(true, short());
    await screen.findByText(`Message ${COUNT - 1}`);
    expect(screen.queryByTestId("chat-search")).toBeNull();
    const event = new KeyboardEvent("keydown", { key: "f", metaKey: true, cancelable: true });
    act(() => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(field()).toBeInTheDocument();
    await settle();
    expect(document.activeElement).toBe(field());

    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.queryByTestId("chat-search")).toBeNull();
    await user.click(screen.getByTestId("chat-options"));
    await user.click(await screen.findByTestId("chat-search-open"));
    expect(field()).toBeInTheDocument();
  });

  it("gives the focus back as it closes: to ⋮ when opened from its menu, to the composer after Ctrl+F there", async () => {
    const { user } = openChat(true, short());
    await screen.findByText(`Message ${COUNT - 1}`);
    const options = screen.getByTestId("chat-options");
    for (const how of ["escape", "close"] as const) {
      options.focus();
      await user.keyboard("{Enter}");
      screen.getByTestId("chat-search-open").focus();
      await user.keyboard("{Enter}");
      await settle();
      expect(document.activeElement).toBe(field());
      if (how === "escape") fireEvent.keyDown(field(), { key: "Escape" });
      else await user.click(screen.getByTestId("chat-search-close"));
      expect(screen.queryByTestId("chat-search")).toBeNull();
      expect(document.activeElement, how).toBe(options);
    }

    const composer = screen.getByPlaceholderText("Message…");
    composer.focus();
    ctrlF();
    await settle();
    expect(document.activeElement).toBe(field());
    // Ctrl+F again in the open bar: the place to go back to stays the composer.
    ctrlF();
    await settle();
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(document.activeElement).toBe(composer);
  });

  it("keeps the keys typed before the next frame, and chooses the words only of a bar already open", async () => {
    const { user } = openChat(true, short());
    await screen.findByText(`Message ${COUNT - 1}`);
    // The frame after the bar opens comes late on a busy phone (a long chat folded for the search): keys typed by then
    // were chosen as the field's words, and the next key replaced them ("line" read "e").
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((frame) => { frames.push(frame); return frames.length; });
    const nextFrame = () => act(() => { for (const frame of frames.splice(0)) frame(performance.now()); });
    await user.click(screen.getByTestId("chat-options"));
    await user.click(await screen.findByTestId("chat-search-open"));
    expect(document.activeElement).toBe(field());
    await user.keyboard("li");
    nextFrame();
    await user.keyboard("ne");
    expect(field().value).toBe("line");

    // Ctrl+F in the open bar: back to its field with its words chosen, so typing replaces them, at once.
    screen.getByPlaceholderText("Message…").focus();
    ctrlF();
    expect(document.activeElement).toBe(field());
    expect([field().selectionStart, field().selectionEnd]).toEqual([0, 4]);
    nextFrame();
    await user.keyboard("cafe");
    expect(field().value).toBe("cafe");
  });

  it("leaves Ctrl+F to the browser while the chat is not on screen", async () => {
    openChat(false, short());
    await settle();
    const event = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true });
    act(() => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
  });

  it("counts the matches, marks them and goes to the newest; Enter goes older, Shift+Enter newer, round", async () => {
    openChat();
    await screen.findByText(`Message ${COUNT - 1}`);
    ctrlF();
    await type("message 29");
    // "Message 29" and "Message 290" to "Message 299".
    expect(count()).toBe("1 of 11");
    await jumpedTo("m299");
    expect(row("m299")).toHaveAttribute("data-reply-flash");
    // "Message 29" is far up the history, not in the page (useRowWindow): the ten in it are marked, and it is once a jump
    // brings it in.
    await vi.waitFor(() => expect(marked()).toHaveLength(10));
    expect(marked().every(text => text === "Message 29")).toBe(true);

    fireEvent.keyDown(field(), { key: "Enter" });
    expect(count()).toBe("2 of 11");
    expect(last()).toBe("m298");
    fireEvent.click(screen.getByTestId("chat-search-older"));
    expect(last()).toBe("m297");
    fireEvent.click(screen.getByTestId("chat-search-newer"));
    expect(last()).toBe("m298");
    fireEvent.keyDown(field(), { key: "Enter", shiftKey: true });
    expect(last()).toBe("m299");
    // Newer than the newest: round to the oldest. The one step here that draws other rows (the window around
    // "Message 29"): the steps before it stay in the page.
    fireEvent.keyDown(field(), { key: "Enter", shiftKey: true });
    expect(count()).toBe("11 of 11");
    expect(last()).toBe("m29");
    expect(row("m29")).toHaveAttribute("data-reply-flash");

    fireEvent.click(screen.getByTestId("chat-search-close"));
    await settle();
    expect(marked()).toEqual([]);
  });

  it("finds whatever the case and accents, a file by its name, and says when nothing is found", async () => {
    openChat();
    await screen.findByText(`Message ${COUNT - 1}`);
    ctrlF();
    await type("CAFE");
    expect(count()).toBe("1 of 1");
    await jumpedTo("cafe");
    expect(marked()).toEqual(["Café"]);

    await type("relatorio");
    expect(count()).toBe("1 of 1");
    await jumpedTo("doc");
    expect(marked()).toEqual(["Relatório"]);

    await type("nowhere to be found");
    expect(count()).toBe("No results");
    expect(screen.getByTestId("chat-search-older")).toBeDisabled();
  });

  it("searches once typing rests, and draws again only the messages that match", async () => {
    openChat();
    await screen.findByText(`Message ${COUNT - 1}`);
    await settle();
    ctrlF();
    await settle();
    draws.text = 0;
    for (const text of ["m", "me", "mes", "mess", "messa", "messag", "message 29"]) {
      fireEvent.change(field(), { target: { value: text } });
      await settle(20);
    }
    expect(draws.text).toBe(0);
    expect(scrolledTo).toEqual([]);
    await settle(SEARCH_DEBOUNCE_MS);
    expect(count()).toBe("1 of 11");
    // The matches in the page: "Message 29" is far up the history, out of it.
    expect(draws.text).toBe(10);
  });
});
