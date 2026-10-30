import { screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupMemberView } from "@ghostly/browser/shared/types";

// covers: chat.paired.send, groups.send

/*
 * Translate what I send on the chat pages, with the composer's translation as the pages give it
 * (useComposerTranslation): the draft detector reaches the composer, so a draft whose language it is sure of goes
 * translated at once, from that language, without the preview (ghostly-agents#1813).
 */

/** The runtime: writes the words in capitals and says which pair it was asked for. */
const runtime = vi.hoisted(() => ({ translate: vi.fn(async (pair: string, texts: readonly string[]) => texts.map((text) => `${text.toUpperCase()} [${pair}]`)) }));
vi.mock("../../desktop/translate", async (original) => ({ ...(await original<typeof import("../../desktop/translate")>()), translateTexts: runtime.translate }));
/** The draft detector: one that is sure every draft is Spanish, while the app is in English. */
vi.mock("../../lib/translateDetector", () => ({ loadDetector: async () => () => [{ code: "es", probability: 0.99 }] }));
vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

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

/** Turns the chat's translation and its Translate what I send on, into Italian. */
function translating(chat: string) {
  setChatLanguage(chat, "it");
  setChatTranslate(chat, "on");
  setTranslatesWhatISend(chat, true);
}

/** Types a Spanish draft, sees Send say it goes translated, and presses Enter. */
async function sendTranslated(user: ReturnType<typeof renderApp>["user"], field: HTMLElement) {
  await user.click(field);
  await user.type(field, "hasta mañana");
  await screen.findByRole("button", { name: "Send translated into Italian" });
  await user.type(field, "{Enter}");
}

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  vi.stubEnv("VITE_TRANSLATE", "1");
  localStorage.setItem("ghostly_app_settings", JSON.stringify({ language: "en" }));
});
afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  vi.unstubAllEnvs();
  runtime.translate.mockClear();
  localStorage.clear();
  setProfile("");
});

describe("Translate what I send on a chat page, with the draft detector loaded", () => {
  it("in a 1:1 chat, Enter sends the draft translated from its own language, without the preview", async () => {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", messages: [], createdAt: 1_700_000_000_000 });
    translating("chat-1");
    const { user, engine } = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
    engine.on("sendMessage", async () => ({ error: null, messageId: "m1" }))
      .update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", dataLink: "open" } as never)] });
    await sendTranslated(user, await screen.findByPlaceholderText("Message…"));
    await waitFor(() => expect(engine.callsTo("sendMessage")).toHaveLength(1));
    expect(engine.callsTo("sendMessage")[0]).toMatchObject({ text: "HASTA MAÑANA [es-it]" });
    expect(screen.queryByTestId("translate-preview")).not.toBeInTheDocument();
  });

  it("in a group, the same", async () => {
    translating(groupChat("group-1"));
    fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined)
      .on("sendGroupMessage", async () => ({ error: null, messageId: "g1" }))
      .update({ groups: [groupView({ status: "active", epoch: 1, members: [member({ me: true, online: true }), member({ key: ALICE, nick: "Alice", role: "admin", online: true })] })] });
    const { user, engine } = renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
    await sendTranslated(user, screen.getByRole("textbox"));
    await waitFor(() => expect(engine.callsTo("sendGroupMessage")).toHaveLength(1));
    expect(engine.callsTo("sendGroupMessage")[0]).toMatchObject({ text: "HASTA MAÑANA [es-it]" });
    expect(screen.queryByTestId("translate-preview")).not.toBeInTheDocument();
  });
});
