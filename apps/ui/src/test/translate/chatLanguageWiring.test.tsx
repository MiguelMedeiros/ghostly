import { act, screen, waitFor, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * A chat's language (lib/chatLanguage.ts) as one feature with the rest: the Translation sheet shows and changes it,
 * the received messages' detections make it, a short message is read in it, choosing On asks for its models, and it
 * goes with a deleted group.
 */

/** Desktop as Rust answers: the pinned pairs, which are on disk, and what translating gives. */
const desktop = vi.hoisted(() => ({
  downloaded: new Set<string>(),
  calls: [] as [string, unknown][],
  runtime: true,
}));
const MB = 1024 * 1024;
const PINNED: Record<string, number> = {
  "pt-en": 37 * MB, "en-pt": 36.4 * MB, "es-en": 37 * MB, "en-es": 36.6 * MB, "it-en": 37.1 * MB, "en-it": 36.5 * MB,
};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: { pair?: string; texts?: string[] }) => {
    desktop.calls.push([command, args]);
    switch (command) {
      case "translation_status":
        return { runtime: desktop.runtime, runtimeBytes: 80 * MB, pairs: Object.entries(PINNED).map(([pair, bytes]) => ({ pair, bytes, downloaded: desktop.downloaded.has(pair) })) };
      case "translation_download":
        if (!(args!.pair! in PINNED)) throw `Unknown translation pair ${args!.pair}`;
        desktop.downloaded.add(args!.pair!);
        return undefined;
      case "translate_texts": {
        // A pair through English needs both of its models (Rust pivots).
        const [from, to] = args!.pair!.split("-");
        const needs = from === "en" || to === "en" ? [args!.pair!] : [`${from}-en`, `en-${to}`];
        if (!needs.every((pair) => desktop.downloaded.has(pair))) throw "Translation model not downloaded";
        return args!.texts!.map((text) => `[${args!.pair}] ${text}`);
      }
      default: return undefined;
    }
  }),
  listen: async () => () => {},
  getVersion: async () => "0.4.0",
}));
// The detector the app will load, as a few words of each language.
vi.mock("../../lib/translateDetector", () => ({
  loadDetector: async () => (text: string) =>
    /ciao|domani|stazione/i.test(text) ? [{ code: "it", probability: 0.95 }]
      : /hola|mañana|estación/i.test(text) ? [{ code: "es", probability: 0.95 }]
        : [{ code: "en", probability: 0.95 }],
}));

import { MessageBubble } from "../../components/MessageBubble";
import { TranslateMenu } from "../../components/ChatTranslate";
import { languageSetByHand, setChatLanguage } from "../../lib/chatLanguage";
import { groupChat } from "../../lib/chatMute";
import { setChatTranslate } from "../../lib/chatTranslate";
import { CueChat } from "../../lib/cues";
import { forgetGroupLocal } from "../../lib/groups";
import { getPrefix } from "../../lib/storage";
import { forgetTranslations } from "../../lib/translateReceived";
import { readingPairs } from "../../lib/translateSettings";
import type { ChatMessage } from "../../lib/types";
import { renderApp } from "../render";
import { windowIs } from "../viewport";

/** An IntersectionObserver that puts every bubble on screen at once. */
class OnScreen {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) { queueMicrotask(() => this.callback([{ target, isIntersecting: true } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver)); }
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

const settings = (language: "en" | "pt", translateMessages: boolean) =>
  localStorage.setItem("ghostly_app_settings", JSON.stringify({ language, translateMessages }));
const asked = (command: string) => desktop.calls.filter(([name]) => name === command).map(([, args]) => args);

let n = 0;
const received = (text: string): ChatMessage => ({ id: `l${++n}`, text, sender: "peer", timestamp: 1_700_000_000_000 + n });

/** A chat: its translation sheet open, and its messages. */
function Chat({ chat = "s1", messages }: { chat?: string; messages: ChatMessage[] }) {
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <CueChat.Provider value={chat}>
      <button ref={anchor} type="button">⋮</button>
      <TranslateMenu chat={chat} open onClose={() => {}} anchorRef={anchor} />
      {messages.map((m) => <MessageBubble key={m.id} message={m} peerPubKey="peer" />)}
    </CueChat.Provider>
  );
}

const texts = () => screen.getAllByTestId("message-text").map((text) => text.textContent);

beforeEach(() => {
  windowIs(false);
  forgetTranslations();
  desktop.downloaded = new Set();
  desktop.calls = [];
  desktop.runtime = true;
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  vi.stubEnv("VITE_TRANSLATE", "1");
  vi.stubGlobal("IntersectionObserver", OnScreen);
});
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("the chat's language in its Translation sheet", () => {
  it("is named from the messages the chat translated, and Change sets it by hand", async () => {
    desktop.downloaded = new Set(["it-en"]);
    settings("en", true);
    const { user } = renderApp(<Chat messages={[received("Ciao, a domani alla stazione")]} />);
    await waitFor(() => expect(screen.getByTestId("chat-language-open")).toHaveTextContent("Italian (detected)"));
    await user.click(screen.getByTestId("chat-language-open"));
    await user.click(within(screen.getByTestId("chat-language-menu")).getByText("French"));
    expect(languageSetByHand("s1")).toBe("fr");
    expect(screen.getByTestId("chat-language-open")).toHaveTextContent("French (set by you)");
  });

  it("is not in the web app, even with the flag", async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
    settings("en", true);
    renderApp(<Chat messages={[]} />);
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(screen.queryByTestId("chat-language-open")).not.toBeInTheDocument();
  });
});

describe("a short message is read in the chat's one language", () => {
  it("set by hand, with no message detected yet", async () => {
    desktop.downloaded = new Set(["it-en"]);
    settings("en", true);
    setChatLanguage("s1", "it");
    renderApp(<Chat messages={[received("Sì!")]} />);
    await waitFor(() => expect(texts()).toEqual(["[it-en] Sì!"]));
  });

  it("in a group, the language of most of the others' messages, not the last one's", async () => {
    desktop.downloaded = new Set(["it-en", "es-en"]);
    settings("en", true);
    const messages = [received("Ciao a tutti"), received("A domani"), received("Alla stazione, ciao"), received("Hola, hasta mañana"), received("Sì")];
    renderApp(<Chat chat={groupChat("g1")} messages={messages} />);
    await waitFor(() => expect(texts()[4]).toBe("[it-en] Sì"));
    expect(texts()[3]).toBe("[es-en] Hola, hasta mañana");
  });

  it("set by hand while the message is on screen: it is read again in it", async () => {
    desktop.downloaded = new Set(["it-en"]);
    settings("en", true);
    const { user } = renderApp(<Chat messages={[received("Sì")]} />);
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(texts()).toEqual(["Sì"]);
    await user.click(screen.getByTestId("chat-language-open"));
    await user.click(screen.getByTestId("chat-language-it"));
    await waitFor(() => expect(texts()).toEqual(["[it-en] Sì"]));
  });
});

describe("choosing On asks for the chat's own models", () => {
  it("an English app asks for Italian to English, one way", async () => {
    settings("en", false);
    setChatLanguage("s1", "it");
    const { user } = renderApp(<Chat messages={[]} />);
    await user.click(await screen.findByTestId("translate-on"));
    const question = await screen.findByTestId("translate-download");
    expect(within(question).getByTestId("translate-download-pair")).toHaveTextContent("Italian to English, 37 MB");
    await user.click(within(question).getByTestId("translate-download-yes"));
    await waitFor(() => expect(screen.queryByTestId("translate-download")).not.toBeInTheDocument());
    expect(asked("translation_download")).toEqual([{ pair: "it-en" }]);
  });

  it("a Portuguese app reading Spanish asks for both legs through English", async () => {
    settings("pt", false);
    setChatLanguage("s1", "es");
    const { user } = renderApp(<Chat messages={[]} />);
    await user.click(await screen.findByTestId("translate-on"));
    const question = await screen.findByTestId("translate-download");
    expect(within(question).getByTestId("translate-download-pair")).toHaveTextContent("Espanhol para português, 73 MB");
    await user.click(within(question).getByTestId("translate-download-yes"));
    await waitFor(() => expect(asked("translation_download")).toEqual([{ pair: "es-en" }, { pair: "en-pt" }]));
  });

  it("asks even with the Settings switch on, which asked only for the app's language", async () => {
    desktop.downloaded = new Set(["pt-en", "en-pt"]);
    settings("pt", true);
    setChatLanguage("s1", "it");
    const { user } = renderApp(<Chat messages={[]} />);
    await user.click(await screen.findByTestId("translate-on"));
    const question = await screen.findByTestId("translate-download");
    // en-pt is here: only it-en is missing.
    expect(within(question).getByTestId("translate-download-pair")).toHaveTextContent("Italiano para português, 37 MB");
  });

  it("asks nothing for a chat in the app's own language", async () => {
    settings("en", false);
    setChatLanguage("s1", "en");
    const { user } = renderApp(<Chat messages={[]} />);
    await user.click(await screen.findByTestId("translate-on"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(screen.queryByTestId("translate-download")).not.toBeInTheDocument();
    expect(asked("translation_status")).toEqual([]);
  });

  it("asks nothing for a language with no pinned model, even with no runtime yet", async () => {
    desktop.runtime = false;
    settings("en", false);
    setChatLanguage("s1", "de");
    const { user } = renderApp(<Chat messages={[]} />);
    await user.click(await screen.findByTestId("translate-on"));
    await waitFor(() => expect(asked("translation_status").length).toBeGreaterThan(0));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(screen.queryByTestId("translate-download")).not.toBeInTheDocument();
    expect(asked("translation_download")).toEqual([]);
  });

  it("the pairs: straight when one is pinned or English is a side, else through English", () => {
    const pinned = Object.keys(PINNED);
    expect(readingPairs("it", "en", pinned)).toEqual(["it-en"]);
    expect(readingPairs("en", "pt", pinned)).toEqual(["en-pt"]);
    expect(readingPairs("es", "pt", pinned)).toEqual(["es-en", "en-pt"]);
    expect(readingPairs("es", "pt", [...pinned, "es-pt"])).toEqual(["es-pt"]);
    expect(readingPairs("pt", "pt", pinned)).toEqual([]);
  });
});

describe("a deleted group's language", () => {
  it("goes with the group, as its translation choice does", () => {
    setChatLanguage(groupChat("g1"), "it");
    setChatTranslate(groupChat("g1"), "on");
    forgetGroupLocal("g1");
    expect(languageSetByHand(groupChat("g1"))).toBeNull();
    expect(localStorage.getItem(`${getPrefix()}translate_${groupChat("g1")}`)).toBeNull();
  });
});
