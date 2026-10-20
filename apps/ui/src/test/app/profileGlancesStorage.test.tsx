import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProfileGlances } from "../../hooks/useProfileSwitcher";
import { createProfile, prefixOf, registryKey, settingsKeyFor } from "../../lib/profiles";
import type { ChatSession } from "../../lib/types";

// covers: app.profiles

/**
 * Two windows of one origin, each running its own profile: every key the other window writes reaches this one as a
 * `storage` event. The switcher's glance of the other profile reads that profile's stored chats again only for a
 * key that can change what it shows, not for each key typed in a draft over there.
 */
const chat = (id: string, unread: number): ChatSession => ({
  id, profile: "paired-chat/1", mySeedB64: "seed", peerPubKeyB64: "p".repeat(52), encKeyB64: "enc", createdAt: 1,
  messages: Array.from({ length: unread }, (_, i) => ({ id: `m${i}`, text: "hi", sender: "peer", timestamp: 1 + i })),
});
const writtenElsewhere = (key: string | null) => act(() => { window.dispatchEvent(new StorageEvent("storage", { key, newValue: key && "x" })); });

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe("the other profiles' glances, while another window writes", () => {
  it("read the other profile's chats again for its chats, read marks and lock, not for a draft or this profile's keys", async () => {
    const other = createProfile("Small");
    const prefix = prefixOf(other.id);
    localStorage.setItem(`${prefix}c1`, JSON.stringify(chat("c1", 2)));
    const { result } = renderHook(() => useProfileGlances());
    await waitFor(() => expect(result.current.othersUnread).toBe(2));

    const read = vi.spyOn(localStorage, "getItem");
    const chatsRead = () => read.mock.calls.filter(([key]) => key === `${prefix}c1`).length;
    const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

    for (const key of [`${prefix}draft_c1`, `${prefix}mute_c1`, "ghostly_draft_a1", "ghostly_read_a1", "ghostly_a1", settingsKeyFor("")]) writtenElsewhere(key);
    await settle();
    expect(chatsRead(), "a draft, a mute, the running profile's own chat, read mark and settings").toBe(0);

    for (const [key, unread] of [[`${prefix}c1`, 3], [`${prefix}read_c1`, 2], [settingsKeyFor(other.id), 2], [registryKey(), 2], [null, 2]] as const) {
      if (key === `${prefix}c1`) localStorage.setItem(key, JSON.stringify(chat("c1", 3)));
      if (key === `${prefix}read_c1`) localStorage.setItem(key, "1");
      read.mockClear();
      writtenElsewhere(key);
      await waitFor(() => expect(chatsRead(), `a write of ${key}`).toBeGreaterThan(0));
      await waitFor(() => expect(result.current.othersUnread).toBe(unread));
    }
  });
});
