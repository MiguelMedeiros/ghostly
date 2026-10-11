import { useEffect, useReducer } from "react";
import { getPrefix } from "./storage";

/*
 * Folders in the chat list: a person's own sections ("Agents", "Personal") that chats and groups are put in. A chat
 * is in one folder or in none. Like a chat's pin and mute they are this profile's, on this device: never synced to
 * the profile's other devices and never sent to anyone; a profile's backup carries them as it carries every key of
 * the profile. Whether a folder is folded is kept with it.
 *
 * One key holds it all, so the folders' order and each chat's place change together.
 */

export interface ChatFolder {
  id: string;
  name: string;
  /** Folded: only its header and badge show. */
  folded?: boolean;
}

/** What is stored: the folders in the person's order, and each filed chat's folder. */
interface Stored {
  folders: ChatFolder[];
  /** By chat as the mute store names it: a session id, or `groupChat(id)`. */
  chats: Record<string, string>;
}

/** A folder's name is a short label beside a count, on a phone too. */
export const FOLDER_NAME_MAX = 40;

/** Sent on this page when the folders change (another page of the app sees `storage`). */
export const FOLDERS_EVENT = "chat-folders-updated";

const foldersKey = () => `${getPrefix()}chat_folders`;

const isFolder = (f: unknown): f is ChatFolder =>
  !!f && typeof (f as ChatFolder).id === "string" && !!(f as ChatFolder).id && typeof (f as ChatFolder).name === "string";

/** What is stored, with whatever cannot be read left out: a folder without an id, a chat filed in a folder that is gone. */
function read(): Stored {
  let raw: string | null = null;
  try { raw = localStorage.getItem(foldersKey()); } catch { /* storage unavailable: no folders */ }
  if (!raw) return { folders: [], chats: {} };
  try {
    const stored = JSON.parse(raw) as Partial<Stored> | null;
    const folders: ChatFolder[] = [];
    for (const f of Array.isArray(stored?.folders) ? stored.folders : []) {
      if (isFolder(f) && !folders.some(known => known.id === f.id)) folders.push({ id: f.id, name: f.name, ...(f.folded === true ? { folded: true } : {}) });
    }
    const chats: Record<string, string> = {};
    for (const [chat, id] of Object.entries(stored?.chats && typeof stored.chats === "object" ? stored.chats : {})) {
      if (folders.some(f => f.id === id)) chats[chat] = id;
    }
    return { folders, chats };
  } catch {
    return { folders: [], chats: {} };
  }
}

function write(next: Stored): void {
  try {
    if (next.folders.length === 0) localStorage.removeItem(foldersKey());
    else localStorage.setItem(foldersKey(), JSON.stringify(next));
  } catch { /* storage unavailable: nothing is remembered */ }
  window.dispatchEvent(new Event(FOLDERS_EVENT));
}

/** A name as it is kept: trimmed, its inner spaces single, cut at FOLDER_NAME_MAX. Empty when there is nothing to keep. */
export function folderName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, FOLDER_NAME_MAX).trim();
}

const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/** The folders, in the person's order. */
export function chatFolders(): ChatFolder[] {
  return read().folders;
}

/** The folder a chat is in, or undefined for a chat in none. `chat`: a session id, or `groupChat(id)`. */
export function folderOf(chat: string): string | undefined {
  return read().chats[chat];
}

/** Every filed chat's folder, read once: what a list of many rows asks. */
export function chatFolderMap(): Readonly<Record<string, string>> {
  return read().chats;
}

/** A new folder, last in the order. Undefined when the name is empty. */
export function createFolder(name: string): ChatFolder | undefined {
  const kept = folderName(name);
  if (!kept) return undefined;
  const stored = read();
  const folder: ChatFolder = { id: newId(), name: kept };
  write({ ...stored, folders: [...stored.folders, folder] });
  return folder;
}

/** Renames a folder; an empty name leaves it as it is. */
export function renameFolder(id: string, name: string): void {
  const kept = folderName(name);
  const stored = read();
  if (!kept || !stored.folders.some(f => f.id === id)) return;
  write({ ...stored, folders: stored.folders.map(f => (f.id === id ? { ...f, name: kept } : f)) });
}

/** Deletes a folder. Its chats are deleted from nowhere: they go back to the list, in no folder. */
export function deleteFolder(id: string): void {
  const stored = read();
  if (!stored.folders.some(f => f.id === id)) return;
  write({
    folders: stored.folders.filter(f => f.id !== id),
    chats: Object.fromEntries(Object.entries(stored.chats).filter(([, folder]) => folder !== id)),
  });
}

/** Moves a folder one place up (-1) or down (1) in the order; at the edge it stays. */
export function moveFolder(id: string, by: -1 | 1): void {
  const stored = read();
  const from = stored.folders.findIndex(f => f.id === id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= stored.folders.length) return;
  const folders = [...stored.folders];
  [folders[from], folders[to]] = [folders[to], folders[from]];
  write({ ...stored, folders });
}

/** Folds or unfolds a folder; remembered. */
export function setFolderFolded(id: string, folded: boolean): void {
  const stored = read();
  if (!stored.folders.some(f => f.id === id)) return;
  write({ ...stored, folders: stored.folders.map(f => (f.id === id ? { id: f.id, name: f.name, ...(folded ? { folded: true } : {}) } : f)) });
}

/** Puts a chat in a folder, taking it out of the one it was in; undefined (or a folder that is gone) puts it in none. */
export function setChatFolder(chat: string, folder: string | undefined): void {
  const stored = read();
  const chats = { ...stored.chats };
  if (folder && stored.folders.some(f => f.id === folder)) chats[chat] = folder;
  else delete chats[chat];
  write({ ...stored, chats });
}

/** The folders and each chat's place, kept current: redrawn when they change here or in another page of the app. */
export function useChatFolders(): { folders: ChatFolder[]; folderOf: (chat: string) => string | undefined } {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    window.addEventListener(FOLDERS_EVENT, redraw);
    window.addEventListener("storage", redraw);
    return () => {
      window.removeEventListener(FOLDERS_EVENT, redraw);
      window.removeEventListener("storage", redraw);
    };
  }, []);
  const { folders, chats } = read();
  return { folders, folderOf: chat => chats[chat] };
}
