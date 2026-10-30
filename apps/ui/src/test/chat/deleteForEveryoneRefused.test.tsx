import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GroupMemberView, StoredMessage } from "@ghostly/browser/shared/types";
import { Chat } from "../../pages/Chat";
import { GroupChat } from "../../pages/GroupChat";
import { saveSession, setStorageProfile as setProfile } from "../../lib/storage";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.paired.delete-message, groups.edit, devices.turn.limited

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

/**
 * Delete for everyone refused by the engine (limited mode: engine/node.ts LIMITED_MODE_METHODS has no removeMessage):
 * the message stays, and why is said under it in the app's language, as a refused Send again is. It did nothing and
 * said nothing, and a second press did the same.
 */
const LIMITED = "Ghostly could not check which device is active yet. This works once it can.";
const SAID = {
  en: { title: "Can't check which device is active", next: "This works once the check does. Check your connection." },
  pt: { title: "Não foi possível verificar qual dispositivo está ativo", next: "Isso volta a funcionar quando a verificação der certo. Confira sua conexão." },
};

const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y");
const MINE = `${ME}:1:0`;
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const mine: StoredMessage = { linkId: "group:group-1", id: MINE, text: "wrong group", sender: "me", timestamp: 1_700_000_000_000, via: "datalink" };

function openGroup(language: "en" | "pt") {
  fakeEngine.on("groupMessages", () => [mine]).on("updateSettings", () => undefined);
  fakeEngine.update({ limited: true, groups: [groupView({ status: "active", epoch: 1, members: [member({ key: ME, me: true }), member({ key: ALICE, nick: "Alice" })] })] } as never);
  return renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1", language });
}

const PEER = "peer".padEnd(52, "p");

function openChat(language: "en" | "pt") {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", createdAt: 1_700_000_000_000,
    messages: [{ id: "me_w1", ref: "w1", text: "wrong chat", sender: "me", timestamp: 1_700_000_000_500, delivery: "delivered" } as never] });
  const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />, { language });
  utils.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", dataLink: "open" } as never)] });
  return utils;
}

async function deleteForEveryone(user: ReturnType<typeof renderApp>["user"], bubble: HTMLElement) {
  await user.click(within(bubble).getByTestId("message-options"));
  await user.click(screen.getByTestId("message-delete-everyone"));
  await user.click(screen.getByTestId("message-delete-confirm"));
}

afterEach(() => { localStorage.clear(); setProfile(""); });

describe("Delete for everyone refused in limited mode", () => {
  it.each(["en", "pt"] as const)("in a group, the message stays and the refusal is said under it (%s)", async (language) => {
    const { user, engine } = openGroup(language);
    engine.on("removeMessage", () => { throw new Error(LIMITED); });
    const text = await screen.findByText("wrong group");
    const bubble = text.closest<HTMLElement>(`[data-message-id="${MINE}"]`)!;
    await deleteForEveryone(user, bubble);
    expect(await within(bubble).findByTestId("message-retry-error-title")).toHaveTextContent(SAID[language].title);
    expect(within(bubble).getByTestId("message-retry-error-next")).toHaveTextContent(SAID[language].next);
    expect(engine.callsTo("removeMessage")).toEqual([{ linkId: "group:group-1", messageId: MINE }]);
    expect(screen.getByText("wrong group")).toBeInTheDocument();
  });

  it("in a group, a refused result is said the same way, and a delete it takes says nothing", async () => {
    const { user, engine } = openGroup("en");
    engine.on("removeMessage", () => ({ error: LIMITED, refused: true }));
    const bubble = (await screen.findByText("wrong group")).closest<HTMLElement>(`[data-message-id="${MINE}"]`)!;
    await deleteForEveryone(user, bubble);
    expect(await within(bubble).findByTestId("message-retry-error-title")).toHaveTextContent(SAID.en.title);
    // Pressed again once limited mode is over: the line goes with the refusal it said.
    engine.on("removeMessage", () => ({ error: null }));
    await deleteForEveryone(user, bubble);
    await waitFor(() => expect(engine.callsTo("removeMessage")).toHaveLength(2));
    await waitFor(() => expect(within(bubble).queryByTestId("message-retry-error")).not.toBeInTheDocument());
  });

  it.each(["en", "pt"] as const)("in a 1:1 chat, the message stays and the refusal is said under it (%s)", async (language) => {
    const { user, engine } = openChat(language);
    engine.on("removeMessage", () => { throw new Error(LIMITED); });
    const bubble = (await screen.findByText("wrong chat")).closest<HTMLElement>("[data-message-id]")!;
    await deleteForEveryone(user, bubble);
    expect(await screen.findByTestId("message-retry-error-title")).toHaveTextContent(SAID[language].title);
    expect(screen.getByTestId("message-retry-error-next")).toHaveTextContent(SAID[language].next);
    expect(engine.callsTo("removeMessage")).toHaveLength(1);
    expect(screen.getByText("wrong chat")).toBeInTheDocument();
  });

  it("in a 1:1 chat, a refused result is said the same way", async () => {
    const { user, engine } = openChat("en");
    engine.on("removeMessage", () => ({ error: LIMITED, refused: true }));
    const bubble = (await screen.findByText("wrong chat")).closest<HTMLElement>("[data-message-id]")!;
    await deleteForEveryone(user, bubble);
    expect(await screen.findByTestId("message-retry-error-title")).toHaveTextContent(SAID.en.title);
    expect(screen.getByText("wrong chat")).toBeInTheDocument();
  });
});
