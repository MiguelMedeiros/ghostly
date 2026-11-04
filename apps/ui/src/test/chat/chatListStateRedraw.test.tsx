import { Profiler } from "react";
import { act, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chats.list.rows

/*
 * The engine sends its whole state anew on every change, up to 20 a second while a file moves. The chat list is always
 * on screen: a state that changes nothing it shows (here, only a transfer's progress) draws none of it. It followed the
 * whole state (its groups, the chats mid-sync, the contacts' faces), and each state drew the list and its 30 rows again.
 */

const NOW = Date.now();
const key = (i: number) => `p${i}`.padEnd(52, "a");
const chat = (i: number): ChatSession => ({ id: `chat-${i}`, profile: "paired-chat/1", mySeedB64: `seed-${i}`, peerPubKeyB64: key(i),
  encKeyB64: "enc", nick: `Contact ${i}`, createdAt: NOW, lastSyncAt: NOW - 60_000, messages: [{ id: `m-${i}`, text: `hello ${i}`, sender: "peer", timestamp: NOW - 60_000 }] });
/** Every link and group as a new object, as each of the engine's states brings them. */
const links = (patch: (i: number) => Partial<Parameters<typeof linkView>[0]> = () => ({})) =>
  Array.from({ length: 30 }, (_, i) => linkView({ id: `link-${i}`, peerPubKeyZ32: key(i), lastSyncAt: NOW - 60_000, ...patch(i) }));
const groups = (name = "Climbing") => [groupView({ id: "g-1", name, status: "active", lastMessageAt: NOW - 60_000 })];

describe("the chat list on an engine state that changes nothing it shows", () => {
  beforeEach(() => {
    for (let i = 0; i < 30; i++) saveSession(chat(i));
    fakeEngine.update({ links: links(), groups: groups(), groupsLoaded: true });
  });

  it("is not drawn again", () => {
    let draws = 0;
    renderApp(<Profiler id="list" onRender={() => { draws++; }}><UpdateProvider><Sidebar /></UpdateProvider></Profiler>);
    expect(screen.getAllByTestId("chat-row")).toHaveLength(30);
    draws = 0;
    for (let i = 0; i < 20; i++) act(() => fakeEngine.update({ links: links(), groups: groups(), transfers: { [`t${i}`]: { bytes: i } } } as never));
    expect(draws).toBe(0);
  });

  it("but shows what does change: a group's name, a chat's first sync", () => {
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    act(() => fakeEngine.update({ groups: groups("Bouldering") }));
    expect(screen.getByTestId("group-row")).toHaveTextContent("Bouldering");
    const row = () => screen.getAllByTestId("chat-row").find((r) => within(r).getByTestId("chat-row-name").textContent === "Contact 3")!;
    expect(row().querySelector(".animate-ghost-boo")).toBeNull();
    act(() => fakeEngine.update({ links: links((i) => (i === 3 ? { lastSyncAt: 0, poll: { polling: true, nextAt: 0, interval: 0 } } : {})) }));
    expect(row().querySelector(".animate-ghost-boo")).not.toBeNull();
    act(() => fakeEngine.update({ links: links() }));
    expect(row().querySelector(".animate-ghost-boo")).toBeNull();
  });
});
