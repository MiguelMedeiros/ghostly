import { act, screen, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatLanguageMenu, ChatLanguageMenuItem } from "../../components/ChatLanguage";
import {
  GROUP_SHARE, GROUP_WINDOW, chatLanguageOf, forgetChatLanguage, languageChoices, languageName, languageSetByHand, setChatLanguage,
} from "../../lib/chatLanguage";
import { groupChat } from "../../lib/chatMute";
import { setStorageProfile } from "../../lib/storage";
import { renderApp } from "../render";

// covers: app.i18n

const times = (code: string | null, n: number) => Array.from({ length: n }, () => code);

afterEach(() => {
  vi.unstubAllEnvs();
  setStorageProfile("");
  localStorage.clear();
});

describe("a 1:1 chat's language: the last language the contact wrote with confidence", () => {
  it("is the last confident language, whatever came before", () => {
    expect(chatLanguageOf(["it", "it", "it", "es"], { group: false })).toEqual({ language: "es", by: "detected", languages: ["it", "es"] });
  });

  it("skips the messages the detector was not sure of", () => {
    expect(chatLanguageOf(["it", null, undefined, null], { group: false }).language).toBe("it");
  });

  it("keeps the app's own language: a contact who writes it has a chat in it", () => {
    expect(chatLanguageOf(["it", "en"], { group: false }).language).toBe("en");
  });

  it("has none before a confident message, and none is made up", () => {
    expect(chatLanguageOf([], { group: false })).toEqual({ language: null, by: null, languages: [] });
    expect(chatLanguageOf([null, null], { group: false })).toEqual({ language: null, by: null, languages: [] });
  });

  it("reads detector codes by their base language", () => {
    expect(chatLanguageOf(["pt-BR"], { group: false }).language).toBe("pt");
    expect(chatLanguageOf(["ZH_hans"], { group: false }).language).toBe("zh");
  });
});

describe("a group's language: most of the others' last 20 confident messages, at 60% or more", () => {
  it("counts the last 20 confident messages only", () => {
    expect(GROUP_WINDOW).toBe(20);
    expect(GROUP_SHARE).toBe(0.6);
    // 30 Spanish long ago, then 20 Italian: only the Italian are counted.
    expect(chatLanguageOf([...times("es", 30), ...times("it", 20)], { group: true }).language).toBe("it");
    // Unsure messages do not take a place in the 20.
    expect(chatLanguageOf([...times("es", 12), ...times("it", 8), ...times(null, 40)], { group: true }).language).toBe("es");
  });

  it("has a language at exactly 60% (12 of 20), and none at 55% (11 of 20)", () => {
    expect(chatLanguageOf([...times("pt", 8), ...times("es", 12)], { group: true })).toEqual({ language: "es", by: "detected", languages: ["es", "pt"] });
    expect(chatLanguageOf([...times("pt", 9), ...times("es", 11)], { group: true })).toEqual({ language: null, by: null, languages: ["es", "pt"] });
  });

  it("takes the share of the confident messages there are, when fewer than 20", () => {
    expect(chatLanguageOf(["fr", "fr", "de"], { group: true }).language).toBe("fr");
    expect(chatLanguageOf(["fr", "de"], { group: true }).language).toBeNull();
  });

  it("is not the last message's language, as a 1:1 chat's is", () => {
    expect(chatLanguageOf([...times("it", 15), "ja"], { group: true }).language).toBe("it");
  });

  it("lists the group's languages most used first, a tie by the latest use", () => {
    expect(chatLanguageOf(["ja", "de", "fr", "fr", "de", "ar"], { group: true }).languages).toEqual(["de", "fr", "ar", "ja"]);
  });
});

describe("a language set by hand", () => {
  it("wins over the last message and over the group's count", () => {
    expect(chatLanguageOf(["it"], { group: false, setByHand: "fr" })).toEqual({ language: "fr", by: "hand", languages: ["it"] });
    expect(chatLanguageOf(times("it", 20), { group: true, setByHand: "ja" }).language).toBe("ja");
    expect(chatLanguageOf(["it", "es"], { group: true, setByHand: "ja" })).toEqual({ language: "ja", by: "hand", languages: ["es", "it"] });
  });

  it("is kept on this device under translate_lang_<chat>, per profile, and forgotten with the chat", () => {
    setChatLanguage("s1", "it");
    setChatLanguage(groupChat("g1"), "ja");
    expect(localStorage.getItem("ghostly_translate_lang_s1")).toBe("it");
    expect(localStorage.getItem("ghostly_translate_lang_group:g1")).toBe("ja");
    expect(languageSetByHand("s1")).toBe("it");
    expect(languageSetByHand("s2")).toBeNull();

    setStorageProfile("work");
    expect(languageSetByHand("s1")).toBeNull();
    setStorageProfile("");

    forgetChatLanguage("s1");
    expect(languageSetByHand("s1")).toBeNull();
    setChatLanguage(groupChat("g1"), null);
    expect(localStorage.getItem("ghostly_translate_lang_group:g1")).toBeNull();
  });

  it("ignores a stored value that is not a language code", () => {
    localStorage.setItem("ghostly_translate_lang_s1", "<script>");
    expect(languageSetByHand("s1")).toBeNull();
    localStorage.setItem("ghostly_translate_lang_s1", "PT-br");
    expect(languageSetByHand("s1")).toBe("pt");
  });
});

describe("the languages to choose from", () => {
  it("are the chat's own languages first, then the app's languages, each once", () => {
    expect(languageChoices(["de", "it"])).toEqual(["de", "it", "en", "pt", "es", "fr", "zh", "ja", "ar"]);
  });

  it("are named in the app's language", () => {
    expect(languageName("it", "en")).toBe("Italian");
    expect(languageName("it", "pt")).toBe("italiano");
    expect(languageName("qq", "en")).toBe("qq");
  });
});

/** The chat's sheet as slice 9 will hold it: the row, and the choices it opens. */
function Sheet({ chat, detected, group = false }: { chat: string; detected: readonly (string | null)[]; group?: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  return (
    <div ref={anchor}>
      <ChatLanguageMenuItem chat={chat} detected={detected} group={group} onChoose={() => setOpen(true)} />
      <ChatLanguageMenu chat={chat} detected={detected} group={group} open={open} onClose={() => setOpen(false)} anchorRef={anchor} />
    </div>
  );
}

describe("the sheet's Change row", () => {
  it("shows nothing while the build has no translation", () => {
    const { container } = renderApp(<Sheet chat="s1" detected={["it"]} />);
    expect(container.textContent).toBe("");
  });

  it("names the detected language, and a language chosen there is kept and shown as set by hand", async () => {
    vi.stubEnv("VITE_TRANSLATE", "1");
    const { user } = renderApp(<Sheet chat="s1" detected={["it"]} />);
    const row = screen.getByTestId("chat-language-open");
    expect(row.textContent).toContain("Italian (detected)");

    await user.click(row);
    const menu = screen.getByTestId("chat-language-menu");
    // The chat's own language first, then the app's.
    const items = within(menu).getAllByRole("menuitemcheckbox").map((item) => item.getAttribute("data-language"));
    expect(items.slice(0, 4)).toEqual([null, "it", "en", "pt"]);
    expect(within(menu).getByTestId("chat-language-auto").getAttribute("aria-checked")).toBe("true");
    await user.click(within(menu).getByText("French"));

    expect(languageSetByHand("s1")).toBe("fr");
    expect(screen.getByTestId("chat-language-open").textContent).toContain("French (set by you)");
  });

  it("goes back to detecting from the others' messages", async () => {
    vi.stubEnv("VITE_TRANSLATE", "1");
    setChatLanguage("s1", "fr");
    const { user } = renderApp(<Sheet chat="s1" detected={["it"]} />);
    await user.click(screen.getByTestId("chat-language-open"));
    await user.click(screen.getByTestId("chat-language-auto"));
    expect(languageSetByHand("s1")).toBeNull();
    expect(screen.getByTestId("chat-language-open").textContent).toContain("Italian (detected)");
  });

  it("says a group with no single language has several", () => {
    vi.stubEnv("VITE_TRANSLATE", "1");
    renderApp(<Sheet chat={groupChat("g1")} group detected={["it", "es"]} />);
    expect(screen.getByTestId("chat-language-open").textContent).toContain("Several languages");
  });

  it("says a chat with no confident language yet has none known", () => {
    vi.stubEnv("VITE_TRANSLATE", "1");
    renderApp(<Sheet chat="s1" detected={[]} />);
    expect(screen.getByTestId("chat-language-open").textContent).toContain("Not known yet");
  });

  it("is redrawn when another page of the app sets the language", () => {
    vi.stubEnv("VITE_TRANSLATE", "1");
    renderApp(<Sheet chat="s1" detected={["it"]} />);
    act(() => {
      localStorage.setItem("ghostly_translate_lang_s1", "ja");
      window.dispatchEvent(new StorageEvent("storage", { key: "ghostly_translate_lang_s1" }));
    });
    expect(screen.getByTestId("chat-language-open").textContent).toContain("Japanese (set by you)");
  });
});
