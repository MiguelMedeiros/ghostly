import "fake-indexeddb/auto";
import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { Chat } from "../../pages/Chat";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { installFakeMedia, removeFakeMedia } from "../voice/fakeMedia";

// covers: chat.one-chat

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const key = "a".repeat(52);
// pairedSession.ts's words for the stop: the engine's, in English.
const ENGINE = "Saved contact key mismatch. This invite is already paired with another participation key. Check with your contact and use a new invitation if the change was intended.";

beforeEach(() => { installFakeMedia(); });
afterEach(() => { removeFakeMedia(); });

describe("a paired chat stopped by a contact-key mismatch", () => {
  it("says why the files, media and voice cannot go in the app's language, never the engine's English", async () => {
    saveSession({ id: "a", profile: "paired-chat/1", mySeedB64: "seed-a", peerPubKeyB64: key, encKeyB64: "enc", messages: [], createdAt: 1_700_000_000_000, nick: "Ana", nickSource: "profile" } as ChatSession);
    const utils = renderApp(<Chat sessionId="a" visible onCallChange={() => {}} callLayer={null} />, { language: "pt" });
    utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
    utils.engine.update({ links: [linkView({ peerPubKeyZ32: key, profile: "paired-chat/1", peerParticipationKey: "saved",
      pairing: { status: "error", peerKey: "other", keyMismatch: true, error: ENGINE } } as never)] });

    await vi.waitFor(() => expect(screen.getByTestId("voice-record")).toHaveAttribute("aria-disabled", "true"));
    expect(screen.getByTestId("voice-record")).toHaveAttribute("title", "Esta conversa parou: a chave do seu contato mudou.");
    expect(document.body.innerHTML).not.toContain("Saved contact key mismatch");
  });
});
