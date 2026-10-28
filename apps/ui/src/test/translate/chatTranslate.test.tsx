import { screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupView } from "@ghostly/browser/shared/types";
import { groupChat } from "../../lib/chatMute";
import {
  chatTranslateChoice, chatTranslates, setChatTranslate, translatesChat, TRANSLATE_CHOICES,
} from "../../lib/chatTranslate";
import { forgetGroupLocal } from "../../lib/groups";
import { loadSettings, type AppSettings } from "../../lib/settings";
import { deleteSession, saveSession, setStorageProfile } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

const key = (c: string) => c.repeat(52);
const chat = (id: string): ChatSession =>
  ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: key(id), encKeyB64: "enc", messages: [], createdAt: Date.now() });
/** Settings with the switch on or off, as slice 6's `AppSettings.translateMessages` keeps it. */
const settings = (on: boolean) => ({ ...loadSettings(), translateMessages: on }) as AppSettings;

afterEach(() => {
  setStorageProfile("");
  vi.unstubAllEnvs();
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  localStorage.clear();
});

describe("a chat's translation: On, Off or As in Settings", () => {
  it("a chat's own choice wins over the Settings switch, both ways; one that never chose does as Settings says", () => {
    expect(translatesChat("settings", true)).toBe(true);
    expect(translatesChat("settings", false)).toBe(false);
    expect(translatesChat("on", false)).toBe(true);
    expect(translatesChat("on", true)).toBe(true);
    expect(translatesChat("off", true)).toBe(false);
    expect(translatesChat("off", false)).toBe(false);
  });

  it("is As in Settings until chosen, keeps nothing for it, and is one chat's only", () => {
    expect(chatTranslateChoice("a")).toBe("settings");
    setChatTranslate("a", "off");
    expect(localStorage.getItem("ghostly_translate_a")).toBe("off");
    expect(chatTranslates("a", settings(true))).toBe(false);
    expect(chatTranslates("b", settings(true))).toBe(true);
    setChatTranslate("b", "on");
    expect(chatTranslates("b", settings(false))).toBe(true);
    setChatTranslate("a", "settings");
    expect(localStorage.getItem("ghostly_translate_a")).toBeNull();
    expect(chatTranslates("a", settings(true))).toBe(true);
  });

  it("a chat that never chose follows the Settings switch as saved: off for a new profile", () => {
    expect(chatTranslates("a", loadSettings())).toBe(false);
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ translateMessages: true }));
    expect(chatTranslates("a", loadSettings())).toBe(true);
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ translateMessages: "yes" }));
    expect(chatTranslates("a", loadSettings())).toBe(false);
  });

  it("ignores what it cannot read: Settings decides", () => {
    localStorage.setItem("ghostly_translate_a", "always");
    expect(chatTranslateChoice("a")).toBe("settings");
  });

  it("belongs to the profile that set it, and goes with the chat or the group", () => {
    setStorageProfile("abcdefghij");
    setChatTranslate("a", "on");
    setStorageProfile("");
    expect(chatTranslateChoice("a")).toBe("settings");
    saveSession(chat("a"));
    setChatTranslate("a", "on");
    deleteSession("a");
    expect(chatTranslateChoice("a")).toBe("settings");
    setChatTranslate(groupChat("g"), "off");
    forgetGroupLocal("g");
    expect(chatTranslateChoice(groupChat("g"))).toBe("settings");
  });
});

/** Opens /group/group-1 as the app routes it. */
function openGroup(group: GroupView, language?: "pt") {
  fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined).update({ groups: [group] });
  return renderApp(<Routes>
    <Route path="/" element={<p>Chat list</p>} />
    <Route path="/group/:groupId" element={<GroupChat />} />
  </Routes>, { route: "/group/group-1", language });
}
const activeGroup = () => groupView({ status: "active", epoch: 1, members: [{ key: key("m"), role: "member", me: true, online: true, missing: 0 }] });
const rowTexts = (menu: HTMLElement) => within(menu).getAllByRole("menuitemcheckbox").map(b => b.querySelector("[data-menu-text]")?.textContent);

describe("choosing from the chat's menu, in the Desktop app", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_TRANSLATE", "1");
    (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  });

  it("⋮ → Translation… → a choice: kept for the chat, ticked, and named under the row", async () => {
    const { user } = openGroup(activeGroup());
    await user.click(screen.getByTestId("group-options"));
    expect(screen.getByTestId("chat-translate-open")).toHaveTextContent("Translation…As in Settings (Off)");
    await user.click(screen.getByTestId("chat-translate-open"));
    expect(screen.queryByTestId("group-options-menu")).not.toBeInTheDocument();
    const menu = screen.getByTestId("translate-menu");
    expect(menu).toHaveAccessibleName("Translation");
    expect(rowTexts(menu)).toEqual(["As in Settings (Off)", "On", "Off", "Translate what I send"]);
    expect(within(menu).getByTestId("translate-settings")).toHaveAttribute("aria-checked", "true");

    await user.click(within(menu).getByTestId("translate-on"));
    expect(screen.queryByTestId("translate-menu")).not.toBeInTheDocument();
    expect(chatTranslateChoice(groupChat("group-1"))).toBe("on");
    await user.click(screen.getByTestId("group-options"));
    expect(screen.getByTestId("chat-translate-open")).toHaveTextContent("Translation…On");
    await user.click(screen.getByTestId("chat-translate-open"));
    expect(screen.getByTestId("translate-on")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("translate-settings")).toHaveAttribute("aria-checked", "false");

    await user.click(screen.getByTestId("translate-settings"));
    expect(localStorage.getItem("ghostly_translate_group:group-1")).toBeNull();
  });

  it("speaks the app's language", async () => {
    const { user } = openGroup(activeGroup(), "pt");
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("chat-translate-open"));
    expect(rowTexts(screen.getByTestId("translate-menu"))).toEqual(["Como nos Ajustes (Desativada)", "Ativada", "Desativada", "Traduzir o que eu envio"]);
  });

  it("is not in a build without translation", async () => {
    vi.stubEnv("VITE_TRANSLATE", "");
    const { user } = openGroup(activeGroup());
    await user.click(screen.getByTestId("group-options"));
    expect(screen.getByTestId("chat-mute-open")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-translate-open")).not.toBeInTheDocument();
  });

  it("is not in the web app either, where Settings has no switch", async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
    const { user } = openGroup(activeGroup());
    await user.click(screen.getByTestId("group-options"));
    expect(screen.getByTestId("chat-mute-open")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-translate-open")).not.toBeInTheDocument();
  });

  it("offers the three choices in order", () => {
    expect(TRANSLATE_CHOICES).toEqual(["settings", "on", "off"]);
  });
});
