import { useSyncExternalStore } from "react";

/*
 * Something another app shared into Ghostly (the installed web app is a share target): text, a link, images,
 * files. It is held here, in memory only, from the moment the page receives it until a chat is picked (a profile
 * switch hands it to the next page, `carryIncomingShare`); then it waits for that chat's composer, which puts the
 * text in the draft and the files on the attachment sheet (the same sheet a paste or a drop opens, #349). Nothing is
 * sent until the person sends it there.
 */

/**
 * Most files one share brings, on the web (sw/policy.ts `MAX_SHARED_FILES`) and on Android (GhostlyHostPlugin.kt
 * `MAX_SHARED_FILES`): keep the three alike.
 */
export const MAX_SHARE_FILES = 32;

/** A file of a share as the picker shows it: a browser's File, or one not read into the page yet. */
export type SharedFile = Pick<File, "name" | "size" | "type">;

export interface IncomingShare {
  title: string;
  text: string;
  url: string;
  files: SharedFile[];
  /** The names of files left out as too large to bring into the page (`""`: name not known); the picker says so. */
  leftOut?: string[];
  /** The names of files Android could not read (a revoked permission, a broken stream); the picker says so. */
  unread?: string[];
  /** The names of files Android had no room to copy (the device is full); the picker says so. */
  noRoom?: string[];
  /** The names of files left out past the most one share brings (`MAX_SHARE_FILES`); the picker says so on a line of its own. */
  pastLimit?: string[];
  /**
   * How many shares came while this one waited and could not be kept, past the most that can wait
   * (`MAX_WAITING_SHARES`, here or in the web app's worker); the picker says so with this one.
   */
  dropped?: number;
  /**
   * Reads `files` into the page where they are only names and sizes (the Android app's share: its bytes are read
   * when a chat's composer takes it, not before the picker shows). Without it, `files` are the Files.
   */
  read?: () => Promise<File[]>;
  /**
   * Keeps the share for the page that loads next (a profile switch restarts the app), which shows it in its picker
   * again. False where it could not be kept. Without it, the share goes with this page.
   */
  carry?: () => boolean;
}

/** A share's files as Files, read now where they were not yet. */
export function shareFiles(share: IncomingShare): Promise<File[]> {
  return share.read ? share.read() : Promise.resolve(share.files.filter((file): file is File => file instanceof File));
}

/**
 * Most shares the picker holds at once, the one shown and those behind it (the web app's worker holds as many,
 * sw/messages.ts `MAX_HELD_SHARES`: keep the two alike).
 */
export const MAX_WAITING_SHARES = 3;

let pending: IncomingShare | null = null;
/** Shares that came while `pending` waited (`receiveShare` with `behind`), oldest first: each is shown once the one before it goes. */
let behind: IncomingShare[] = [];
/** Shares sent to a chat whose composer has not taken them yet, oldest first (one chat may be picked for several). */
const forChat = new Map<string, IncomingShare[]>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/** Whether a share has anything in it for a chat. */
export function isEmptyShare(share: IncomingShare): boolean {
  return !share.files.length && !share.text.trim() && !share.url.trim() && !share.title.trim();
}

/**
 * A share arrived: it waits for a chat to be picked. An empty one is dropped, and never clears one that waits; one
 * that only names files left out (too large, not read, no room for them, or past the most one share brings) is said
 * all the same, with the share that waits when there is one. A share with something replaces the one that waits, but
 * still names what a waiting notice named (Android may hand an older share still copying over after a newer notice).
 *
 * `queue` (the web app, whose share target any website can post to): a share never replaces or changes the one that
 * waits; it waits behind it, and is shown once that one is sent to a chat or put aside. Past `MAX_WAITING_SHARES` the
 * newest is dropped, never without a word: the share shown counts it (`dropped`), as it counts those the worker could
 * not keep before this one reached the page (this one's `dropped`).
 */
export function receiveShare(share: IncomingShare, { queue = false } = {}): void {
  if (queue) {
    const { dropped: before = 0, ...rest } = share;
    const said = !isEmptyShare(rest) || !!(rest.leftOut?.length || rest.unread?.length || rest.noRoom?.length || rest.pastLimit?.length);
    if (!said && !before) return;
    if (!pending) pending = share;
    else {
      let dropped = before;
      if (said) {
        if (behind.length + 1 < MAX_WAITING_SHARES) behind.push(rest);
        else dropped += 1;
      }
      if (dropped) pending = { ...pending, dropped: (pending.dropped ?? 0) + dropped };
    }
    emit();
    return;
  }
  if (isEmptyShare(share)) {
    if (!share.leftOut?.length && !share.unread?.length && !share.noRoom?.length && !share.pastLimit?.length) return;
    pending = pending ? withNames(pending, share) : share;
  } else pending = pending && isEmptyShare(pending) ? withNames(share, pending, true) : share;
  emit();
}

/** `share` naming `names`' files left out too: after its own, or before them (`first`). */
function withNames(share: IncomingShare, names: IncomingShare, first = false): IncomingShare {
  const join = (own: string[] = [], more: string[] = []) => first ? [...more, ...own] : [...own, ...more];
  return {
    ...share,
    leftOut: join(share.leftOut, names.leftOut),
    unread: join(share.unread, names.unread),
    noRoom: join(share.noRoom, names.noRoom),
    pastLimit: join(share.pastLimit, names.pastLimit),
  };
}

export function incomingShare(): IncomingShare | null {
  return pending;
}

/** The share was put aside (Cancel): it is gone, and the next one behind it, if any, is shown. */
export function dropIncomingShare(): void {
  pending = behind.shift() ?? null;
  emit();
}

/**
 * The page is about to go (a profile switch restarts it; on the web, a share into the same window replaces it): the
 * shares that wait for a chat to be picked are kept for the next page, in their order, after those sent to a chat
 * whose composer has not taken them yet (the next page shows them in its picker again). Those kept are the next
 * page's, no longer this one's, so a second call keeps nothing twice. Whether the next page has one to show. Nothing
 * is redrawn: the page is going.
 */
export function carryIncomingShare(): boolean {
  const carry = (share: IncomingShare | null) => { try { return share?.carry?.() ?? false; } catch { return false; } };
  let sent = false;
  for (const [chat, shares] of forChat) {
    const left = shares.filter((share) => !carry(share));
    sent ||= left.length < shares.length;
    if (left.length) forChat.set(chat, left);
    else forChat.delete(chat);
  }
  const kept = carry(pending);
  behind = behind.filter((share) => !carry(share));
  if (kept) pending = behind.shift() ?? null;
  return kept || sent;
}

/**
 * The chat picked: the share waits for its composer, and the next one waiting, if any, is shown. `chat` is the
 * composer's draft id (a session id, `group:<id>`). The same share picked again for a chat where it still waits (an
 * edit open there, which the composer says) is not kept twice: shared again as it looked lost, it would go in twice.
 */
export function sendShareTo(chat: string): void {
  if (!pending) return;
  const waiting = forChat.get(chat) ?? [];
  const share = pending;
  if (!waiting.some((kept) => sameShare(kept, share))) forChat.set(chat, [...waiting, share]);
  pending = behind.shift() ?? null;
  emit();
}

/** Whether two shares bring the same: the same text and the same files (by name, size and type), in their order. */
function sameShare(a: IncomingShare, b: IncomingShare): boolean {
  return shareText(a) === shareText(b) && a.files.length === b.files.length
    && a.files.every((file, i) => file.name === b.files[i]!.name && file.size === b.files[i]!.size && file.type === b.files[i]!.type);
}

/** The shares sent to one chat as one: their texts one under the other, and all their files, in their order. */
function joinShares(shares: IncomingShare[]): IncomingShare {
  if (shares.length === 1) return shares[0]!;
  return {
    title: "",
    text: shares.map(shareText).filter(Boolean).join("\n"),
    url: "",
    files: shares.flatMap((share) => share.files),
    ...(shares.some((share) => share.read) && { read: async () => (await Promise.all(shares.map(shareFiles))).flat() }),
  };
}

/** The share waiting for this chat's composer, left in place. */
export function peekShareFor(chat: string): IncomingShare | null {
  const shares = forChat.get(chat);
  return shares ? joinShares(shares) : null;
}

/** The share waiting for this chat's composer, taken: it is handed over once. */
export function takeShareFor(chat: string): IncomingShare | null {
  const share = peekShareFor(chat);
  forChat.delete(chat);
  return share;
}

/**
 * A share a composer took but could not keep (its files read only once an edit had begun there): it waits for that
 * chat's composer again, ahead of any sent there since. The composer says it waits by the edit, and looks again once
 * it can take files (the edit ended); a share made meanwhile is still shown in the picker as usual.
 */
export function keepShareFor(chat: string, share: IncomingShare): void {
  forChat.set(chat, [share, ...forChat.get(chat) ?? []]);
}

/**
 * The text a share puts in the draft: its text, and its link where the text does not already carry it (apps
 * differ: some put the link in `text`, some in `url`, some in both). A title only when there is nothing else.
 */
export function shareText(share: Pick<IncomingShare, "title" | "text" | "url">): string {
  const text = share.text.trim();
  const url = share.url.trim();
  const parts = [text, url && !text.includes(url) ? url : ""].filter(Boolean);
  if (!parts.length && share.title.trim()) parts.push(share.title.trim());
  return parts.join("\n");
}

/** How much of a share's text the picker lays out: it shows three lines of it, and a share's text may be megabytes. */
const PREVIEW_UNITS = 2048;

/** The start of a share's text, for the picker: never ending on half a character (a surrogate pair kept whole). */
export function sharePreview(share: Pick<IncomingShare, "title" | "text" | "url">): string {
  const text = shareText(share);
  if (text.length <= PREVIEW_UNITS) return text;
  const end = /[\uD800-\uDBFF]/.test(text[PREVIEW_UNITS - 1]!) ? PREVIEW_UNITS - 1 : PREVIEW_UNITS;
  return `${text.slice(0, end)}…`;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The share waiting for a chat to be picked. */
export function useIncomingShare(): IncomingShare | null {
  return useSyncExternalStore(subscribe, incomingShare, () => null);
}

/** Calls `listener` whenever a share moves (arrives, is sent to a chat, is dropped). */
export function onShareChange(listener: () => void): () => void {
  return subscribe(listener);
}

/**
 * Every share this page holds is dropped: those in the picker and those sent to a chat whose composer has not taken
 * them. The profile's data goes (Clear all data, Remove this profile here), and a share picked for a chat is a draft of
 * it: none is carried to the page that loads next.
 */
export function resetIncomingShare(): void {
  pending = null;
  behind = [];
  forChat.clear();
  emit();
}
