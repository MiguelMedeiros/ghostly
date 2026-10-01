import { useSyncExternalStore } from "react";

/*
 * Something another app shared into Ghostly (the installed web app is a share target): text, a link, images,
 * files. It is held here, in memory only, from the moment the page receives it until a chat is picked; then
 * it waits for that chat's composer, which puts the text in the draft and the files on the attachment sheet
 * (the same sheet a paste or a drop opens, #349). Nothing is sent until the person sends it there.
 */

export interface IncomingShare {
  title: string;
  text: string;
  url: string;
  files: File[];
}

let pending: IncomingShare | null = null;
const forChat = new Map<string, IncomingShare>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/** Whether a share has anything in it at all. */
export function isEmptyShare(share: IncomingShare): boolean {
  return !share.files.length && !share.text.trim() && !share.url.trim() && !share.title.trim();
}

/** A share arrived: it waits for a chat to be picked. An empty one is dropped. */
export function receiveShare(share: IncomingShare): void {
  pending = isEmptyShare(share) ? null : share;
  emit();
}

export function incomingShare(): IncomingShare | null {
  return pending;
}

/** The share was put aside (Cancel): it is gone. */
export function dropIncomingShare(): void {
  pending = null;
  emit();
}

/** The chat picked: the share waits for its composer. `chat` is the composer's draft id (a session id, `group:<id>`). */
export function sendShareTo(chat: string): void {
  if (!pending) return;
  forChat.set(chat, pending);
  pending = null;
  emit();
}

/** The share waiting for this chat's composer, left in place. */
export function peekShareFor(chat: string): IncomingShare | null {
  return forChat.get(chat) ?? null;
}

/** The share waiting for this chat's composer, taken: it is handed over once. */
export function takeShareFor(chat: string): IncomingShare | null {
  const share = forChat.get(chat) ?? null;
  forChat.delete(chat);
  return share;
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

/** Tests only. */
export function resetIncomingShare(): void {
  pending = null;
  forChat.clear();
  emit();
}
