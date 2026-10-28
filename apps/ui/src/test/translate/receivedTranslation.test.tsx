import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ translateTexts: vi.fn(), desktop: true }));
vi.mock("../../desktop/translate", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../desktop/translate")>(),
  translateTexts: runtime.translateTexts,
}));
vi.mock("../../lib/externalLink", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/externalLink")>(),
  isDesktopApp: () => runtime.desktop,
}));
// The detector the app will load (`@qvac/langdetect-text`), as a few words of each language.
vi.mock("../../lib/translateDetector", () => ({
  loadDetector: async () => (text: string) => /olá|tudo|você|chego|amanhã|obrigad/i.test(text) ? [{ code: "pt", probability: 0.95 }]
    : /hola|gracias|mañana/i.test(text) ? [{ code: "es", probability: 0.95 }] : [{ code: "en", probability: 0.95 }],
}));

import { MessageBubble } from "../../components/MessageBubble";
import { TranslateError } from "../../desktop/translate";
import { CueChat } from "../../lib/cues";
import { BATCH_TEXTS, CHAT_TRANSLATE_EVENT, LONG_TEXT, forgetTranslations, translationOn } from "../../lib/translateReceived";
import type { ChatMessage } from "../../lib/types";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.i18n

/** An IntersectionObserver the test moves: `seen` puts bubbles on screen (or a screenful away), or takes them off. */
const observed = new Map<Element, IntersectionObserverCallback>();
let inits: (IntersectionObserverInit | undefined)[] = [];
class FakeObserver {
  constructor(private readonly callback: IntersectionObserverCallback, init?: IntersectionObserverInit) { inits.push(init); }
  observe(element: Element) { observed.set(element, this.callback); }
  unobserve(element: Element) { observed.delete(element); }
  disconnect() { for (const [element, callback] of observed) if (callback === this.callback) observed.delete(element); }
  takeRecords() { return []; }
}
const bubbles = () => [...document.querySelectorAll<HTMLElement>("[data-message-bubble]")];
const seen = (targets: HTMLElement[], on = true) => act(() => {
  for (const target of targets) observed.get(target)?.([{ target, isIntersecting: on } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
});
/** Longer than a batch's wait and the detector's load: anything that was to be asked has been. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 120)));

const ENGLISH: Record<string, string> = {
  "Olá, tudo bem?": "Hi, how are you?",
  "Chego em 10 minutos": "I'll be there in 10 minutes",
};
const english = (pair: string, texts: readonly string[]) => texts.map((text) => ENGLISH[text] ?? `${pair}: ${text}`);

let n = 0;
const received = (text: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({ id: `m${++n}`, text, sender: "peer", timestamp: 1_700_000_000_000 + n, ...patch });
const chat = (messages: ChatMessage[], id = "s1") => renderApp(
  <CueChat.Provider value={id}>{messages.map((m) => <MessageBubble key={m.id} message={m} peerPubKey="peer" />)}</CueChat.Provider>,
);
const settings = (translateMessages: boolean) => localStorage.setItem("ghostly_app_settings", JSON.stringify({ language: "en", translateMessages }));
const asked = () => runtime.translateTexts.mock.calls as [string, string[]][];

beforeEach(() => {
  fakeEngine.reset();
  forgetTranslations();
  observed.clear();
  inits = [];
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  vi.stubEnv("VITE_TRANSLATE", "1");
  runtime.desktop = true;
  runtime.translateTexts.mockReset();
  runtime.translateTexts.mockImplementation(async (pair: string, texts: string[]) => english(pair, texts));
  settings(true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
});

describe("a received message shows its translation, with Show original", () => {
  it("in the app's language once on screen, says from which, and Show original swaps it in place and back", async () => {
    const { user } = chat([received("Olá, tudo bem?")]);
    await seen(bubbles());
    const body = await screen.findByTestId("message-body");
    await waitFor(() => expect(within(body).getByTestId("message-text")).toHaveTextContent("Hi, how are you?"));
    expect(asked()).toEqual([["pt-en", ["Olá, tudo bem?"]]]);
    const line = within(body).getByTestId("message-translated");
    expect(line).toHaveTextContent("Translated from Portuguese · Show original");

    await user.click(within(line).getByRole("button", { name: "Show original" }));
    expect(within(body).getByTestId("message-text")).toHaveTextContent("Olá, tudo bem?");
    await user.click(within(line).getByRole("button", { name: "Show translation" }));
    expect(within(body).getByTestId("message-text")).toHaveTextContent("Hi, how are you?");
    expect(asked()).toHaveLength(1);
  });

  it("shows the original until the translation comes, with no line meanwhile", async () => {
    let answer!: (texts: string[]) => void;
    runtime.translateTexts.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    chat([received("Olá, tudo bem?")]);
    await seen(bubbles());
    await waitFor(() => expect(asked()).toHaveLength(1));
    expect(screen.getByTestId("message-text")).toHaveTextContent("Olá, tudo bem?");
    expect(screen.queryByTestId("message-translated")).not.toBeInTheDocument();
    await act(async () => answer(["Hi, how are you?"]));
    expect(screen.getByTestId("message-text")).toHaveTextContent("Hi, how are you?");
  });

  it("never translates my messages, messages already in the app's language, or a file's", async () => {
    chat([
      received("Olá, tudo bem?", { sender: "me" }),
      received("See you tomorrow at the station"),
      received("Olá, tudo bem?", { file: { id: "f1", name: "olá.txt", size: 10, mime: "text/plain" } }),
    ]);
    await seen(bubbles());
    await settle();
    expect(runtime.translateTexts).not.toHaveBeenCalled();
    expect(screen.queryByTestId("message-translated")).not.toBeInTheDocument();
  });

  it("a long message waits for its Translate", async () => {
    const long = `Olá, tudo bem? ${"a ".repeat(LONG_TEXT / 2)}`;
    const { user } = chat([received(long)]);
    await seen(bubbles());
    await settle();
    expect(runtime.translateTexts).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Translate" }));
    await waitFor(() => expect(screen.getByTestId("message-text")).toHaveTextContent(`pt-en: ${long.trim()}`));
    expect(asked()).toEqual([["pt-en", [long]]]);
  });

  it("with no model for the language, shows the original and asks no more of that pair", async () => {
    runtime.translateTexts.mockRejectedValue(new TranslateError("no-model", "Translation model not downloaded"));
    chat([received("Olá, tudo bem?")]);
    await seen(bubbles());
    await waitFor(() => expect(asked()).toHaveLength(1));
    await settle();
    chat([received("Chego em 10 minutos")], "s2");
    await seen(bubbles());
    await settle();
    expect(asked()).toHaveLength(1);
    expect(screen.queryByTestId("message-translated")).not.toBeInTheDocument();
  });

  it("a translation is kept for the session: the chat opened again asks nothing", async () => {
    const message = received("Olá, tudo bem?");
    const first = chat([message]);
    await seen(bubbles());
    await screen.findByTestId("message-translated");
    first.unmount();
    chat([message]);
    await seen(bubbles());
    expect(await screen.findByTestId("message-text")).toHaveTextContent("Hi, how are you?");
    expect(asked()).toHaveLength(1);
  });
});

describe("arrivals are translated in batches, only near the screen", () => {
  it("a message off screen is not translated until it comes within a screenful", async () => {
    chat([received("Olá, tudo bem?"), received("Chego em 10 minutos")]);
    const [top, bottom] = bubbles();
    await seen([bottom]);
    await waitFor(() => expect(screen.getAllByTestId("message-text")[1]).toHaveTextContent("I'll be there in 10 minutes"));
    await settle();
    expect(asked()).toEqual([["pt-en", ["Chego em 10 minutos"]]]);
    expect(inits.map((init) => init?.rootMargin)).toEqual(["100% 0px"]);

    await seen([top]);
    await waitFor(() => expect(screen.getAllByTestId("message-text")[0]).toHaveTextContent("Hi, how are you?"));
    expect(asked()).toEqual([["pt-en", ["Chego em 10 minutos"]], ["pt-en", ["Olá, tudo bem?"]]]);
  });

  it("messages that come on screen together go in one request per language, at most a batch each", async () => {
    const portuguese = Array.from({ length: BATCH_TEXTS + 5 }, (_, i) => received(`Olá, tudo bem? ${i}`));
    chat([...portuguese, received("Hola, gracias")]);
    await seen(bubbles());
    await waitFor(() => expect(screen.getAllByTestId("message-translated")).toHaveLength(BATCH_TEXTS + 6));
    expect(asked().map(([pair, texts]) => [pair, texts.length])).toEqual([["pt-en", BATCH_TEXTS], ["pt-en", 5], ["es-en", 1]]);
  });

  it("the same text twice on screen is asked once", async () => {
    chat([received("Olá, tudo bem?"), received("Olá, tudo bem?")]);
    await seen(bubbles());
    await waitFor(() => expect(screen.getAllByTestId("message-translated")).toHaveLength(2));
    expect(asked()).toEqual([["pt-en", ["Olá, tudo bem?"]]]);
  });
});

describe("whether a chat translates", () => {
  it("a chat's own choice wins over Settings; a chat that never chose follows Settings", () => {
    settings(false);
    expect(translationOn("s1")).toBe(false);
    localStorage.setItem("ghostly_translate_s1", "on");
    expect(translationOn("s1")).toBe(true);
    settings(true);
    expect(translationOn("s2")).toBe(true);
    localStorage.setItem("ghostly_translate_group:g1", "off");
    expect(translationOn("group:g1")).toBe(false);
  });

  it("a chat set to Off translates nothing while Settings is on", async () => {
    localStorage.setItem("ghostly_translate_s1", "off");
    chat([received("Olá, tudo bem?")]);
    await seen(bubbles());
    await settle();
    expect(runtime.translateTexts).not.toHaveBeenCalled();
  });

  it("turned on while the chat is open, the messages on screen are translated", async () => {
    settings(false);
    chat([received("Olá, tudo bem?")]);
    await seen(bubbles());
    await settle();
    expect(runtime.translateTexts).not.toHaveBeenCalled();
    await act(async () => {
      localStorage.setItem("ghostly_translate_s1", "on");
      window.dispatchEvent(new Event(CHAT_TRANSLATE_EVENT));
    });
    await seen(bubbles());
    await waitFor(() => expect(screen.getByTestId("message-text")).toHaveTextContent("Hi, how are you?"));
  });

  it("nothing in a build without VITE_TRANSLATE, nor in an app other than Desktop", async () => {
    vi.stubEnv("VITE_TRANSLATE", "");
    const first = chat([received("Olá, tudo bem?")]);
    await seen(bubbles());
    await settle();
    first.unmount();
    vi.stubEnv("VITE_TRANSLATE", "1");
    runtime.desktop = false;
    chat([received("Olá, tudo bem?")]);
    await seen(bubbles());
    await settle();
    expect(runtime.translateTexts).not.toHaveBeenCalled();
    expect(observed.size).toBe(0);
  });
});
