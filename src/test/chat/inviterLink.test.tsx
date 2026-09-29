import "fake-indexeddb/auto";
import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { saveInviteCode, saveSession } from "../../lib/storage";
import { renderApp } from "../render";

// covers: chat.paired.pairing-progress, invite.code

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

describe("a chat made here, opened before the engine has its link", () => {
  it("asks the engine for the link with its invite code, whoever asks first: the engine learns who invited from it", async () => {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: "peer".padEnd(52, "p"), encKeyB64: "a2V5", participationSeedB64: "cGFydA", messages: [], createdAt: Date.now() });
    saveInviteCode("chat-1", "ghostly1-invite");
    const { engine } = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
    engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined);
    await act(async () => {});
    const asked = engine.callsTo("ensureLink") as { inviteCode?: string }[];
    expect(asked.length).toBeGreaterThan(0);
    // Without it the engine would make the link the joiner's, and the inviter's scene would look the invite up.
    expect(asked.map(params => params.inviteCode)).toEqual(asked.map(() => "ghostly1-invite"));
  });
});
