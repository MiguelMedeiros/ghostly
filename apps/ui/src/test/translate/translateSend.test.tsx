import { act, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranslateMenu } from "../../components/ChatTranslate";
import { TranslateSendMenuItem } from "../../components/chat/TranslateSendMenuItem";
import { MessageInput } from "../../components/MessageInput";
import type { ComposerTranslation } from "../../hooks/useDraftTranslation";
import { setTranslatesWhatISend, translatesWhatISend } from "../../lib/chatTranslateSend";
import { forgetGroupLocal } from "../../lib/groups";
import { getPrefix } from "../../lib/storage";
import type { DetectLanguages } from "../../lib/translateWhich";
import { renderApp } from "../render";

const capitals = () => vi.fn(async (pair: string, texts: string[]) => texts.map((text) => `${text.toUpperCase()} [${pair}]`));
const sure = (code: string): DetectLanguages => () => [{ code, probability: 0.95 }];

let chats = 0;

/** A new chat's composer; `sends`: its Translate what I send, turned on before it opens. */
function setup(translation: ComposerTranslation, sends = false) {
  const chat = `send-${++chats}`;
  if (sends) setTranslatesWhatISend(chat, true);
  const onSend = vi.fn(async () => null);
  const view = renderApp(<MessageInput draftId={chat} onSend={onSend} translation={translation} />);
  return { ...view, onSend, field: screen.getByRole("textbox") };
}

beforeEach(() => { vi.stubEnv("VITE_TRANSLATE", "1"); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); localStorage.clear(); });

describe("Translate what I send", () => {
  it("is off by default: Send sends the draft as typed", async () => {
    const translate = capitals();
    const { user, field, onSend } = setup({ language: "it", translate, detect: sure("en") });
    await user.type(field, "see you tomorrow{Enter}");
    expect(onSend).toHaveBeenCalledWith("see you tomorrow");
    expect(translate).not.toHaveBeenCalled();
  });

  it("on, Enter translates and sends at once, without the preview", async () => {
    const { user, field, onSend } = setup({ language: "it", translate: capitals(), detect: sure("en") }, true);
    await user.type(field, "see you tomorrow{Enter}");
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("SEE YOU TOMORROW [en-it]", undefined, { translated: { to: "it", original: "see you tomorrow" } }));
    expect(field).toHaveValue("");
    expect(screen.queryByTestId("translate-preview")).not.toBeInTheDocument();
  });

  it("on, the send button says so and does the same", async () => {
    const { user, field, onSend } = setup({ language: "it", translate: capitals(), detect: sure("en") }, true);
    await user.type(field, "see you tomorrow");
    await user.click(screen.getByRole("button", { name: "Send translated into Italian" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("SEE YOU TOMORROW [en-it]", undefined, { translated: { to: "it", original: "see you tomorrow" } }));
  });

  it("falls back to the preview when the draft's language is not certain", async () => {
    const translate = capitals();
    const unsure: DetectLanguages = () => [{ code: "vo", probability: 0.3 }];
    const { user, field, onSend, unmount } = setup({ language: "it", translate, detect: unsure }, true);
    await user.type(field, "lol no way{Enter}");
    expect(await screen.findByTestId("translate-text")).toHaveValue("LOL NO WAY [en-it]");
    expect(onSend).not.toHaveBeenCalled();
    unmount();
    // No detector at all: the draft's language is not known either.
    const bare = setup({ language: "it", translate }, true);
    await bare.user.type(bare.field, "see you tomorrow{Enter}");
    expect(await screen.findByTestId("translate-text")).toHaveValue("SEE YOU TOMORROW [en-it]");
    expect(bare.onSend).not.toHaveBeenCalled();
  });

  it("falls back to the preview in a group with no single language: it asks which", async () => {
    const { user, field, onSend } = setup({ language: null, languages: ["es", "it"], translate: capitals(), detect: sure("en") }, true);
    await user.type(field, "see you tomorrow{Enter}");
    expect(screen.getAllByTestId("translate-choose")).toHaveLength(2);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("sends a draft already in the chat's language as typed", async () => {
    const translate = capitals();
    const { user, field, onSend } = setup({ language: "it", translate, detect: sure("it") }, true);
    await user.type(field, "ci vediamo domani{Enter}");
    expect(onSend).toHaveBeenCalledWith("ci vediamo domani");
    expect(translate).not.toHaveBeenCalled();
  });

  it("does not send what was not seen: a draft changed while it was translated shows the preview, stale", async () => {
    let finish!: (texts: string[]) => void;
    const translate = vi.fn(() => new Promise<string[]>((resolve) => { finish = resolve; }));
    const { user, field, onSend } = setup({ language: "it", translate, detect: sure("en") }, true);
    await user.type(field, "see you tomorrow{Enter}");
    expect(screen.getByTestId("translate-preview")).toHaveAttribute("data-step", "working");
    await user.type(field, "!");
    await act(async () => { finish(["a domani"]); });
    expect(await screen.findByTestId("translate-text")).toHaveValue("a domani");
    expect(screen.getByTestId("translate-stale")).toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
  });
  it("asks the secret guard about the draft first; after Send anyway it goes translated, asking once, with no original kept", async () => {
    const NSEC = "nsec1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqstywftw";
    const translate = capitals();
    const { user, field, onSend } = setup({ language: "it", translate, detect: sure("en") }, true);
    await user.type(field, `here is my key ${NSEC}{Enter}`);
    expect(screen.getByRole("alertdialog", { name: "Send a Nostr private key?" })).toBeInTheDocument();
    expect(translate).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("secret-guard-send"));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(`HERE IS MY KEY [en-it] ${NSEC}`));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});

describe("the chat's Translate what I send switch", () => {
  it("is this device's key, translate_send_<chat>, off unless turned on, and forgotten with the group", async () => {
    const chat = "group:g1";
    const { user } = renderApp(<TranslateSendMenuItem chat={chat} />);
    const toggle = screen.getByRole("menuitemcheckbox", { name: /Translate what I send/ });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem(`${getPrefix()}translate_send_${chat}`)).toBe("on");
    expect(translatesWhatISend(chat)).toBe(true);
    await user.click(toggle);
    expect(localStorage.getItem(`${getPrefix()}translate_send_${chat}`)).toBeNull();
    act(() => setTranslatesWhatISend(chat, true));
    expect(toggle).toHaveAttribute("aria-checked", "true");
    forgetGroupLocal("g1");
    expect(translatesWhatISend(chat)).toBe(false);
  });
});

describe("the chat's Translation sheet", () => {
  afterEach(() => { delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__; });

  it("ends with Translate what I send, which turns on and off in place", async () => {
    (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    function Sheet() {
      const anchor = useRef<HTMLButtonElement>(null);
      return <><button ref={anchor} type="button">⋮</button><TranslateMenu chat="s1" open onClose={() => {}} anchorRef={anchor} /></>;
    }
    const { user } = renderApp(<Sheet />);
    const rows = [...(await screen.findByTestId("translate-menu")).querySelectorAll<HTMLElement>("[data-menu-item]")];
    const row = rows[rows.length - 1]!;
    expect(row).toHaveAccessibleName(/Translate what I send/);
    await user.click(row);
    expect(translatesWhatISend("s1")).toBe(true);
    expect(screen.getByTestId("translate-send-switch")).toHaveAttribute("aria-checked", "true");
  });
});
