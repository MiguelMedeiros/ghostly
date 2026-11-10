import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import { getPrefix, setStorageProfile } from "../../lib/storage";
import type { ChatMessage } from "../../lib/types";
import { isVoicePlayed, markVoicePlayed } from "../../lib/voicePlayback";
import { renderApp } from "../render";

// covers: files.voice.play

/**
 * Which received voice messages were played is a list of up to 2,000 file ids in the profile's storage. Every received
 * bubble asks on mount: the list is read once, not parsed again per bubble, and still follows another page's writes.
 */
const peaks = Array.from({ length: 64 }, (_, i) => (i * 13) % 256);
const key = () => `${getPrefix()}voice_played`;
const stored = () => JSON.parse(localStorage.getItem(key()) ?? "[]") as string[];
const seed = (ids: string[]) => localStorage.setItem(key(), JSON.stringify(ids));
const old = (count: number) => Array.from({ length: count }, (_, i) => `link-9-in-old${i}`);

function voice(i: number): ChatMessage {
  return {
    id: `peer_c${i}`, text: "🎤 Voice message (0:03)", sender: "peer", timestamp: 1_700_000_200_000 + i,
    file: { id: `link-1-in-cache${i}`, name: "Voice message.webm", size: 900, mime: "audio/webm", voice: { duration: 3_000, peaks } },
  };
}

/** Another page of the app wrote the list (the browser tells this one with a `storage` event). */
function otherPageWrites(ids: string[] | null) {
  const before = localStorage.getItem(key());
  if (ids) seed(ids); else localStorage.clear();
  act(() => { window.dispatchEvent(new StorageEvent("storage", { key: ids ? key() : null, oldValue: before, newValue: ids ? JSON.stringify(ids) : null })); });
}

afterEach(() => vi.restoreAllMocks());

describe("which received voice messages were played", () => {
  it("reads the stored list once for 100 bubbles, not once per bubble", () => {
    const messages = Array.from({ length: 100 }, (_, i) => voice(i));
    // A full list: 1,950 old ones, then the first 50 on screen.
    seed([...old(1_950), ...messages.slice(0, 50).map((m) => m.file!.id)]);
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    renderApp(<div>{messages.map((m) => <MessageBubble key={m.id} message={m} peerPubKey="peer" />)}</div>);

    expect(getItem.mock.calls.filter(([name]) => name === key()).length).toBeLessThanOrEqual(1);
    const bubbles = screen.getAllByTestId("voice-bubble");
    expect(bubbles).toHaveLength(100);
    expect(bubbles.filter((b) => b.getAttribute("data-played") === "true")).toHaveLength(50);
    expect(bubbles.slice(0, 50).every((b) => b.getAttribute("data-played") === "true")).toBe(true);
  });

  it("is played once marked, here and in the stored list", () => {
    seed(old(3));
    expect(isVoicePlayed("link-1-in-new")).toBe(false);
    markVoicePlayed("link-1-in-new");
    expect(isVoicePlayed("link-1-in-new")).toBe(true);
    expect(stored()).toEqual([...old(3), "link-1-in-new"]);
    // Marked twice, kept once.
    markVoicePlayed("link-1-in-new");
    expect(stored()).toEqual([...old(3), "link-1-in-new"]);
  });

  it("follows what another page of the app writes, and its clear", () => {
    seed(old(2));
    expect(isVoicePlayed("link-1-in-there")).toBe(false);
    otherPageWrites([...old(2), "link-1-in-there"]);
    expect(isVoicePlayed("link-1-in-there")).toBe(true);
    // This page's next mark keeps the other page's.
    markVoicePlayed("link-1-in-here");
    expect(stored()).toEqual([...old(2), "link-1-in-there", "link-1-in-here"]);

    otherPageWrites(null);
    expect(isVoicePlayed("link-1-in-there")).toBe(false);
    expect(isVoicePlayed("link-1-in-here")).toBe(false);
  });

  it("keeps the newest 2,000, forgetting the oldest", () => {
    seed(old(2_000));
    markVoicePlayed("link-1-in-newest");
    const list = stored();
    expect(list).toHaveLength(2_000);
    expect(list[0]).toBe("link-9-in-old1");
    expect(list[list.length - 1]).toBe("link-1-in-newest");
    expect(isVoicePlayed("link-9-in-old0")).toBe(false);
    expect(isVoicePlayed("link-9-in-old1")).toBe(true);
    expect(isVoicePlayed("link-1-in-newest")).toBe(true);
  });

  it("is each profile's own", () => {
    markVoicePlayed("link-1-in-first");
    try {
      setStorageProfile("work12345a");
      expect(isVoicePlayed("link-1-in-first")).toBe(false);
      markVoicePlayed("link-1-in-work");
      expect(stored()).toEqual(["link-1-in-work"]);
    } finally { setStorageProfile(""); }
    expect(isVoicePlayed("link-1-in-first")).toBe(true);
    expect(isVoicePlayed("link-1-in-work")).toBe(false);
    expect(stored()).toEqual(["link-1-in-first"]);
  });
});
