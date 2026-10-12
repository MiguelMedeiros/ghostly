import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { chatFolders, createFolder, setChatFolder, setFolderFolded } from "../../lib/chatFolders";
import { groupChat, setChatMute } from "../../lib/chatMute";
import { saveSession, setSessionPinned } from "../../lib/storage";
import type { ChatMessage, ChatSession } from "../../lib/types";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chats.folders

const MIN = 60_000;
const NOW = Date.now();
const key = (c: string) => c.repeat(52);
const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({ id: `m-${Math.random()}`, text: "hi", sender: "peer", timestamp: NOW, ...over });
const chat = (id: string, name: string, over: Partial<ChatSession> = {}): ChatSession =>
  ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: key(id), encKeyB64: "enc", messages: [], createdAt: NOW, nick: name, nickSource: "profile", ...over });
const list = (route = "/") => renderApp(<UpdateProvider><Sidebar /></UpdateProvider>, { route });

const folder = (name: string) => screen.getAllByTestId("chat-folder-section").find(s => within(s).getByTestId("chat-folder-name").textContent === name)!;
const toggle = (name: string) => within(folder(name)).getByTestId("chat-folder-toggle");
const badge = (name: string) => within(folder(name)).queryByTestId("chat-folder-unread");
/** The names of the rows in `within`, chats and groups, top to bottom. */
const names = (root: HTMLElement) => within(root).queryAllByTestId("chat-row-name").map(n => n.textContent);
const sidebar = () => screen.getByTestId("sidebar");

/** Alice (2 unread) and Hermes (1 unread) and the group Machines in "Agents", Bob in "Personal", Carol in no folder. */
function seed() {
  saveSession(chat("a", "Alice", { lastSyncAt: NOW, messages: [message(), message()] }));
  saveSession(chat("h", "Hermes", { lastSyncAt: NOW - MIN, messages: [message()] }));
  saveSession(chat("b", "Bob", { lastSyncAt: NOW - 2 * MIN }));
  saveSession(chat("c", "Carol", { lastSyncAt: NOW - 3 * MIN, messages: [message()] }));
  fakeEngine.update({ groups: [groupView({ id: "g", name: "Machines" }), groupView({ id: "l", name: "Loose group" })] });
  const agents = createFolder("Agents")!, personal = createFolder("Personal")!;
  setChatFolder("a", agents.id);
  setChatFolder("h", agents.id);
  setChatFolder(groupChat("g"), agents.id);
  setChatFolder("b", personal.id);
  return { agents, personal };
}

describe("the chat list with folders", () => {
  it("is the list it always was while there is no folder", () => {
    saveSession(chat("a", "Alice", { lastSyncAt: NOW }));
    saveSession(chat("b", "Bob", { lastSyncAt: NOW - MIN }));
    fakeEngine.update({ groups: [groupView({ id: "g", name: "Machines" })] });
    list();
    expect(names(sidebar())).toEqual(["Machines", "Alice", "Bob"]);
    expect(screen.queryByTestId("chat-folder")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-folder-others")).not.toBeInTheDocument();
  });

  it("shows each folder first, in the person's order, with its groups and chats; then the chats in no folder as before", () => {
    seed();
    list();
    expect(screen.getAllByTestId("chat-folder-name").map(n => n.textContent)).toEqual(["Agents", "Personal"]);
    expect(names(folder("Agents"))).toEqual(["Machines", "Alice", "Hermes"]);
    expect(names(folder("Personal"))).toEqual(["Bob"]);
    // Every chat is in the list once: the folders' chats, a heading, then the rest (groups, then chats).
    expect(names(sidebar())).toEqual(["Machines", "Alice", "Hermes", "Bob", "Loose group", "Carol"]);
    expect(screen.getByTestId("chat-folder-others")).toHaveTextContent("Other chats");
    expect(screen.getByTestId("chat-folder-others").compareDocumentPosition(folder("Personal")) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it("keeps a folder's pinned chat first in it", () => {
    seed();
    setSessionPinned("h", true);
    list();
    expect(names(folder("Agents"))).toEqual(["Machines", "Hermes", "Alice"]);
  });

  it("has no heading for the rest when every chat is in a folder", () => {
    const { personal } = seed();
    setChatFolder("c", personal.id);
    setChatFolder(groupChat("l"), personal.id);
    list();
    expect(screen.queryByTestId("chat-folder-others")).not.toBeInTheDocument();
    expect(names(folder("Personal"))).toEqual(["Loose group", "Bob", "Carol"]);
  });

  it("folds a folder to its header from the header's button, unfolds it again, and remembers it", async () => {
    const { agents } = seed();
    const first = list();
    const button = toggle("Agents");
    expect(button).toHaveAccessibleName("Agents");
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(button.getAttribute("aria-controls")!)).toBe(within(folder("Agents")).getByTestId("chat-folder-chats"));
    await first.user.click(button);
    expect(toggle("Agents")).toHaveAttribute("aria-expanded", "false");
    expect(names(folder("Agents"))).toEqual([]);
    expect(names(sidebar())).toEqual(["Bob", "Loose group", "Carol"]);
    expect(chatFolders().find(f => f.id === agents.id)?.folded).toBe(true);
    // Opened again later, the app shows it folded still.
    first.unmount();
    const again = list();
    expect(toggle("Agents")).toHaveAttribute("aria-expanded", "false");
    expect(names(folder("Personal"))).toEqual(["Bob"]);
    // The keyboard unfolds it: the header is a button.
    toggle("Agents").focus();
    await again.user.keyboard("{Enter}");
    expect(names(folder("Agents"))).toEqual(["Machines", "Alice", "Hermes"]);
  });

  it("says in its header how much is unread in its chats, added up, with a group that has something new as one", () => {
    seed();
    list();
    // Alice 2 + Hermes 1; the group has nothing new yet. Bob has nothing unread: no count on his folder.
    expect(badge("Agents")).toHaveTextContent("3");
    expect(badge("Agents")).toHaveAccessibleName("3 unread in Agents");
    // The button is named by the folder alone, and described by its count.
    expect(toggle("Agents")).toHaveAttribute("aria-describedby", badge("Agents")!.id);
    expect(badge("Personal")).not.toBeInTheDocument();
    act(() => fakeEngine.update({ groups: [groupView({ id: "g", name: "Machines", lastMessageAt: NOW, lastPeerMessageAt: NOW })] }));
    expect(badge("Agents")).toHaveTextContent("4");
  });

  it("raises a folded folder's count when a message comes to one of its chats", () => {
    const { personal } = seed();
    setFolderFolded(personal.id, true);
    list();
    expect(badge("Personal")).not.toBeInTheDocument();
    act(() => {
      saveSession(chat("b", "Bob", { lastSyncAt: NOW, messages: [message({ text: "are you there?" })] }));
      window.dispatchEvent(new Event("session-updated"));
    });
    expect(badge("Personal")).toHaveTextContent("1");
    expect(badge("Personal")).toHaveAccessibleName("1 unread in Personal");
    expect(names(folder("Personal"))).toEqual([]);
  });

  it("leaves a muted chat's unread out of the count; a folder with only muted unread shows it in grey", () => {
    seed();
    setChatMute("a", "forever");
    list();
    expect(badge("Agents")).toHaveTextContent("1");
    expect(badge("Agents")).not.toHaveAttribute("data-muted");
    // Muting the other one too leaves only muted unread: all of it, in grey, as a muted chat's own count.
    act(() => setChatMute("h", "forever"));
    expect(badge("Agents")).toHaveTextContent("3");
    expect(badge("Agents")).toHaveAttribute("data-muted", "true");
    act(() => setChatMute("a", undefined));
    expect(badge("Agents")).toHaveTextContent("2");
    expect(badge("Agents")).not.toHaveAttribute("data-muted");
  });

  it("leaves the open chat out of its folder's count, as its row has none", () => {
    seed();
    list("/chat/a");
    expect(badge("Agents")).toHaveTextContent("1");
  });

  it("says so in a folder with no chats", () => {
    createFolder("Empty");
    saveSession(chat("a", "Alice"));
    list();
    expect(within(folder("Empty")).getByTestId("chat-folder-empty")).toHaveTextContent("No chats in this folder yet");
    expect(names(sidebar())).toEqual(["Alice"]);
  });

  it("with folders and no chat at all, shows the folders and not the empty list's ghost", () => {
    createFolder("Empty");
    list();
    expect(within(folder("Empty")).getByTestId("chat-folder-empty")).toBeInTheDocument();
    expect(screen.queryByText("It's quiet here...")).not.toBeInTheDocument();
  });

  it("keeps an invitation to a group in sight, in no folder, even folded away with its folder", () => {
    const { agents } = seed();
    setFolderFolded(agents.id, true);
    fakeEngine.update({ groups: [groupView({ id: "g", name: "Machines", canSend: false, invitation: { linkId: "link-1", contact: "Alice", admin: key("a"), members: 3, accepted: false } })] });
    list();
    expect(names(folder("Agents"))).toEqual([]);
    expect(within(sidebar()).getByTestId("group-accept")).toBeInTheDocument();
    expect(names(sidebar())).toEqual(["Bob", "Machines", "Carol"]);
  });

  it("shows a search's results as one list, without folders, a folded folder's chats included", async () => {
    const { agents } = seed();
    setFolderFolded(agents.id, true);
    const { user } = list();
    await user.type(screen.getByPlaceholderText("Search chats..."), "ali");
    expect(screen.queryByTestId("chat-folder")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-folder-others")).not.toBeInTheDocument();
    expect(names(sidebar())).toEqual(["Alice"]);
  });
});
