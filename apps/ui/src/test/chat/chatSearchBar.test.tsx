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

/** `COUNT` texts ("Message 0" to "Message 299"), a "Café" and a file named "Relatório Final.pdf" among them. */
function history(): ChatMessage[] {
  const list: ChatMessage[] = Array.from({ length: COUNT }, (_, i) => ({ id: `m${i}`, sender: i % 3 ? "peer" : "me", timestamp: AT + i * 60_000, text: `Message ${i}`, delivery: "delivered" }));
  list.splice(100, 0, { id: "cafe", sender: "peer", timestamp: AT + 100 * 60_000 - 1, text: "Um Café amanhã?" });
  list.splice(50, 0, { id: "doc", sender: "peer", timestamp: AT + 50 * 60_000 - 1, text: "📎 Relatório Final.pdf", file: { id: "f1", name: "Relatório Final.pdf", size: 1024, mime: "application/pdf" } });
  return list;
}

function openChat(visible = true) {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: history(), createdAt: AT });
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
    const { user } = openChat();
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

  it("leaves Ctrl+F to the browser while the chat is not on screen", async () => {
    openChat(false);
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
    // "Message 29" is among the older rows, drawn a step at a time after the newest (useTailFirst).
    await vi.waitFor(() => expect(marked()).toHaveLength(11));
    expect(marked().every(text => text === "Message 29")).toBe(true);

    fireEvent.keyDown(field(), { key: "Enter" });
    expect(count()).toBe("2 of 11");
    expect(last()).toBe("m298");
    fireEvent.keyDown(field(), { key: "Enter", shiftKey: true });
    fireEvent.keyDown(field(), { key: "Enter", shiftKey: true });
    // Newer than the newest: round to the oldest.
    expect(count()).toBe("11 of 11");
    expect(last()).toBe("m29");
    fireEvent.click(screen.getByTestId("chat-search-newer"));
    expect(last()).toBe("m290");
    fireEvent.click(screen.getByTestId("chat-search-older"));
    expect(last()).toBe("m29");

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
    expect(draws.text).toBe(11);
  });
});
