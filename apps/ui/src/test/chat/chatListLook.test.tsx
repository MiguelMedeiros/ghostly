import { Profiler } from "react";
import { act, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupView } from "@ghostly/browser/shared/types";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { createFolder, setChatFolder } from "../../lib/chatFolders";
import { setChatMute } from "../../lib/chatMute";
import { getPrefix, saveSession, setSessionPinned } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chats.list.rows

/*
 * The chat list looks at the stored chats every 3 s. With nothing to show it stays as it is drawn (at 150 chats each draw
 * was 27 ms of script); what only that look brings still shows: a row's time, and what another page of the app wrote.
 */

const LOOK_MS = 3_000;
const NOW = new Date("2026-10-31T12:00:00Z").getTime();

const chat = (id: string, patch: Partial<ChatSession> = {}): ChatSession => ({
  id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: id.repeat(52), encKeyB64: "enc", createdAt: NOW, nick: `Contact ${id}`, messages: [], ...patch,
});
const incoming = (n: number): ChatSession["messages"] =>
  Array.from({ length: n }, (_, i) => ({ id: `m${i}`, sender: "peer", text: `hello ${i}`, timestamp: NOW - 1_000 + i })) as ChatSession["messages"];

let draws = 0;
function list(groups: GroupView[] = []) {
  fakeEngine.update({ groups, groupsLoaded: true });
  draws = 0;
  return renderApp(<UpdateProvider><Profiler id="list" onRender={() => { draws++; }}><Sidebar /></Profiler></UpdateProvider>);
}
const row = (id: string) => screen.getAllByTestId("chat-row").find(r => r.dataset.chat === id)!;
/** Time going by, one look after another: each its own commit, as in a page (one `act` would batch them into one). */
const after = (ms: number) => {
  for (let left = ms; left > 0; left -= LOOK_MS) act(() => { vi.advanceTimersByTime(Math.min(left, LOOK_MS)); });
};
/** Past whatever the list's first moments draw (the engine's first answers): from here only the looks are left. */
const settled = () => { after(LOOK_MS); draws = 0; };

describe("the chat list's look every 3 s", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("draws nothing while nothing it shows changed", () => {
    saveSession(chat("a", { messages: incoming(2) }));
    saveSession(chat("b"));
    list([groupView({ id: "g-a", name: "Book club", status: "active" })]);
    settled();
    // Under a minute: what the rows' times say does not change.
    after(LOOK_MS * 10);
    expect(draws).toBe(0);
  });

  it("moves a row's time on", () => {
    saveSession(chat("a"));
    list();
    expect(within(row("a")).getByTestId("chat-row-time")).toHaveTextContent("now");
    after(60_000 + LOOK_MS);
    expect(within(row("a")).getByTestId("chat-row-time")).toHaveTextContent("1m");
  });

  it("moves a group's time on", () => {
    list([groupView({ id: "g-a", name: "Book club", status: "active", lastMessageAt: NOW })]);
    const time = () => within(screen.getAllByTestId("group-row").find(r => r.dataset.group === "g-a")!).getByTestId("chat-row-time");
    expect(time()).toHaveTextContent("now");
    after(60_000 + LOOK_MS);
    expect(time()).toHaveTextContent("1m");
  });

  it("shows a chat read on another page of the app, which tells this one of its chats only", () => {
    saveSession(chat("a", { messages: incoming(2) }));
    list();
    expect(within(row("a")).getByTestId("chat-row-unread")).toHaveTextContent("2");
    localStorage.setItem(`${getPrefix()}read_a`, "2");
    after(LOOK_MS);
    expect(within(row("a")).queryByTestId("chat-row-unread")).not.toBeInTheDocument();
  });

  it("shows a group read on another page of the app", () => {
    list([groupView({ id: "g-a", name: "Book club", status: "active", lastMessageAt: NOW - 1_000 })]);
    const group = () => screen.getAllByTestId("group-row").find(r => r.dataset.group === "g-a")!;
    const before = group().innerHTML;
    localStorage.setItem(`${getPrefix()}group_read_g-a`, String(NOW));
    after(LOOK_MS);
    expect(group().innerHTML).not.toBe(before);
  });

  it("shows a chat pinned on another page of the app when that leaves the list's order as it is", () => {
    saveSession(chat("a"));
    list();
    expect(within(row("a")).queryByTestId("chat-row-pinned")).not.toBeInTheDocument();
    localStorage.setItem(`${getPrefix()}pin_a`, "1");
    after(LOOK_MS);
    expect(within(row("a")).getByTestId("chat-row-pinned")).toBeInTheDocument();
  });

  it("shows a pin at once, not at the next look: a pin changes no chat", () => {
    saveSession(chat("a"));
    list();
    settled();
    act(() => setSessionPinned("a", true));
    expect(within(row("a")).getByTestId("chat-row-pinned")).toBeInTheDocument();
  });

  it("shows a folder's count in colour once a mute in it ends", () => {
    saveSession(chat("a", { messages: incoming(2) }));
    setChatFolder("a", createFolder("Friends")!.id);
    setChatMute("a", NOW + 10_000);
    list();
    expect(screen.getByTestId("chat-folder-unread")).toHaveAttribute("data-muted");
    after(10_000 + LOOK_MS);
    expect(screen.getByTestId("chat-folder-unread")).not.toHaveAttribute("data-muted");
  });

  it("shows a chat made on another page of the app", () => {
    saveSession(chat("a"));
    list();
    settled();
    saveSession(chat("b"));
    after(LOOK_MS);
    expect(row("b")).toBeInTheDocument();
  });
});
