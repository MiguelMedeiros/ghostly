import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBackgroundPoller } from "../../hooks/useBackgroundPoller";
import { saveSession } from "../../lib/storage";
import { fakeEngine, linkView } from "../fakeEngine";

// covers: chats.list.rows

/*
 * The chat list marks the chats whose first sync is under way: at a start, every chat until its link's first read ends
 * (each run starts with no sync time). It asked for each such chat's session by its contact's key, and each ask read
 * every key in localStorage again, on every engine state: the start's states cost the chats mid-read times every
 * stored key, about 0.56 ms a chat mid-read at 300 chats in Chromium (169 ms a state with all 300). The chats' keys are
 * read once a state, and not at all while no chat is mid-read.
 */

const CHATS = 120, NOW = Date.now();
const peer = (i: number) => String(i).padStart(52, "p");
const chat = (i: number, patch: { id?: string; lastSyncAt?: number } = {}) => saveSession({
  id: patch.id ?? `c-${i}`, profile: "paired-chat/1", mySeedB64: `seed-${patch.id ?? i}`, peerPubKeyB64: peer(i), encKeyB64: "enc",
  messages: [], createdAt: NOW - i * 60_000, lastSyncAt: patch.lastSyncAt ?? NOW - i * 60_000,
});
/** Every link anew, as each state brings them: the first `reading` mid-first-read, the rest synced or idle. */
const links = (reading: number) => Array.from({ length: CHATS }, (_, i) => linkView({
  id: `link-${i}`, peerPubKeyZ32: peer(i), profile: "paired-chat/1",
  poll: { polling: i < reading || i === CHATS - 1, nextAt: 0, interval: 0 },
  // The last one reads again, synced before: not a first sync.
  lastSyncAt: i === CHATS - 1 ? NOW : 0,
} as never));

function Marks({ open }: { open: string | null }) {
  const { syncingSessions } = useBackgroundPoller(open);
  return <output data-testid="marks">{[...syncingSessions].sort().join(" ")}</output>;
}

afterEach(() => { vi.restoreAllMocks(); });

describe("the chat list's marks of a first sync under way", () => {
  it("are the chats mid-first-read, not the open one, and a contact's newest chat of two", () => {
    for (let i = 0; i < CHATS; i++) chat(i);
    // A second chat with contact 1, newer than c-1: the list shows it first, and it is the one marked.
    chat(1, { id: "c-1-again", lastSyncAt: NOW + 1_000 });
    fakeEngine.update({ links: links(4) });
    render(<Marks open="c-2" />);
    expect(screen.getByTestId("marks").textContent).toBe("c-0 c-1-again c-3");
  });

  it("read the chats' keys once a state, whatever the number of chats mid-read, and none when no chat is", async () => {
    for (let i = 0; i < CHATS; i++) chat(i);
    fakeEngine.update({ links: links(CHATS) });
    render(<Marks open={null} />);
    expect(screen.getByTestId("marks").textContent!.split(" ")).toHaveLength(CHATS - 1);
    const keys = vi.spyOn(localStorage, "key");
    const STATES = 10;
    for (let i = 0; i < STATES; i++) await act(async () => { fakeEngine.update({ links: links(CHATS) }); });
    // A state's snapshot may be read twice (React checks it again before it draws): never once per chat mid-read.
    expect(keys.mock.calls.length / STATES).toBeLessThanOrEqual(2 * localStorage.length);
    keys.mockClear();
    for (let i = 0; i < STATES; i++) await act(async () => { fakeEngine.update({ links: links(0) }); });
    expect(keys).not.toHaveBeenCalled();
    expect(screen.getByTestId("marks").textContent).toBe("");
  });
});
