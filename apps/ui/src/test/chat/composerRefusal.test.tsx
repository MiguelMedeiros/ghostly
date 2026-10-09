import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { saveSession, setStorageProfile as setProfile } from "../../lib/storage";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.paired.send

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const PEER = "peer".padEnd(52, "p");

/**
 * What a 1:1 chat's composer says when the engine refuses a send or an edit (engine/node.ts sendMessage, editMessage):
 * in the app's language, as a group's composer says it. The engine's English showed as it came, in every language.
 */
function openChat(refusal: { send?: string; edit?: string }, messages: never[] = []) {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", messages, createdAt: 1_700_000_000_000 });
  const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />, { language: "pt" });
  utils.engine.on("sendMessage", async () => ({ error: refusal.send ?? null, refused: true }))
    .on("editMessage", async () => ({ error: refusal.edit ?? null, refused: true }))
    .update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", dataLink: "open" } as never)] });
  return utils;
}

afterEach(() => { localStorage.clear(); setProfile(""); });

describe("an engine refusal in a 1:1 chat's composer, in Portuguese", () => {
  it.each([
    ["Message exceeds 16384 UTF-8 bytes.", "Mensagem longa demais. Encurte ou envie como arquivo."],
    ["Someone else joined with this invite first. Ask your contact for a new one.", "Outra pessoa entrou com este convite antes. Peça um novo ao seu contato."],
    ["You are offline", "Você está offline"],
    ["That message is not in this chat, or cannot be replied to", "Não dá para responder a essa mensagem. Cancele a resposta e envie de novo."],
  ])("a send refused with \"%s\" says it in the language", async (raw, said) => {
    const { user } = openChat({ send: raw });
    await user.click(await screen.findByPlaceholderText("Mensagem…"));
    await user.keyboard("olá{Enter}");
    expect(await screen.findByText(said)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(raw);
  });

  it.each([
    ["This message was edited 100 times, the most one takes.", "Esta mensagem não pode ser editada de novo. Uma mensagem aceita no máximo 100 edições."],
    ["Message exceeds 16384 UTF-8 bytes.", "Mensagem longa demais. Encurte ou envie como arquivo."],
  ])("an edit refused with \"%s\" says it in the language", async (raw, said) => {
    const { user, engine } = openChat({ edit: raw }, [{ id: "me_w1", ref: "w1", text: "first", sender: "me", timestamp: 1_700_000_000_500, delivery: "delivered" } as never]);
    const field = await screen.findByPlaceholderText("Mensagem…");
    await screen.findByText("first");
    await user.click(field);
    await user.keyboard("{ArrowUp}");
    await waitFor(() => expect(field).toHaveValue("first"));
    await user.keyboard(" again{Enter}");
    expect(await screen.findByText(said)).toBeInTheDocument();
    expect(engine.callsTo("editMessage")).toHaveLength(1);
    expect(document.body.textContent).not.toContain(raw);
  });
});
