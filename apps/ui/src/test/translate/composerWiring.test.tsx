import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The composer's translation as one feature with the rest (wiring 3): whether a chat's composer offers Translate
 * follows the chat's own On/Off or the Settings switch (lib/chatTranslate.ts), and the language it translates into is
 * the chat's (lib/chatLanguage.ts), set by hand or worked out from the others' messages.
 */

/** The languages the detector was sure of, per chat, oldest first (what translateReceived.ts records). */
const seen = vi.hoisted(() => new Map<string, string[]>());
vi.mock("../../lib/translateReceived", () => {
  const none: string[] = [];
  return { chatDetections: (chat: string) => seen.get(chat) ?? none, watchTranslations: () => () => {} };
});
/** The draft detector: one that is sure every draft is Spanish. */
vi.mock("../../lib/translateDetector", () => ({ loadDetector: async () => () => [{ code: "es", probability: 0.99 }] }));

import { useComposerTranslation } from "../../hooks/useComposerTranslation";
import { setChatLanguage } from "../../lib/chatLanguage";
import { groupChat } from "../../lib/chatMute";
import { setChatTranslate } from "../../lib/chatTranslate";
import { renderApp } from "../render";

const settings = (translateMessages: boolean) =>
  localStorage.setItem("ghostly_app_settings", JSON.stringify({ language: "en", translateMessages }));

function Composer({ chat }: { chat: string }) {
  const translation = useComposerTranslation(chat);
  return <output data-testid="composer-translation" data-detect={translation?.detect ? translation.detect("hola")[0]?.code : ""}>
    {JSON.stringify(translation ?? null)}
  </output>;
}
const offered = () => JSON.parse(screen.getByTestId("composer-translation").textContent!);

beforeEach(() => {
  seen.clear();
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  vi.stubEnv("VITE_TRANSLATE", "1");
});
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  vi.unstubAllEnvs();
  localStorage.clear();
});

describe("the composer's Translate follows the chat's choice", () => {
  it("As in Settings: offered only while the Settings switch is on", () => {
    setChatLanguage("s1", "it");
    settings(false);
    const off = renderApp(<Composer chat="s1" />);
    expect(offered()).toBeNull();
    off.unmount();
    settings(true);
    renderApp(<Composer chat="s1" />);
    expect(offered()).toEqual({ language: "it", languages: [] });
  });

  it("the chat's own On wins over the switch off, and its Off over the switch on", () => {
    setChatLanguage("s1", "it");
    settings(false);
    setChatTranslate("s1", "on");
    const on = renderApp(<Composer chat="s1" />);
    expect(offered()).toEqual({ language: "it", languages: [] });
    on.unmount();
    settings(true);
    setChatTranslate("s1", "off");
    renderApp(<Composer chat="s1" />);
    expect(offered()).toBeNull();
  });

  it("goes away at once when the chat is turned Off", () => {
    setChatLanguage("s1", "it");
    settings(true);
    renderApp(<Composer chat="s1" />);
    expect(offered()).toEqual({ language: "it", languages: [] });
    act(() => setChatTranslate("s1", "off"));
    expect(offered()).toBeNull();
  });

  it("is not in a build without translation, nor in the web app", () => {
    setChatLanguage("s1", "it");
    settings(true);
    vi.stubEnv("VITE_TRANSLATE", "");
    const build = renderApp(<Composer chat="s1" />);
    expect(offered()).toBeNull();
    build.unmount();
    vi.stubEnv("VITE_TRANSLATE", "1");
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
    renderApp(<Composer chat="s1" />);
    expect(offered()).toBeNull();
  });
});

describe("the composer translates into the chat's language", () => {
  it("a 1:1 chat's is the last language the contact wrote", () => {
    settings(true);
    seen.set("s1", ["es", "it"]);
    renderApp(<Composer chat="s1" />);
    expect(offered()).toEqual({ language: "it", languages: [] });
  });

  it("one set by hand wins, and Change is seen at once", () => {
    settings(true);
    seen.set("s1", ["es"]);
    renderApp(<Composer chat="s1" />);
    expect(offered()).toEqual({ language: "es", languages: [] });
    act(() => setChatLanguage("s1", "fr"));
    expect(offered()).toEqual({ language: "fr", languages: [] });
  });

  it("a group with no single language gives its languages, most used first", () => {
    settings(true);
    seen.set(groupChat("g1"), ["it", "es", "es", "fr"]);
    renderApp(<Composer chat={groupChat("g1")} />);
    expect(offered()).toEqual({ language: null, languages: ["es", "fr", "it"] });
  });

  it("a chat with no language yet offers nothing", () => {
    settings(true);
    renderApp(<Composer chat="s1" />);
    expect(offered()).toBeNull();
  });
});

describe("the composer's translation reads the draft's language", () => {
  it("with the same detector as received messages, once it has loaded", async () => {
    setChatLanguage("s1", "it");
    settings(true);
    renderApp(<Composer chat="s1" />);
    await waitFor(() => expect(screen.getByTestId("composer-translation")).toHaveAttribute("data-detect", "es"));
  });
});

describe("a build or client without translation", () => {
  it("reads none of a chat's translation keys", () => {
    setChatLanguage("s1", "it");
    setChatTranslate("s1", "on");
    settings(true);
    vi.stubEnv("VITE_TRANSLATE", "");
    const read = vi.spyOn(localStorage, "getItem");
    renderApp(<Composer chat="s1" />);
    expect(offered()).toBeNull();
    expect(read.mock.calls.map(([key]) => key).filter((key) => /translate_/.test(key))).toEqual([]);
    read.mockRestore();
  });
});
