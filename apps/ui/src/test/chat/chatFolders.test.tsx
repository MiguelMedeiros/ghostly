import "fake-indexeddb/auto";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  FOLDER_NAME_MAX, chatFolderMap, chatFolders, createFolder, deleteFolder, folderOf, moveFolder, renameFolder, setChatFolder, setFolderFolded,
  useChatFolders,
} from "../../lib/chatFolders";
import { groupChat } from "../../lib/chatMute";
import { createProfile, namespaceOf } from "../../lib/profiles";
import { createProfileBackup, restoreProfileBackup } from "../../lib/profileBackup";
import { setStorageProfile } from "../../lib/storage";

// covers: chats.folders

afterEach(() => setStorageProfile(""));

const names = () => chatFolders().map(f => f.name);
/** What a restart has to go on is what storage kept: everything is read again from it. */
const restart = () => {
  const stored = { ...localStorage };
  localStorage.clear();
  for (const [k, v] of Object.entries(stored)) localStorage.setItem(k, v as string);
};

describe("chat folders: kept per profile, on this device", () => {
  it("keeps the folders in the order they were made, each with the name as typed, tidied", () => {
    expect(chatFolders()).toEqual([]);
    const agents = createFolder("  Agents ");
    createFolder("Personal\n  life");
    expect(agents?.name).toBe("Agents");
    restart();
    expect(names()).toEqual(["Agents", "Personal life"]);
    expect(new Set(chatFolders().map(f => f.id)).size).toBe(2);
  });

  it("makes no folder without a name, and cuts a long one", () => {
    expect(createFolder("   ")).toBeUndefined();
    expect(chatFolders()).toEqual([]);
    expect(createFolder("x".repeat(FOLDER_NAME_MAX + 20))?.name).toHaveLength(FOLDER_NAME_MAX);
  });

  it("renames a folder; an empty name leaves it as it was", () => {
    const folder = createFolder("Agents")!;
    renameFolder(folder.id, " Machines ");
    expect(names()).toEqual(["Machines"]);
    renameFolder(folder.id, "  ");
    expect(names()).toEqual(["Machines"]);
  });

  it("puts a chat or a group in one folder at a time, or back in none", () => {
    const agents = createFolder("Agents")!, personal = createFolder("Personal")!;
    setChatFolder("a", agents.id);
    setChatFolder(groupChat("g"), agents.id);
    expect(folderOf("a")).toBe(agents.id);
    expect(folderOf(groupChat("g"))).toBe(agents.id);
    expect(folderOf("b")).toBeUndefined();
    setChatFolder("a", personal.id);
    restart();
    expect(chatFolderMap()).toEqual({ a: personal.id, [groupChat("g")]: agents.id });
    setChatFolder("a", undefined);
    expect(folderOf("a")).toBeUndefined();
    // A folder that does not exist takes no chat.
    setChatFolder("b", "gone");
    expect(folderOf("b")).toBeUndefined();
  });

  it("deleting a folder puts its chats back in none, and leaves the other folders' alone", () => {
    const agents = createFolder("Agents")!, personal = createFolder("Personal")!;
    setChatFolder("a", agents.id);
    setChatFolder("b", personal.id);
    deleteFolder(agents.id);
    expect(names()).toEqual(["Personal"]);
    expect(folderOf("a")).toBeUndefined();
    expect(folderOf("b")).toBe(personal.id);
    deleteFolder(personal.id);
    // Nothing is left behind once the last folder is gone.
    expect(localStorage.getItem("ghostly_chat_folders")).toBeNull();
  });

  it("moves a folder one place up or down, and not past either end", () => {
    const [a, , c] = ["A", "B", "C"].map(name => createFolder(name)!);
    moveFolder(c.id, -1);
    expect(names()).toEqual(["A", "C", "B"]);
    moveFolder(a.id, 1);
    expect(names()).toEqual(["C", "A", "B"]);
    moveFolder(c.id, -1);
    moveFolder("gone", 1);
    restart();
    expect(names()).toEqual(["C", "A", "B"]);
  });

  it("remembers which folders are folded", () => {
    const agents = createFolder("Agents")!, personal = createFolder("Personal")!;
    setFolderFolded(agents.id, true);
    restart();
    expect(chatFolders()).toEqual([{ id: agents.id, name: "Agents", folded: true }, { id: personal.id, name: "Personal" }]);
    setFolderFolded(agents.id, false);
    expect(chatFolders()[0]).toEqual({ id: agents.id, name: "Agents" });
  });

  it("belongs to the profile that made it", () => {
    setStorageProfile("abcdefghij");
    const work = createFolder("Work")!;
    setChatFolder("a", work.id);
    setStorageProfile("");
    expect(chatFolders()).toEqual([]);
    expect(folderOf("a")).toBeUndefined();
    setStorageProfile("abcdefghij");
    expect(names()).toEqual(["Work"]);
  });

  it("reads what it can of a damaged store, and nothing of an unreadable one", () => {
    localStorage.setItem("ghostly_chat_folders", JSON.stringify({ folders: [{ id: "f1", name: "Agents" }, { name: "No id" }, { id: "f1", name: "Twice" }, null], chats: { a: "f1", b: "gone" } }));
    expect(chatFolders()).toEqual([{ id: "f1", name: "Agents" }]);
    expect(chatFolderMap()).toEqual({ a: "f1" });
    localStorage.setItem("ghostly_chat_folders", "{not json");
    expect(chatFolders()).toEqual([]);
    localStorage.setItem("ghostly_chat_folders", "null");
    expect(chatFolderMap()).toEqual({});
  });

  it("redraws what shows them when they change, here or in another page of the app", () => {
    const { result } = renderHook(() => useChatFolders());
    expect(result.current.folders).toEqual([]);
    let agents: ReturnType<typeof createFolder>;
    act(() => { agents = createFolder("Agents"); setChatFolder("a", agents!.id); });
    expect(result.current.folders.map(f => f.name)).toEqual(["Agents"]);
    expect(result.current.folderOf("a")).toBe(agents!.id);
    act(() => {
      localStorage.removeItem("ghostly_chat_folders");
      window.dispatchEvent(new Event("storage"));
    });
    expect(result.current.folders).toEqual([]);
  });
});

describe("a profile's backup", () => {
  it("carries the folders, their order and their chats", async () => {
    const work = createProfile("Work");
    setStorageProfile(namespaceOf(work.id));
    const agents = createFolder("Agents")!;
    createFolder("Personal");
    setChatFolder("a", agents.id);
    setFolderFolded(agents.id, true);
    const back = await restoreProfileBackup(await createProfileBackup("a long backup passphrase", work.id), "a long backup passphrase");
    setStorageProfile(namespaceOf(back.id));
    expect(chatFolders()).toEqual([{ id: agents.id, name: "Agents", folded: true }, { id: expect.any(String), name: "Personal" }]);
    expect(folderOf("a")).toBe(agents.id);
  });
});
