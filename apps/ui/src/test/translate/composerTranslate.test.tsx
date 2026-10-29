import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageInput } from "../../components/MessageInput";
import { TranslateError } from "../../desktop/translate";
import type { ComposerTranslation } from "../../hooks/useDraftTranslation";
import { renderApp } from "../render";

const NSEC = "nsec1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqstywftw";
const SEED = `${"abandon ".repeat(11)}about`;

/** A translator that writes the words in capitals and says which pair it was asked for. */
const capitals = () => vi.fn(async (pair: string, texts: string[]) => texts.map((text) => `${text.toUpperCase()} [${pair}]`));

function setup(translation: ComposerTranslation, props: Partial<Parameters<typeof MessageInput>[0]> = {}) {
  const onSend = vi.fn(async () => null);
  const view = renderApp(<MessageInput onSend={onSend} translation={translation} {...props} />);
  return { ...view, onSend, field: screen.getByRole("textbox") };
}

beforeEach(() => { vi.stubEnv("VITE_TRANSLATE", "1"); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("the composer's Translate", () => {
  it("shows for a draft in a chat with another language, only in a build with translation", async () => {
    const { user, field, unmount } = setup({ language: "it", translate: capitals() });
    expect(screen.queryByTestId("composer-translate")).not.toBeInTheDocument();
    await user.type(field, "see you tomorrow");
    expect(screen.getByTestId("composer-translate")).toHaveAccessibleName("Translate into Italian");
    unmount();
    vi.stubEnv("VITE_TRANSLATE", "");
    const off = setup({ language: "it", translate: capitals() });
    await off.user.type(off.field, "see you tomorrow");
    expect(screen.queryByTestId("composer-translate")).not.toBeInTheDocument();
  });

  it("is not offered in a chat in the app's own language", async () => {
    const { user, field } = setup({ language: "en", translate: capitals() });
    await user.type(field, "see you tomorrow");
    expect(screen.queryByTestId("composer-translate")).not.toBeInTheDocument();
  });

  it("translates on press only, shows the translation above the field, and Enter sends it", async () => {
    const translate = capitals();
    const { user, field, onSend } = setup({ language: "it", translate });
    await user.type(field, "see you tomorrow");
    expect(translate).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("composer-translate"));
    const shown = await screen.findByTestId("translate-text");
    expect(shown).toHaveValue("SEE YOU TOMORROW [en-it]");
    expect(screen.getByRole("region", { name: "Translation to Italian" })).toBeInTheDocument();
    expect(translate).toHaveBeenCalledTimes(1);
    // The draft stays in the field until something is sent.
    expect(field).toHaveValue("see you tomorrow");
    await user.type(field, "{Enter}");
    expect(onSend).toHaveBeenCalledWith("SEE YOU TOMORROW [en-it]", undefined, { translated: { to: "it", original: "see you tomorrow" } });
    expect(field).toHaveValue("");
    expect(screen.queryByTestId("translate-preview")).not.toBeInTheDocument();
  });

  it("sends the translation as edited in the preview", async () => {
    const { user, field, onSend } = setup({ language: "it", translate: async () => ["ci vediamo domani"] });
    await user.type(field, "see you tomorrow");
    await user.click(screen.getByTestId("composer-translate"));
    const shown = await screen.findByTestId("translate-text");
    await user.clear(shown);
    await user.type(shown, "a domani!");
    await user.click(screen.getByTestId("translate-send"));
    expect(onSend).toHaveBeenCalledWith("a domani!", undefined, { translated: { to: "it", original: "see you tomorrow" } });
  });

  it("Send original sends the draft as typed; Cancel goes back to it", async () => {
    const { user, field, onSend } = setup({ language: "it", translate: capitals() });
    await user.type(field, "see you tomorrow");
    await user.click(screen.getByTestId("composer-translate"));
    await screen.findByTestId("translate-text");
    await user.click(screen.getByTestId("translate-cancel"));
    expect(screen.queryByTestId("translate-preview")).not.toBeInTheDocument();
    expect(field).toHaveValue("see you tomorrow");
    expect(onSend).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("composer-translate"));
    await user.click(await screen.findByTestId("translate-send-original"));
    expect(onSend).toHaveBeenCalledWith("see you tomorrow");
    expect(screen.queryByTestId("translate-preview")).not.toBeInTheDocument();
  });

  it("goes stale when the draft changes: Translate again, and Enter does not send the old translation", async () => {
    const translate = capitals();
    const { user, field, onSend } = setup({ language: "it", translate });
    await user.type(field, "see you");
    await user.click(screen.getByTestId("composer-translate"));
    await screen.findByTestId("translate-text");
    await user.type(field, " tomorrow");
    expect(screen.getByTestId("translate-stale")).toHaveTextContent("The message changed");
    expect(screen.queryByTestId("translate-send")).not.toBeInTheDocument();
    await user.type(field, "{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("translate-text")).toHaveValue("SEE YOU TOMORROW [en-it]"));
    expect(screen.queryByTestId("translate-stale")).not.toBeInTheDocument();
    expect(translate).toHaveBeenCalledTimes(2);
  });

  it("never translates code, links or tokens", async () => {
    const translate = capitals();
    const { user, field } = setup({ language: "fr", translate });
    await user.type(field, "run `npm ci` then open https://ghostly.example/x");
    await user.click(screen.getByTestId("composer-translate"));
    expect(await screen.findByTestId("translate-text")).toHaveValue("RUN [en-fr] `npm ci` THEN OPEN [en-fr] https://ghostly.example/x");
    expect(translate).toHaveBeenCalledWith("en-fr", ["run", "then open"]);
  });

  it("translates from the draft's own language when the detector is sure of it", async () => {
    const translate = capitals();
    const { user, field } = setup({ language: "it", translate, detect: () => [{ code: "pt", probability: 0.95 }] });
    await user.type(field, "até amanhã então");
    await user.click(screen.getByTestId("composer-translate"));
    expect(await screen.findByTestId("translate-text")).toHaveValue("ATÉ AMANHÃ ENTÃO [pt-it]");
  });

  it("a draft already in the chat's language is shown as it is, and goes with nothing kept beside it", async () => {
    const translate = capitals();
    const { user, field, onSend } = setup({ language: "it", translate, detect: () => [{ code: "it", probability: 0.95 }] });
    await user.type(field, "ci vediamo domani");
    await user.click(screen.getByTestId("composer-translate"));
    expect(await screen.findByTestId("translate-text")).toHaveValue("ci vediamo domani");
    expect(screen.getByText("Already in Italian")).toBeInTheDocument();
    expect(translate).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("translate-send"));
    expect(onSend).toHaveBeenCalledWith("ci vediamo domani");
  });

  it("in a group with no single language, asks which first, most used first", async () => {
    const { user, field, onSend } = setup({ language: null, languages: ["es", "it"], translate: capitals() });
    await user.type(field, "see you tomorrow");
    expect(screen.getByTestId("composer-translate")).toHaveAccessibleName("Translate");
    await user.click(screen.getByTestId("composer-translate"));
    const choices = screen.getAllByTestId("translate-choose");
    expect(choices.map((choice) => choice.textContent)).toEqual(["Spanish", "Italian"]);
    await user.click(choices[0]!);
    expect(await screen.findByTestId("translate-text")).toHaveValue("SEE YOU TOMORROW [en-es]");
    await user.type(field, "{Enter}");
    expect(onSend).toHaveBeenCalledWith("SEE YOU TOMORROW [en-es]", undefined, { translated: { to: "es", original: "see you tomorrow" } });
  });

  it("keeps the group members the draft named, wherever the translation puts them", async () => {
    const { user, field, onSend } = setup({ language: "pt", translate: async () => ["fala com", "amanhã"] },
      { mentions: { candidates: [{ key: "bobkey", name: "Bob", tag: "bobk" }] } });
    await user.type(field, "talk to @Bo");
    await user.click(await screen.findByTestId("mention-option"));
    await user.type(field, "tomorrow");
    await user.click(screen.getByTestId("composer-translate"));
    expect(await screen.findByTestId("translate-text")).toHaveValue("fala com @Bob amanhã");
    await user.type(field, "{Enter}");
    expect(onSend).toHaveBeenCalledWith("fala com @Bob amanhã", [{ k: "bobkey", o: 9, l: 4 }], { translated: { to: "pt", original: "talk to @Bob tomorrow" } });
  });

  it("asks for the reverse model the first time, and translates once it is downloaded", async () => {
    let installed = false;
    const translate = vi.fn(async (_pair: string, texts: string[]) => {
      if (!installed) throw new TranslateError("no-model", "Translation model not downloaded");
      return texts.map(() => "a domani");
    });
    const askModel = vi.fn(async () => { installed = true; return true; });
    const { user, field } = setup({ language: "it", translate, askModel });
    await user.type(field, "see you tomorrow");
    await user.click(screen.getByTestId("composer-translate"));
    expect(await screen.findByTestId("translate-text")).toHaveValue("a domani");
    expect(askModel).toHaveBeenCalledWith("en-it");
  });

  it("Not now leaves the draft as it is; with no question to ask, the composer says the model is missing", async () => {
    const translate = vi.fn(async () => { throw new TranslateError("no-model", "Translation model not downloaded"); });
    const { user, field, unmount } = setup({ language: "it", translate, askModel: async () => false });
    await user.type(field, "see you tomorrow");
    await user.click(screen.getByTestId("composer-translate"));
    await waitFor(() => expect(screen.queryByTestId("translate-preview")).not.toBeInTheDocument());
    expect(field).toHaveValue("see you tomorrow");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    unmount();
    const bare = setup({ language: "it", translate });
    await bare.user.type(bare.field, "see you tomorrow");
    await act(async () => { await bare.user.click(screen.getByTestId("composer-translate")); });
    expect(await screen.findByRole("alert")).toHaveTextContent("English to Italian is not downloaded");
  });

  it("asks the secret guard about the draft before translating it: Cancel translates nothing", async () => {
    const translate = capitals();
    const { user, field, onSend } = setup({ language: "it", translate });
    await user.type(field, `my key ${NSEC}`);
    await user.click(screen.getByTestId("composer-translate"));
    expect(screen.getByRole("alertdialog", { name: "Send a Nostr private key?" })).toBeInTheDocument();
    expect(translate).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("secret-guard-cancel"));
    expect(translate).not.toHaveBeenCalled();
    expect(screen.queryByTestId("translate-preview")).not.toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("after Send anyway, translates the nsec's draft once, asks nothing more, and keeps no original of it", async () => {
    const translate = capitals();
    const { user, field, onSend } = setup({ language: "it", translate });
    await user.type(field, `my key ${NSEC}`);
    await user.click(screen.getByTestId("composer-translate"));
    await user.click(screen.getByTestId("secret-guard-send"));
    // The key is kept as typed in the translation.
    expect(await screen.findByTestId("translate-text")).toHaveValue(`MY KEY [en-it] ${NSEC}`);
    await user.type(field, "{Enter}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    // Sent translated, but nothing of the draft is kept beside it (a draft with a key is never stored).
    expect(onSend).toHaveBeenCalledWith(`MY KEY [en-it] ${NSEC}`);
  });

  it("a seed in the draft is never translated without the guard asking first", async () => {
    const translate = capitals();
    const { user, field } = setup({ language: "it", translate });
    await user.type(field, SEED);
    await user.click(screen.getByTestId("composer-translate"));
    expect(screen.getByRole("alertdialog")).toHaveAttribute("data-kind", "mnemonic");
    expect(translate).not.toHaveBeenCalled();
  });

  it("a translation that fails to send gives the draft as typed back, and sent again it still keeps its original", async () => {
    const translate = capitals();
    const { user, field, onSend } = setup({ language: "it", translate });
    onSend.mockResolvedValueOnce("Not connected" as never);
    await user.type(field, "see you tomorrow");
    await user.click(screen.getByTestId("composer-translate"));
    await screen.findByTestId("translate-text");
    await user.type(field, "{Enter}");
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    expect(field).toHaveValue("see you tomorrow");
    await user.click(screen.getByTestId("composer-translate"));
    await screen.findByTestId("translate-text");
    await user.type(field, "{Enter}");
    expect(onSend).toHaveBeenLastCalledWith("SEE YOU TOMORROW [en-it]", undefined, { translated: { to: "it", original: "see you tomorrow" } });
  });

  it("is not offered in a group whose only language is the app's, and the app's language is no choice", async () => {
    const only = setup({ language: null, languages: ["en"], translate: capitals() });
    await only.user.type(only.field, "see you tomorrow");
    expect(screen.queryByTestId("composer-translate")).not.toBeInTheDocument();
    only.unmount();
    const { user, field } = setup({ language: null, languages: ["en", "it"], translate: capitals() });
    await user.type(field, "see you tomorrow");
    await user.click(screen.getByTestId("composer-translate"));
    expect(screen.getAllByTestId("translate-choose").map((choice) => choice.dataset.language)).toEqual(["it"]);
  });
});
