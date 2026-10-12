import { screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { chatFolderMap, chatFolders, createFolder, folderOf, setChatFolder } from "../../lib/chatFolders";
import { groupChat } from "../../lib/chatMute";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chats.folders

const NOW = Date.now();
const key = (c: string) => c.repeat(52);
const chat = (id: string, name: string, over: Partial<ChatSession> = {}): ChatSession =>
  ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: key(id), encKeyB64: "enc", messages: [], createdAt: NOW, nick: name, nickSource: "profile", ...over });
const list = (language?: "pt") => renderApp(<UpdateProvider><Sidebar /></UpdateProvider>, { language });
const folderNames = () => screen.queryAllByTestId("chat-folder-name").map(n => n.textContent);
const folder = (name: string) => screen.getAllByTestId("chat-folder-section").find(s => within(s).getByTestId("chat-folder-name").textContent === name)!;
const names = (root: HTMLElement) => within(root).queryAllByTestId("chat-row-name").map(n => n.textContent);
const options = (name: string) => within(folder(name)).getByTestId("chat-folder-options");
/** The menu's rows, ticked ones (menu checkboxes) included. */
const rowTexts = (menu: HTMLElement) => [...menu.querySelectorAll("[data-menu-item]")].map(b => b.querySelector("[data-menu-text]")?.textContent);

/** Opens /group/group-1 as the app routes it, with the chat list beside it. */
function openGroup(language?: "pt") {
  fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined)
    .update({ groups: [groupView({ status: "active", epoch: 1, members: [{ key: key("m"), role: "member", me: true, online: true, missing: 0 }] })] });
  return renderApp(<UpdateProvider><Sidebar /><Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes></UpdateProvider>, { route: "/group/group-1", language });
}

describe("making a folder", () => {
  it("New ▾ → Folder asks for a name and puts the folder in the list, empty", async () => {
    saveSession(chat("a", "Alice"));
    const { user } = list();
    await user.click(screen.getByTestId("sidebar-new-more"));
    expect(screen.getByTestId("new-folder")).toHaveTextContent("Folder");
    expect(screen.getByTestId("new-folder")).toHaveTextContent("A section of your chat list");
    await user.click(screen.getByTestId("new-folder"));
    const dialog = screen.getByTestId("folder-name-dialog");
    expect(dialog).toHaveAccessibleName("New folder");
    expect(screen.getByTestId("folder-name")).toHaveFocus();
    // No folder without a name.
    expect(screen.getByTestId("folder-name-save")).toBeDisabled();
    await user.type(screen.getByTestId("folder-name"), "  Agents{Enter}");
    expect(screen.queryByTestId("folder-name-dialog")).not.toBeInTheDocument();
    expect(folderNames()).toEqual(["Agents"]);
    expect(within(folder("Agents")).getByTestId("chat-folder-empty")).toBeInTheDocument();
    expect(screen.getByTestId("chat-folder-others")).toBeInTheDocument();
  });

  it("made during a search, it is shown: the search is cleared", async () => {
    saveSession(chat("a", "Alice"));
    const { user } = list();
    await user.type(screen.getByPlaceholderText("Search chats..."), "ali");
    await user.click(screen.getByTestId("sidebar-new-more"));
    await user.click(screen.getByTestId("new-folder"));
    await user.type(screen.getByTestId("folder-name"), "Agents{Enter}");
    expect(screen.getByPlaceholderText("Search chats...")).toHaveValue("");
    expect(folderNames()).toEqual(["Agents"]);
  });

  it("Cancel makes none", async () => {
    const { user } = list();
    await user.click(screen.getByTestId("sidebar-new-more"));
    await user.click(screen.getByTestId("new-folder"));
    await user.type(screen.getByTestId("folder-name"), "Agents");
    await user.click(within(screen.getByTestId("folder-name-dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("folder-name-dialog")).not.toBeInTheDocument();
    expect(chatFolders()).toEqual([]);
  });
});

describe("a folder's ⋮", () => {
  const seed = () => {
    saveSession(chat("a", "Alice"));
    const [agents] = ["Agents", "Personal", "Work"].map(name => createFolder(name)!);
    setChatFolder("a", agents.id);
    return agents;
  };

  it("renames it, with its name ready to be typed over", async () => {
    seed();
    const { user } = list();
    expect(options("Agents")).toHaveAccessibleName("Options for the folder Agents");
    await user.click(options("Agents"));
    await user.click(screen.getByTestId("chat-folder-rename"));
    expect(screen.getByTestId("folder-name-dialog")).toHaveAccessibleName("Rename folder");
    expect(screen.getByTestId("folder-name")).toHaveValue("Agents");
    await user.clear(screen.getByTestId("folder-name"));
    await user.type(screen.getByTestId("folder-name"), "Machines");
    await user.click(screen.getByTestId("folder-name-save"));
    expect(folderNames()).toEqual(["Machines", "Personal", "Work"]);
    expect(names(folder("Machines"))).toEqual(["Alice"]);
  });

  it("moves it up or down among the folders; the first has no way up, the last no way down", async () => {
    seed();
    const { user } = list();
    await user.click(options("Agents"));
    expect(rowTexts(screen.getByTestId("chat-folder-options-menu"))).toEqual(["Rename folder", "Move down", "Delete folder"]);
    await user.click(screen.getByTestId("chat-folder-down"));
    expect(folderNames()).toEqual(["Personal", "Agents", "Work"]);
    // The keys stay where they were: on the moved folder's ⋮.
    expect(options("Agents")).toHaveFocus();
    await user.click(options("Work"));
    expect(rowTexts(screen.getByTestId("chat-folder-options-menu"))).toEqual(["Rename folder", "Move up", "Delete folder"]);
    await user.click(screen.getByTestId("chat-folder-up"));
    expect(chatFolders().map(f => f.name)).toEqual(["Personal", "Work", "Agents"]);
  });

  it("deletes it after asking, and its chats are back in the list, in no folder", async () => {
    seed();
    const { user } = list();
    await user.click(options("Agents"));
    await user.click(screen.getByTestId("chat-folder-delete"));
    const dialog = screen.getByTestId("folder-delete-dialog");
    expect(dialog).toHaveAccessibleName("Delete the folder “Agents”?");
    expect(dialog).toHaveTextContent("Its chats are not deleted. They go back to the list, in no folder.");
    // Cancel first: nothing changes.
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(folderNames()).toEqual(["Agents", "Personal", "Work"]);
    await user.click(options("Agents"));
    await user.click(screen.getByTestId("chat-folder-delete"));
    await user.click(screen.getByTestId("folder-delete-confirm"));
    expect(screen.queryByTestId("folder-delete-dialog")).not.toBeInTheDocument();
    expect(folderNames()).toEqual(["Personal", "Work"]);
    // Its ⋮ went with it: the focus goes to the list's New, not nowhere.
    expect(screen.getByTestId("sidebar-new-chat")).toHaveFocus();
    expect(folderOf("a")).toBeUndefined();
    expect(names(screen.getByTestId("sidebar"))).toEqual(["Alice"]);
  });

  it("forgets a deleted chat's place", async () => {
    seed();
    const { user } = list();
    await user.click(within(folder("Agents")).getByRole("button", { name: "Delete chat" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete chat" }));
    expect(chatFolderMap()).toEqual({});
  });
});

describe("a chat's ⋮ → Move to folder…", () => {
  it("lists the folders and No folder, ticks where the group is, and moves it at once", async () => {
    const agents = createFolder("Agents")!, personal = createFolder("Personal")!;
    const { user } = openGroup();
    await user.click(screen.getByTestId("group-options"));
    expect(screen.getByTestId("chat-folder-open")).toHaveTextContent("Move to folder…");
    await user.click(screen.getByTestId("chat-folder-open"));
    expect(screen.queryByTestId("group-options-menu")).not.toBeInTheDocument();
    const menu = screen.getByTestId("chat-folder-menu");
    expect(menu).toHaveAccessibleName("Move to folder…");
    expect(rowTexts(menu)).toEqual(["Agents", "Personal", "No folder", "New folder…"]);
    expect(within(menu).getByTestId("chat-folder-none")).toHaveAttribute("aria-checked", "true");
    await user.click(within(menu).getAllByTestId("chat-folder-choice")[0]);
    expect(screen.queryByTestId("chat-folder-menu")).not.toBeInTheDocument();
    expect(folderOf(groupChat("group-1"))).toBe(agents.id);
    // The list beside the chat shows it there at once, and ⋮ says where it is.
    expect(names(folder("Agents"))).toEqual(["Friends"]);
    await user.click(screen.getByTestId("group-options"));
    expect(screen.getByTestId("chat-folder-open")).toHaveTextContent("Agents");
    await user.click(screen.getByTestId("chat-folder-open"));
    expect(within(screen.getByTestId("chat-folder-menu")).getAllByTestId("chat-folder-choice").map(r => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    // One folder at a time, then none.
    await user.click(within(screen.getByTestId("chat-folder-menu")).getAllByTestId("chat-folder-choice")[1]);
    expect(folderOf(groupChat("group-1"))).toBe(personal.id);
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("chat-folder-open"));
    await user.click(screen.getByTestId("chat-folder-none"));
    expect(folderOf(groupChat("group-1"))).toBeUndefined();
  });

  it("New folder… makes one and puts the chat in it, with no folder made yet", async () => {
    const { user } = openGroup();
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("chat-folder-open"));
    expect(rowTexts(screen.getByTestId("chat-folder-menu"))).toEqual(["New folder…"]);
    await user.click(screen.getByTestId("chat-folder-new"));
    await user.type(screen.getByTestId("folder-name"), "Agents{Enter}");
    expect(chatFolders().map(f => f.name)).toEqual(["Agents"]);
    expect(folderOf(groupChat("group-1"))).toBe(chatFolders()[0].id);
    expect(names(folder("Agents"))).toEqual(["Friends"]);
  });

  it("speaks the app's language", async () => {
    createFolder("Agentes");
    const { user } = openGroup("pt");
    expect(options("Agentes")).toHaveAccessibleName("Opções da pasta Agentes");
    await user.click(screen.getByTestId("group-options"));
    await user.click(screen.getByTestId("chat-folder-open"));
    expect(rowTexts(screen.getByTestId("chat-folder-menu"))).toEqual(["Agentes", "Sem pasta", "Nova pasta…"]);
  });
});
