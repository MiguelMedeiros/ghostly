import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatsFound } from "../../hooks/useChatsFound";
import { saveSession } from "../../lib/storage";
import { fakeEngine, linkView } from "../fakeEngine";

// covers: chat.paired.storage

/*
 * The chat list's search where the engine sent each chat's newest page only (the extension's pages): the engine answers
 * which chats it found, and each one's chat was looked for through every stored key, once per chat found. The chats'
 * keys are read once for the answer.
 */

const CHATS = 120, NOW = Date.now();
const peer = (i: number) => String(i).padStart(52, "p");

afterEach(() => { vi.restoreAllMocks(); });

describe("the chat list's search through the engine", () => {
  it("reads the chats' keys once for an answer, whatever the number of chats found, and finds a contact's newest chat of two", async () => {
    for (let i = 0; i < CHATS; i++) {
      saveSession({ id: `c-${i}`, profile: "paired-chat/1", mySeedB64: `seed-${i}`, peerPubKeyB64: peer(i), encKeyB64: "enc", messages: [], createdAt: NOW - i * 60_000, lastSyncAt: NOW - i * 60_000 });
    }
    // A second chat with contact 1, newer than c-1: the chat list shows it first, and it is the one found.
    saveSession({ id: "c-1-again", profile: "paired-chat/1", mySeedB64: "seed-1-again", peerPubKeyB64: peer(1), encKeyB64: "enc", messages: [], createdAt: NOW, lastSyncAt: NOW + 1_000 });
    fakeEngine.update({ links: Array.from({ length: CHATS }, (_, i) => linkView({ id: `link-${i}`, peerPubKeyZ32: peer(i), profile: "paired-chat/1" } as never)) });
    for (let i = 0; i < CHATS; i++) fakeEngine.newestPage(`link-${i}`, []);
    fakeEngine.on("chatsFound", ({ linkIds }) => linkIds);
    const keys = vi.spyOn(localStorage, "key");
    const { result } = renderHook(() => useChatsFound("hello"));
    await waitFor(() => expect(result.current.size).toBe(CHATS));
    expect(result.current.has("c-1-again")).toBe(true);
    expect(result.current.has("c-1")).toBe(false);
    expect(keys.mock.calls.length).toBeLessThanOrEqual(2 * localStorage.length);
  });
});
