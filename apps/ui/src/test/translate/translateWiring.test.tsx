import { act, screen, waitFor, within } from "@testing-library/react";
import { useRef } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The translation slices as one feature: Settings and a chat's sheet read and change the models through Desktop's own
 * commands, turning translation on asks before anything downloads, and a bubble on screen follows the chat's choice
 * and the Settings switch, and asks again once a download brought its model.
 */

/** Desktop as Rust answers: the pinned pairs, which are on disk, and what translating gives. */
const desktop = vi.hoisted(() => ({
  runtime: true,
  downloaded: new Set<string>(),
  calls: [] as [string, unknown][],
  /** The next download fails with these words. */
  failNext: null as string | null,
}));
const MB = 1024 * 1024;
const PINNED: Record<string, number> = { "pt-en": 37 * MB, "en-pt": 36.4 * MB, "es-en": 37 * MB };
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: { pair?: string; texts?: string[] }) => {
    desktop.calls.push([command, args]);
    switch (command) {
      case "translation_status":
        return { runtime: desktop.runtime, runtimeBytes: 80 * MB, pairs: Object.entries(PINNED).map(([pair, bytes]) => ({ pair, bytes, downloaded: desktop.downloaded.has(pair) })) };
      case "translation_download": {
        const failed = desktop.failNext;
        desktop.failNext = null;
        if (failed) throw failed;
        desktop.downloaded.add(args!.pair!);
        return undefined;
      }
      case "translation_remove": desktop.downloaded.delete(args!.pair!); return undefined;
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
  loadDetector: async () => (text: string) => /olá|tudo/i.test(text) ? [{ code: "pt", probability: 0.95 }] : [{ code: "en", probability: 0.95 }],
}));

import { MessageBubble } from "../../components/MessageBubble";
import { TranslateMenu } from "../../components/ChatTranslate";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { CueChat } from "../../lib/cues";
import { loadSettings } from "../../lib/settings";
import { forgetTranslations } from "../../lib/translateReceived";
import type { ChatMessage } from "../../lib/types";
import { Settings } from "../../pages/Settings";
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
const received = (text: string): ChatMessage => ({ id: `w${++n}`, text, sender: "peer", timestamp: 1_700_000_000_000 + n });

/** A chat: its translation sheet open, and its messages. */
function Chat({ messages }: { messages: ChatMessage[] }) {
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <CueChat.Provider value="s1">
      <button ref={anchor} type="button">⋮</button>
      <TranslateMenu chat="s1" open onClose={() => {}} anchorRef={anchor} />
      {messages.map((m) => <MessageBubble key={m.id} message={m} peerPubKey="peer" />)}
    </CueChat.Provider>
  );
}

const renderSettings = () => renderApp(
  <LockScreenProvider><UpdateProvider><Routes><Route path="/settings/:section?" element={<Settings />} /></Routes></UpdateProvider></LockScreenProvider>,
  { route: "/settings/appearance" },
);

beforeEach(() => {
  windowIs(false);
  forgetTranslations();
  desktop.runtime = true;
  desktop.downloaded = new Set();
  desktop.calls = [];
  desktop.failNext = null;
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

describe("Settings and the models on this computer", () => {
  it("lists the pairs Desktop has on disk, and Remove removes one through Desktop", async () => {
    desktop.downloaded = new Set(["pt-en"]);
    settings("en", true);
    const { user } = renderSettings();
    const line = await screen.findByTestId("settings-translate-pair");
    expect(screen.getAllByTestId("settings-translate-pair")).toHaveLength(1);
    expect(line).toHaveTextContent("Portuguese → English");
    expect(line).toHaveTextContent("37 MB");
    await user.click(within(line).getByRole("button", { name: "Remove Portuguese → English" }));
    expect(asked("translation_remove")).toEqual([{ pair: "pt-en" }]);
    expect(await screen.findByTestId("settings-translate-none")).toBeInTheDocument();
  });

  it("the switch turned on with no language downloaded asks first, and Download brings both ways", async () => {
    settings("pt", false);
    const { user } = renderSettings();
    await user.click(await screen.findByTestId("settings-translate"));
    const question = await screen.findByTestId("translate-download");
    expect(within(question).getByTestId("translate-download-pair")).toHaveTextContent("Português para inglês e de volta, 73 MB");
    expect(asked("translation_download")).toEqual([]);
    await user.click(within(question).getByTestId("translate-download-yes"));
    await waitFor(() => expect(screen.queryByTestId("translate-download")).not.toBeInTheDocument());
    expect(asked("translation_download")).toEqual([{ pair: "pt-en" }, { pair: "en-pt" }]);
    expect(loadSettings().translateMessages).toBe(true);
    await waitFor(() => expect(screen.getAllByTestId("settings-translate-pair")).toHaveLength(2));
  });

  it("a download that fails says so in the question, with Rust's words behind the ⓘ, and Download again finishes it", async () => {
    settings("pt", false);
    desktop.failNext = "The download did not finish";
    const { user } = renderSettings();
    await user.click(await screen.findByTestId("settings-translate"));
    const question = await screen.findByTestId("translate-download");
    await user.click(within(question).getByTestId("translate-download-yes"));
    const failed = await within(question).findByTestId("translate-download-failed");
    expect(failed).toHaveTextContent("Os idiomas não foram baixados");
    expect(failed).not.toHaveTextContent("The download did not finish");
    await user.click(within(failed).getByTestId("translate-download-failed-info"));
    expect(within(failed).getByTestId("translate-download-failed-details")).toHaveTextContent("The download did not finish");
    await user.click(within(question).getByTestId("translate-download-yes"));
    await waitFor(() => expect(screen.queryByTestId("translate-download")).not.toBeInTheDocument());
    expect(asked("translation_download")).toEqual([{ pair: "pt-en" }, { pair: "pt-en" }, { pair: "en-pt" }]);
  });
});

describe("a chat's choice and its bubbles", () => {
  it("a chat set to On in its sheet translates what is on screen while the Settings switch is off", async () => {
    desktop.downloaded = new Set(["pt-en"]);
    settings("en", false);
    const { user } = renderApp(<Chat messages={[received("Olá, tudo bem?")]} />);
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(asked("translate_texts")).toEqual([]);
    await user.click(screen.getByTestId("translate-on"));
    await waitFor(() => expect(screen.getByTestId("message-text")).toHaveTextContent("[pt-en] Olá, tudo bem?"));
    expect(asked("translate_texts")).toEqual([{ pair: "pt-en", texts: ["Olá, tudo bem?"] }]);
    // English app: nothing to ask up front, the model was here.
    expect(screen.queryByTestId("translate-download")).not.toBeInTheDocument();
  });

  it("On with the switch off and no model asks first; after Download the bubble on screen is translated", async () => {
    settings("pt", false);
    const { user } = renderApp(<Chat messages={[received("See you tomorrow at the station")]} />);
    await user.click(await screen.findByTestId("translate-on"));
    const question = await screen.findByTestId("translate-download");
    expect(within(question).getByTestId("translate-download-pair")).toHaveTextContent("Português para inglês e de volta, 73 MB");
    // Meanwhile the bubble asked and was told there is no model: it shows the original.
    await waitFor(() => expect(asked("translate_texts")).toHaveLength(1));
    expect(screen.getByTestId("message-text")).toHaveTextContent("See you tomorrow at the station");
    await user.click(within(question).getByTestId("translate-download-yes"));
    await waitFor(() => expect(screen.getByTestId("message-text")).toHaveTextContent("[en-pt] See you tomorrow at the station"));
    expect(asked("translation_download")).toEqual([{ pair: "pt-en" }, { pair: "en-pt" }]);
  });

  it("On with the switch already on asks nothing: the switch did", async () => {
    settings("pt", true);
    const { user } = renderApp(<Chat messages={[]} />);
    await user.click(await screen.findByTestId("translate-on"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(screen.queryByTestId("translate-download")).not.toBeInTheDocument();
    expect(asked("translation_status")).toEqual([]);
  });

  it("a removal in Settings makes a translated bubble show its original again", async () => {
    desktop.downloaded = new Set(["pt-en"]);
    settings("en", true);
    const { user } = renderApp(<>
      <Chat messages={[received("Olá, tudo bem?")]} />
      <LockScreenProvider><UpdateProvider><Routes><Route path="/settings/:section?" element={<Settings />} /></Routes></UpdateProvider></LockScreenProvider>
    </>, { route: "/settings/appearance" });
    await waitFor(() => expect(screen.getByTestId("message-text")).toHaveTextContent("[pt-en] Olá, tudo bem?"));
    await user.click(await screen.findByRole("button", { name: "Remove Portuguese → English" }));
    await waitFor(() => expect(screen.getByTestId("message-text")).toHaveTextContent(/^Olá, tudo bem\?$/));
    // Asked again, and told there is no model now.
    await waitFor(() => expect(asked("translate_texts")).toHaveLength(2));
    expect(screen.getByTestId("message-text")).toHaveTextContent(/^Olá, tudo bem\?$/);
  });
});

describe("where a chat's translation shows", () => {
  it("only where Settings offers it: not in the web app, even with the flag", async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
    settings("en", false);
    renderApp(<Chat messages={[]} />);
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(screen.queryByTestId("translate-menu")).not.toBeInTheDocument();
  });
});
