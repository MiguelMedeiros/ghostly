import "fake-indexeddb/auto";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ translateTexts: vi.fn() }));
vi.mock("../../desktop/translate", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../desktop/translate")>(),
  translateTexts: runtime.translateTexts,
}));
vi.mock("../../lib/externalLink", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/externalLink")>(),
  isDesktopApp: () => true,
}));
// The detector the app will load, as a few words of Portuguese.
vi.mock("../../lib/translateDetector", () => ({
  loadDetector: async () => (text: string) => [{ code: /amanhã|vamos/i.test(text) ? "pt" : "en", probability: 0.95 }],
}));
vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

import { SEARCH_DEBOUNCE_MS } from "../../hooks/useChatSearch";
import { saveSession } from "../../lib/storage";
import { forgetTranslations } from "../../lib/translateReceived";
import type { ChatMessage } from "../../lib/types";
import { Chat } from "../../pages/Chat";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.search

/** An IntersectionObserver the test moves: `seen` puts the bubbles on screen, so they ask for their translations. */
const observed = new Map<Element, IntersectionObserverCallback>();
class FakeObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(element: Element) { observed.set(element, this.callback); }
  unobserve(element: Element) { observed.delete(element); }
  disconnect() { for (const [element, callback] of observed) if (callback === this.callback) observed.delete(element); }
  takeRecords() { return []; }
}
const seen = () => act(() => {
  for (const target of document.querySelectorAll("[data-message-bubble]")) observed.get(target)?.([{ target, isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
});

const PEER = "peer".padEnd(52, "p");
const AT = 1_700_000_000_000;
const ENGLISH: Record<string, string> = { "Vamos ao cinema amanhã": "Let's go to the movies tomorrow" };
const messages = (): ChatMessage[] => [
  { id: "pt", sender: "peer", timestamp: AT, text: "Vamos ao cinema amanhã" },
  { id: "en", sender: "peer", timestamp: AT + 60_000, text: "See you at the station tomorrow" },
  { id: "mine", sender: "me", timestamp: AT + 120_000, text: "Vamos sim, amanhã", delivery: "delivered" },
];

function openChat() {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: messages(), createdAt: AT });
  const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
  utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
  utils.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
  return utils;
}

const text = (id: string) => within(document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!).getByTestId("message-text");
const field = () => screen.getByTestId<HTMLInputElement>("chat-search-input");
const count = () => screen.getByTestId("chat-search-count").textContent;
/** The words marked in each message, by id: what the person sees found. */
const marks = () => {
  const out: Record<string, (string | null)[]> = {};
  for (const row of document.querySelectorAll<HTMLElement>("[data-message-id]")) {
    const found = [...row.querySelectorAll("[data-search-match]")].map((mark) => mark.textContent);
    if (found.length) out[row.dataset.messageId!] = found;
  }
  return out;
};
const search = async (words: string) => {
  fireEvent.change(field(), { target: { value: words } });
  await act(() => new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 30)));
};

/** The chat open with its Portuguese message shown in English, and the search open. */
async function translatedChat() {
  const utils = openChat();
  await screen.findByText("See you at the station tomorrow");
  await seen();
  await waitFor(() => expect(text("pt")).toHaveTextContent("Let's go to the movies tomorrow"));
  fireEvent.keyDown(window, { key: "f", ctrlKey: true });
  return utils;
}

beforeEach(() => {
  forgetTranslations();
  observed.clear();
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  vi.stubEnv("VITE_TRANSLATE", "1");
  Element.prototype.scrollIntoView = () => {};
  runtime.translateTexts.mockReset();
  runtime.translateTexts.mockImplementation(async (pair: string, texts: string[]) => texts.map((t) => ENGLISH[t] ?? `${pair}: ${t}`));
  localStorage.setItem("ghostly_app_settings", JSON.stringify({ language: "en", translateMessages: true }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
});

vi.setConfig({ testTimeout: 30_000 });

describe("search in a chat that shows received messages translated", () => {
  it("finds a translated message by the words it shows, and marks them there; not by the original's hidden words", async () => {
    await translatedChat();
    await search("tomorrow");
    expect(marks()).toEqual({ pt: ["tomorrow"], en: ["tomorrow"] });
    expect(count()).toBe("1 of 2");

    await search("movies");
    expect(count()).toBe("1 of 1");
    expect(marks()).toEqual({ pt: ["movies"] });

    // "amanhã" is in the original, which is not on screen: only my own message, which shows it, is found.
    await search("amanhã");
    expect(count()).toBe("1 of 1");
    expect(marks()).toEqual({ mine: ["amanhã"] });
    expect(runtime.translateTexts).toHaveBeenCalledTimes(1);
  });

  it("with Show original pressed, finds and marks the original's words, and no longer the translation's", async () => {
    const { user } = await translatedChat();
    await user.click(screen.getByRole("button", { name: "Show original" }));
    expect(text("pt")).toHaveTextContent("Vamos ao cinema amanhã");

    await search("cinema");
    expect(count()).toBe("1 of 1");
    expect(marks()).toEqual({ pt: ["cinema"] });
    await search("movies");
    expect(count()).toBe("No results");
    expect(marks()).toEqual({});

    // Show translation while the search is open: the same words find it again where it shows them.
    await user.click(screen.getByRole("button", { name: "Show translation" }));
    await search("cinemas");
    await search("movies");
    expect(count()).toBe("1 of 1");
    expect(marks()).toEqual({ pt: ["movies"] });
  });

  it("where the chat does not translate, finds received messages by their own words as before", async () => {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ language: "en", translateMessages: false }));
    openChat();
    await screen.findByText("See you at the station tomorrow");
    await seen();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    await search("cinema amanha");
    expect(count()).toBe("1 of 1");
    expect(marks()).toEqual({ pt: ["cinema amanhã"] });
    await search("movies");
    expect(count()).toBe("No results");
    expect(runtime.translateTexts).not.toHaveBeenCalled();
  });
});
