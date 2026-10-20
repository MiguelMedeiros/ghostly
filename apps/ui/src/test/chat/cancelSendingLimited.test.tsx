import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { loadSession, saveSession, setStorageProfile } from "../../lib/storage";
import { problemText } from "../../lib/problemText";
import { translatorFor } from "../../locales";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, playCue: vi.fn() }));

const PEER = "peer".padEnd(52, "p");
const TEXT = "the door code is 4471";
/** The engine's LIMITED_MODE_ERROR (packages/browser/src/engine/node.ts). */
const LIMITED_MODE_ERROR = "Ghostly could not check which device is active yet. This works once it can.";
afterEach(() => { localStorage.clear(); setStorageProfile(""); });

function waitingChat() {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", createdAt: 1_700_000_000_000,
    messages: [{ id: "me_w1", ref: "w1", text: TEXT, sender: "me", timestamp: 1_700_000_000_500, delivery: "waiting" } as never] });
}

async function cancelSending(language: "en" | "pt", deleteMessage: () => void, limited: boolean) {
  waitingChat();
  const { user, engine } = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />, { language });
  engine.on("deleteMessage", deleteMessage)
    .update({ limited, settings: { online: true }, links: [linkView({ id: "link-1", peerPubKeyZ32: PEER, profile: "paired-chat/1" } as never)] } as never);
  await screen.findByText(TEXT);
  await user.click(screen.getByTestId("message-options"));
  await user.click(screen.getByTestId("message-cancel-sending"));
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  return engine;
}

/**
 * Cancel sending drops a message that waits: it is the engine that would send it, so the bubble goes once the engine
 * took the cancel. In limited mode the engine refuses it (nothing is withdrawn before the device check): the message
 * would still reach the contact, so the bubble stays, with the refusal under it, and the chat does not forget it.
 */
describe("Cancel sending a waiting message", () => {
  for (const language of ["en", "pt"] as const) {
    it(`refused in limited mode, the bubble stays and says why (${language})`, async () => {
      const engine = await cancelSending(language, () => { throw new Error(LIMITED_MODE_ERROR); }, true);
      expect(engine.callsTo("deleteMessage")).toEqual([{ linkId: "link-1", messageId: "me_w1" }]);
      expect(screen.getByText(TEXT)).toBeTruthy();
      const { title } = problemText(new Error(LIMITED_MODE_ERROR), translatorFor(language));
      expect(screen.getByTestId("message-retry-error").textContent).toContain(title);
      expect(loadSession("chat-1")?.deletedIds ?? []).toEqual([]);
    });
  }

  it("taken by the engine, the bubble goes", async () => {
    const engine = await cancelSending("en", () => undefined, false);
    expect(engine.callsTo("deleteMessage")).toEqual([{ linkId: "link-1", messageId: "me_w1" }]);
    expect(screen.queryByText(TEXT)).toBeNull();
    expect(screen.queryByTestId("message-retry-error")).toBeNull();
    expect(loadSession("chat-1")?.deletedIds).toEqual(["me_w1"]);
  });
});
