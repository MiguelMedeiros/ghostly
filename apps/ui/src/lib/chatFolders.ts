import { useEffect, useReducer } from "react";
import { getPrefix, movePinnedTo, pinnedOrder, type PinnedPlace } from "./storage";

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
  /** The rows in no folder ("Other chats") are folded to their heading. */
  othersFolded?: boolean;
  /**
   * The person's own order of a part of the list, by folder id ("" for the rows in no folder): its rows (a session
   * id, or `groupChat(id)`) top first, as the person left them by dragging. A part with none is in order of the
   * latest message, as always.
   */
  orders?: Record<string, string[]>;
}

/** The rows in no folder, as `orders` names them. */
const LOOSE = "";
/** An order names at most this many rows: more than any list a person arranges by hand. */
const ORDER_MAX = 2000;

/** A folder's name is a short label beside a count, on a phone too. */
export const FOLDER_NAME_MAX = 40;

/** Sent on this page when the folders change (another page of the app sees `storage`). */
export const FOLDERS_EVENT = "chat-folders-updated";

/** The id of a folder's chats in the page: what its header's button controls. */
export const folderChatsId = (folderId: string) => `chat-folder-${folderId}`;

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
    const orders: Record<string, string[]> = {};
    for (const [part, rows] of Object.entries(stored?.orders && typeof stored.orders === "object" ? stored.orders : {})) {
      if ((part !== LOOSE && !folders.some(f => f.id === part)) || !Array.isArray(rows)) continue;
      const kept = [...new Set(rows.filter((row): row is string => typeof row === "string" && !!row))].slice(0, ORDER_MAX);
      if (kept.length) orders[part] = kept;
    }
    return { folders, chats, ...(stored?.othersFolded === true && folders.length > 0 ? { othersFolded: true } : {}), ...(folders.length > 0 && Object.keys(orders).length ? { orders } : {}) };
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
  const { [id]: _order, ...orders } = stored.orders ?? {};
  write({
    ...stored,
    folders: stored.folders.filter(f => f.id !== id),
    chats: Object.fromEntries(Object.entries(stored.chats).filter(([, folder]) => folder !== id)),
    ...(stored.orders ? { orders } : {}),
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

/*
 * Pinned chats are put in order among the pinned chats shown with them: those of the same folder, or those in no
 * folder. The stored order stays one list of every pinned chat (lib/storage.ts); a move goes to the place, in that
 * list, of the chat it lands on, so the pinned chats of other folders keep their order among themselves too.
 */

/** The pinned chats shown with `chat` (itself included), top first: those in its folder, or in none as it is. */
export function pinnedBeside(chat: string): string[] {
  const { chats } = read();
  return pinnedOrder().filter(id => chats[id] === chats[chat]);
}

/** A pinned chat's place among the pinned chats shown with it, or undefined for a chat that is not pinned. */
export function pinnedPlaceBeside(chat: string): PinnedPlace | undefined {
  const beside = pinnedBeside(chat);
  const index = beside.indexOf(chat);
  return index < 0 ? undefined : { index, count: beside.length };
}

/**
 * Moves a pinned chat to `index` among the pinned chats shown with it (0 is the top; past either end is that end).
 * Its new place among them, or undefined when it is not pinned or already there.
 */
export function movePinnedBeside(chat: string, index: number): PinnedPlace | undefined {
  const beside = pinnedBeside(chat);
  const from = beside.indexOf(chat);
  const to = Math.max(0, Math.min(beside.length - 1, Math.trunc(index)));
  if (from < 0 || from === to) return undefined;
  // In the whole order, the chat it lands on is where it goes: after it on the way down, before it on the way up.
  return movePinnedTo(chat, pinnedOrder().indexOf(beside[to])) && { index: to, count: beside.length };
}

/**
 * `rows` in the person's order of their part of the list: the rows the order names, as it names them, under the rows
 * it does not (one that came in since, which stay as they were given: the latest first). With no order: as given.
 */
export function inOrder<T>(rows: readonly T[], keyOf: (row: T) => string, order: readonly string[] | undefined): T[] {
  if (!order?.length) return [...rows];
  const place = new Map(order.map((key, index) => [key, index]));
  const named = rows.filter(row => place.has(keyOf(row))).sort((a, b) => place.get(keyOf(a))! - place.get(keyOf(b))!);
  return [...rows.filter(row => !place.has(keyOf(row))), ...named];
}

/** The person's order of a folder's rows (undefined: of the rows in no folder), or undefined when they never made one. */
export function sectionOrder(folder: string | undefined): readonly string[] | undefined {
  return read().orders?.[folder ?? LOOSE];
}

/**
 * Keeps `rows` (every row of that part of the list, top first) as the person's order of it; an empty list forgets the
 * order, and the part is in order of the latest message again. Only with folders, and for a folder that exists.
 */
export function setSectionOrder(folder: string | undefined, rows: readonly string[]): void {
  const stored = read();
  if (stored.folders.length === 0 || (folder !== undefined && !stored.folders.some(f => f.id === folder))) return;
  const orders = { ...stored.orders };
  const kept = [...new Set(rows)].slice(0, ORDER_MAX);
  if (kept.length) orders[folder ?? LOOSE] = kept; else delete orders[folder ?? LOOSE];
  const { orders: _was, ...rest } = stored;
  write(Object.keys(orders).length ? { ...rest, orders } : rest);
}

/** Folds the rows in no folder to their heading, or unfolds them. Only with folders: without one there is no heading. */
export function setOthersFolded(folded: boolean): void {
  const stored = read();
  if (stored.folders.length === 0 || !!stored.othersFolded === folded) return;
  const { othersFolded: _was, ...rest } = stored;
  write(folded ? { ...rest, othersFolded: true } : rest);
}

/** The id of the rows in no folder in the page: what the "Other chats" heading's button controls. */
export const OTHER_CHATS_ID = "chat-folder-others-rows";

/** The folders and each chat's place, kept current: redrawn when they change here or in another page of the app. */
export function useChatFolders(): { folders: ChatFolder[]; folderOf: (chat: string) => string | undefined; othersFolded: boolean; orderOf: (folder: string | undefined) => readonly string[] | undefined } {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    // Another page's write of anything else (a group's read mark, many a second) redrew the whole chat list.
    const stored = (event: StorageEvent) => { if (!event.key || event.key === foldersKey()) redraw(); };
    window.addEventListener(FOLDERS_EVENT, redraw);
    window.addEventListener("storage", stored);
    return () => {
      window.removeEventListener(FOLDERS_EVENT, redraw);
      window.removeEventListener("storage", stored);
    };
  }, []);
  const { folders, chats, othersFolded, orders } = read();
  return { folders, folderOf: chat => chats[chat], othersFolded: !!othersFolded, orderOf: folder => orders?.[folder ?? LOOSE] };
}
