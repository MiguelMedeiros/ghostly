import { Profiler } from "react";
import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { GroupMemberView } from "@ghostly/browser/shared/types";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chats.list.rows, groups.typing

/*
 * A group's view changes all the time in ways the chat list shows nothing of: a member starting or stopping typing, a
 * member coming online or going away, an edge to a member reconnecting. The list is always on screen, beside the open
 * group too: none of these draws it again (as none draws the open group's rows, groupRowsRedraw.test.tsx). What it does
 * show of a group (its member count, a member's name in its reaction line) still comes.
 */

const NOW = Date.now();
const key = (i: number) => `p${i}`.padEnd(52, "a");
const chat = (i: number): ChatSession => ({ id: `chat-${i}`, profile: "paired-chat/1", mySeedB64: `seed-${i}`, peerPubKeyB64: key(i),
  encKeyB64: "enc", nick: `Contact ${i}`, createdAt: NOW, lastSyncAt: NOW - 60_000, messages: [{ id: `m-${i}`, text: `hello ${i}`, sender: "peer", timestamp: NOW - 60_000 }] });
const links = () => Array.from({ length: 30 }, (_, i) => linkView({ id: `link-${i}`, peerPubKeyZ32: key(i), lastSyncAt: NOW - 60_000 }));
const member = (i: number, patch: Partial<GroupMemberView> = {}): GroupMemberView =>
  ({ key: key(100 + i), role: i === 0 ? "admin" : "member", me: i === 0, nick: `Member ${i}`, online: true, missing: 0, ...patch });

interface Change { typing?: boolean; offline?: boolean; edge?: "open" | "connecting"; size?: number; nick?: string; said?: boolean }
/** Five groups of 12, every one a new object as each of the engine's states brings them; the change is on the third. */
const groups = (change: Change = {}) => Array.from({ length: 5 }, (_, g) => {
  const { typing, offline, edge, size = 12, nick, said } = g === 2 ? change : {};
  return groupView({
    id: `g-${g}`, name: `Group ${g}`, status: "active", lastMessageAt: NOW - (said ? 10_000 : 60_000), myKey: key(100),
    lastReaction: { emoji: "👍", snippet: "hi", mine: false, by: key(101), at: NOW - 30_000 },
    ...(typing && { typing: [{ key: key(101) }] }),
    members: Array.from({ length: size }, (_, i) => member(i, {
      ...(i === 1 && nick && { nick }),
      ...(i === 5 && offline && { online: false, missing: 3 }),
      ...(i > 0 && { edge: { linkId: `e-${i}`, state: i === 3 && edge ? edge : "open", lastSeenAt: NOW - 1000, ...(i === 3 && edge === "connecting" && { attempt: 2, retryAt: NOW + 5000 }) } }),
    })),
  });
});

describe("the chat list on a group change it does not show", () => {
  beforeEach(() => {
    for (let i = 0; i < 30; i++) saveSession(chat(i));
    fakeEngine.update({ links: links(), groups: groups(), groupsLoaded: true });
  });

  it.each<[string, Change]>([
    ["a member typing", { typing: true }],
    ["a member going away", { offline: true }],
    ["an edge reconnecting", { edge: "connecting" }],
  ])("is not drawn again for %s", (_, change) => {
    let draws = 0;
    renderApp(<Profiler id="list" onRender={() => { draws++; }}><UpdateProvider><Sidebar /></UpdateProvider></Profiler>);
    expect(screen.getAllByTestId("group-row")).toHaveLength(5);
    draws = 0;
    for (let i = 0; i < 20; i++) {
      act(() => fakeEngine.update({ links: links(), groups: groups(change) }));
      act(() => fakeEngine.update({ links: links(), groups: groups() }));
    }
    expect(draws).toBe(0);
  });

  it("but shows what does change: the member count, a member's name in the reaction line", () => {
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    const row = () => screen.getAllByTestId("group-row")[2];
    expect(row()).toHaveTextContent("Member 1 reacted");
    act(() => fakeEngine.update({ groups: groups({ nick: "Ana", typing: true }) }));
    expect(row()).toHaveTextContent("Ana reacted");
    // Something said after the reaction: the line is the member count again.
    act(() => fakeEngine.update({ groups: groups({ said: true }) }));
    expect(row()).toHaveTextContent("12 members");
    act(() => fakeEngine.update({ groups: groups({ said: true, size: 13 }) }));
    expect(row()).toHaveTextContent("13 members");
  });
});
