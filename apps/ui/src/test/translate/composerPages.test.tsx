import { act, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupMemberView } from "@ghostly/browser/shared/types";

// covers: chat.paired.send, groups.send

/*
 * The composer's translation sent from the chat pages (wiring 3, ghostly-agents#1808): a translation sent through the
 * preview keeps its original on this device, under the id the engine stored the message with, in a 1:1 chat and in a
 * group. And a preview left open when the chat's translation goes away is closed (ghostly-agents#1812).
 */

/** The runtime: writes the words in capitals and says which pair it was asked for. */
const runtime = vi.hoisted(() => ({ translate: vi.fn(async (pair: string, texts: readonly string[]) => texts.map((text) => `${text.toUpperCase()} [${pair}]`)) }));
vi.mock("../../desktop/translate", async (original) => ({ ...(await original<typeof import("../../desktop/translate")>()), translateTexts: runtime.translate }));
/** No draft detector: a draft is taken to be in the app's language (English). */
vi.mock("../../lib/translateDetector", () => ({ loadDetector: async () => null }));
vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

import { MessageInput } from "../../components/MessageInput";
import { Chat } from "../../pages/Chat";
import { GroupChat } from "../../pages/GroupChat";
import { setChatLanguage } from "../../lib/chatLanguage";
import { groupChat } from "../../lib/chatMute";
import { setChatTranslate } from "../../lib/chatTranslate";
import { sentOriginal } from "../../lib/sentOriginals";
import { saveSession, setStorageProfile as setProfile } from "../../lib/storage";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

const PEER = "peer".padEnd(52, "p");
const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: false, missing: 0, ...patch });

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

/** Types `draft`, presses Translate, waits for the preview, then sends it with Enter. */
async function sendTranslated(user: ReturnType<typeof renderApp>["user"], field: HTMLElement, draft: string) {
  await user.click(field);
  await user.type(field, draft);
  await user.click(screen.getByTestId("composer-translate"));
  expect(await screen.findByTestId("translate-text")).toHaveValue(`${draft.toUpperCase()} [en-it]`);
  await user.type(field, "{Enter}");
}

describe("a translation sent from a chat page keeps its original on this device", () => {
  it("in a 1:1 chat, under the id the engine stored it with", async () => {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", messages: [], createdAt: 1_700_000_000_000 });
    setChatLanguage("chat-1", "it");
    setChatTranslate("chat-1", "on");
    const { user, engine } = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
    engine.on("sendMessage", async () => ({ error: null, messageId: "m1" }))
      .update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", dataLink: "open" } as never)] });
    await sendTranslated(user, await screen.findByPlaceholderText("Message…"), "see you tomorrow");
    await waitFor(() => expect(engine.callsTo("sendMessage")).toHaveLength(1));
    await waitFor(() => expect(sentOriginal("chat-1", "m1")).toEqual({ to: "it", original: "see you tomorrow" }));
  });

  it("in a group, under the id the engine stored it with", async () => {
    setChatLanguage(groupChat("group-1"), "it");
    setChatTranslate(groupChat("group-1"), "on");
    fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined)
      .on("sendGroupMessage", async () => ({ error: null, messageId: "g1" }))
      .update({ groups: [groupView({ status: "active", epoch: 1, members: [member({ me: true, online: true }), member({ key: ALICE, nick: "Alice", role: "admin", online: true })] })] });
    const { user, engine } = renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
    await sendTranslated(user, screen.getByRole("textbox"), "see you tomorrow");
    await waitFor(() => expect(engine.callsTo("sendGroupMessage")).toHaveLength(1));
    expect(engine.callsTo("sendGroupMessage")[0]).toMatchObject({ text: "SEE YOU TOMORROW [en-it]" });
    await waitFor(() => expect(sentOriginal(groupChat("group-1"), "g1")).toEqual({ to: "it", original: "see you tomorrow" }));
  });
});

describe("a preview left open when the chat's translation goes away (ghostly-agents#1812)", () => {
  it("closes, and Enter sends the draft as typed", async () => {
    const onSend = vi.fn(async () => null);
    const { user, rerender } = renderApp(<MessageInput onSend={onSend} translation={{ language: "it" }} />);
    const field = screen.getByRole("textbox");
    await user.type(field, "see you tomorrow");
    await user.click(screen.getByTestId("composer-translate"));
    await screen.findByTestId("translate-preview");
    rerender(<MessageInput onSend={onSend} translation={undefined} />);
    await waitFor(() => expect(screen.queryByTestId("translate-preview")).not.toBeInTheDocument());
    await act(async () => { await user.type(field, "!{Enter}"); });
    expect(onSend).toHaveBeenCalledWith("see you tomorrow!");
  });

  it("closes when the chat's language changes", async () => {
    const onSend = vi.fn(async () => null);
    const { user, rerender } = renderApp(<MessageInput onSend={onSend} translation={{ language: "it" }} />);
    await user.type(screen.getByRole("textbox"), "see you tomorrow");
    await user.click(screen.getByTestId("composer-translate"));
    await screen.findByTestId("translate-preview");
    rerender(<MessageInput onSend={onSend} translation={{ language: "fr" }} />);
    await waitFor(() => expect(screen.queryByTestId("translate-preview")).not.toBeInTheDocument());
  });
});
