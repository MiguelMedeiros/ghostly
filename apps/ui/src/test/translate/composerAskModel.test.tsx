import { screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupMemberView } from "@ghostly/browser/shared/types";

// covers: chat.paired.send, groups.send

/*
 * The model the composer's Translate needs, asked for from the chat pages: nothing else downloads the chat's way back
 * (`en-<chat>`), so the first Translate into a chat's language asks for it with the download question, and Download
 * translates. Not now leaves the draft as typed, also when Translate what I send has Enter translate.
 */

const MB = 1024 * 1024;
/** Desktop as Rust answers: the pinned pairs, which are on disk, and a translation through English needs both legs. */
const desktop = vi.hoisted(() => ({ downloaded: new Set<string>(), downloads: [] as string[] }));
vi.mock("../../desktop/translate", async (original) => {
  const real = await original<typeof import("../../desktop/translate")>();
  const pinned = ["pt-en", "en-pt", "it-en", "en-it"];
  return {
    ...real,
    translationStatus: vi.fn(async () => ({ runtime: true, runtimeBytes: 80 * MB, pairs: pinned.map((pair) => ({ pair, bytes: 37 * MB, downloaded: desktop.downloaded.has(pair) })) })),
    downloadTranslation: vi.fn(async (pair: string) => { desktop.downloads.push(pair); desktop.downloaded.add(pair); }),
    translateTexts: vi.fn(async (pair: string, texts: readonly string[]) => {
      const [from, to] = pair.split("-");
      const needs = from === "en" || to === "en" ? [pair] : [`${from}-en`, `en-${to}`];
      if (!needs.every((each) => desktop.downloaded.has(each))) throw new real.TranslateError("no-model", "Translation model not downloaded");
      return texts.map((text) => `${text.toUpperCase()} [${pair}]`);
    }),
  };
});
/** The draft detector: sure of Portuguese for "até", else of English. */
vi.mock("../../lib/translateDetector", () => ({
  loadDetector: async () => (text: string) => [{ code: /até/.test(text) ? "pt" : "en", probability: 0.99 }],
}));
vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

import { translateTexts } from "../../desktop/translate";
import { Chat } from "../../pages/Chat";
import { GroupChat } from "../../pages/GroupChat";
import { setChatLanguage } from "../../lib/chatLanguage";
import { groupChat } from "../../lib/chatMute";
import { setChatTranslate } from "../../lib/chatTranslate";
import { setTranslatesWhatISend } from "../../lib/chatTranslateSend";
import { saveSession, setStorageProfile as setProfile } from "../../lib/storage";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

const PEER = "peer".padEnd(52, "p");
const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: false, missing: 0, ...patch });

/** A 1:1 chat in Italian with its translation on, open. */
async function italianChat() {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", messages: [], createdAt: 1_700_000_000_000 });
  setChatLanguage("chat-1", "it");
  setChatTranslate("chat-1", "on");
  const view = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
  view.engine.on("sendMessage", async () => ({ error: null, messageId: "m1" }))
    .update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", dataLink: "open" } as never)] });
  return { ...view, field: await screen.findByPlaceholderText("Message…") };
}

const app = (language: "en" | "pt") => localStorage.setItem("ghostly_app_settings", JSON.stringify({ language }));

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  vi.stubEnv("VITE_TRANSLATE", "1");
  app("en");
  desktop.downloaded.clear();
  desktop.downloads.length = 0;
});
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  vi.unstubAllEnvs();
  vi.mocked(translateTexts).mockClear();
  localStorage.clear();
  setProfile("");
});

describe("the composer's Translate asks for the model it needs", () => {
  it("in an English app and an Italian chat: English to Italian; Download translates", async () => {
    const { user, field } = await italianChat();
    await user.type(field, "see you tomorrow");
    await user.click(screen.getByTestId("composer-translate"));
    expect(await screen.findByTestId("translate-download-pair")).toHaveTextContent("English to Italian, 37 MB");
    await user.click(screen.getByTestId("translate-download-yes"));
    expect(await screen.findByTestId("translate-text")).toHaveValue("SEE YOU TOMORROW [en-it]");
    expect(desktop.downloads).toEqual(["en-it"]);
    expect(screen.queryByTestId("translate-download")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("Not now leaves the draft as typed, with nothing downloaded and nothing said", async () => {
    const { user, field } = await italianChat();
    await user.type(field, "see you tomorrow");
    await user.click(screen.getByTestId("composer-translate"));
    await user.click(await screen.findByTestId("translate-download-not-now"));
    await waitFor(() => expect(screen.queryByTestId("translate-download")).not.toBeInTheDocument());
    expect(screen.queryByTestId("translate-preview")).not.toBeInTheDocument();
    expect(field).toHaveValue("see you tomorrow");
    expect(desktop.downloads).toEqual([]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("in a Portuguese app, through English: only the leg not here downloads", async () => {
    app("pt");
    desktop.downloaded.add("pt-en").add("en-pt");
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", messages: [], createdAt: 1_700_000_000_000 });
    setChatLanguage("chat-1", "it");
    setChatTranslate("chat-1", "on");
    const view = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
    view.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", dataLink: "open" } as never)] });
    const field = await screen.findByPlaceholderText("Mensagem…");
    await view.user.type(field, "até amanhã");
    await view.user.click(screen.getByTestId("composer-translate"));
    expect(await screen.findByTestId("translate-download-pair")).toHaveTextContent("Português para italiano, 37 MB");
    await view.user.click(screen.getByTestId("translate-download-yes"));
    expect(await screen.findByTestId("translate-text")).toHaveValue("ATÉ AMANHÃ [pt-it]");
    expect(desktop.downloaded.has("en-it")).toBe(true);
  });

  it("in a group, the same question", async () => {
    setChatLanguage(groupChat("group-1"), "it");
    setChatTranslate(groupChat("group-1"), "on");
    fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined)
      .update({ groups: [groupView({ status: "active", epoch: 1, members: [member({ me: true, online: true }), member({ key: ALICE, nick: "Alice", role: "admin", online: true })] })] });
    const { user } = renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
    const field = screen.getByRole("textbox");
    await user.type(field, "see you tomorrow");
    await user.click(screen.getByTestId("composer-translate"));
    expect(await screen.findByTestId("translate-download-pair")).toHaveTextContent("English to Italian, 37 MB");
    await user.click(screen.getByTestId("translate-download-yes"));
    expect(await screen.findByTestId("translate-text")).toHaveValue("SEE YOU TOMORROW [en-it]");
  });

  it("Translate what I send: Enter asks too, and Not now sends nothing and leaves the draft as typed", async () => {
    setTranslatesWhatISend("chat-1", true);
    const { user, field, engine } = await italianChat();
    await user.type(field, "see you tomorrow");
    await screen.findByRole("button", { name: "Send translated into Italian" });
    await user.type(field, "{Enter}");
    expect(await screen.findByTestId("translate-download-pair")).toHaveTextContent("English to Italian, 37 MB");
    await user.click(screen.getByTestId("translate-download-not-now"));
    await waitFor(() => expect(screen.queryByTestId("translate-download")).not.toBeInTheDocument());
    expect(field).toHaveValue("see you tomorrow");
    expect(engine.callsTo("sendMessage")).toHaveLength(0);
    expect(translateTexts).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("Translate what I send: after Download, Enter's translation goes", async () => {
    setTranslatesWhatISend("chat-1", true);
    const { user, field, engine } = await italianChat();
    await user.type(field, "see you tomorrow");
    await screen.findByRole("button", { name: "Send translated into Italian" });
    await user.type(field, "{Enter}");
    await user.click(await screen.findByTestId("translate-download-yes"));
    await waitFor(() => expect(engine.callsTo("sendMessage")).toHaveLength(1));
    expect(engine.callsTo("sendMessage")[0]).toMatchObject({ text: "SEE YOU TOMORROW [en-it]" });
  });
});
