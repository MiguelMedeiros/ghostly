import { useCallback, useEffect, useSyncExternalStore } from "react";

/*
 * A chat's files on their way, kept per chat as its draft is, not in the composer: the composer is keyed by chat, and
 * a video converting for minutes went on after the chat was left with no line and no Cancel anywhere, and the same
 * video picked again back there was converted and sent a second time. Back in the chat, its line, its progress and
 * its Cancel are there again, and a line said while nobody was in the chat waits for the next composer.
 */

export interface FilesOnTheirWay {
  /** The files on their way, until the chat has them. */
  readonly preparing: readonly File[];
  /** Videos being converted to H.264 MP4 before they go: how far each is. */
  readonly converting: ReadonlyMap<File, number | undefined>;
}

interface ChatFiles {
  state: FilesOnTheirWay;
  /** The files on their way by name, size and date: the same file picked again meanwhile is not sent twice. */
  keys: Set<string>;
  /** Each conversion's Cancel. */
  stoppers: Map<File, AbortController>;
  listeners: Set<() => void>;
  /** The composers showing this chat, the last mounted saying its lines. */
  speakers: ((line: string) => void)[];
  /** Lines said while no composer showed the chat. */
  unsaid: string[];
}

const NOTHING: FilesOnTheirWay = { preparing: [], converting: new Map() };
const chats = new Map<string, ChatFiles>();

function chatFiles(id: string): ChatFiles {
  let chat = chats.get(id);
  if (!chat) { chat = { state: NOTHING, keys: new Set(), stoppers: new Map(), listeners: new Set(), speakers: [], unsaid: [] }; chats.set(id, chat); }
  return chat;
}

/** Nothing left of a chat with nothing on its way and nobody looking: its entry goes. */
function tidy(id: string, chat: ChatFiles) {
  if (chat.state === NOTHING && !chat.keys.size && !chat.stoppers.size && !chat.listeners.size && !chat.speakers.length && !chat.unsaid.length) chats.delete(id);
}

function change(id: string, next: (was: FilesOnTheirWay) => FilesOnTheirWay) {
  const chat = chatFiles(id);
  const state = next(chat.state);
  chat.state = !state.preparing.length && !state.converting.size ? NOTHING : state;
  chat.listeners.forEach((listener) => listener());
  tidy(id, chat);
}

const fileKey = (file: File) => `${file.name}\n${file.size}\n${file.lastModified}`;

/** The chosen files not already on their way in this chat, now taken as on their way. */
export function claimFiles(id: string, chosen: File[]): File[] {
  const { keys } = chatFiles(id);
  const fresh = chosen.filter((file) => !keys.has(fileKey(file)));
  fresh.forEach((file) => keys.add(fileKey(file)));
  return fresh;
}

/** Files that can be picked again: sent, or stopped. */
export function releaseFiles(id: string, files: File[]) {
  const chat = chatFiles(id);
  files.forEach((file) => chat.keys.delete(fileKey(file)));
  tidy(id, chat);
}

export function startPreparing(id: string, file: File) {
  change(id, (was) => ({ ...was, preparing: [...was.preparing, file] }));
}

export function endPreparing(id: string, file: File) {
  change(id, (was) => ({ ...was, preparing: was.preparing.filter((other) => other !== file) }));
}

/** A conversion begins: its Cancel is this chat's, whichever composer shows it. */
export function startConverting(id: string, file: File, stopper: AbortController) {
  chatFiles(id).stoppers.set(file, stopper);
  change(id, (was) => ({ ...was, converting: new Map(was.converting).set(file, undefined) }));
}

export function converted(id: string, file: File, progress: number) {
  change(id, (was) => was.converting.has(file) ? { ...was, converting: new Map(was.converting).set(file, progress) } : was);
}

export function endConverting(id: string, file: File) {
  chatFiles(id).stoppers.delete(file);
  change(id, (was) => { const converting = new Map(was.converting); converting.delete(file); return { ...was, converting }; });
}

/** Cancel on the line: the conversion of the video it names stops. */
export function cancelConverting(id: string, file: File) {
  chats.get(id)?.stoppers.get(file)?.abort();
}

/** A line about this chat's files: on the composer showing it, or on the next one when the chat was left. */
export function sayInChat(id: string, line: string) {
  const chat = chatFiles(id);
  const speaker = chat.speakers[chat.speakers.length - 1];
  if (speaker) speaker(line);
  else chat.unsaid.push(line);
}

/** This chat's files on their way, for its composer, which says the lines about them (`say`). */
export function useFilesOnTheirWay(id: string, say: (line: string) => void): FilesOnTheirWay {
  const subscribe = useCallback((listener: () => void) => {
    const chat = chatFiles(id);
    chat.listeners.add(listener);
    return () => { chat.listeners.delete(listener); tidy(id, chat); };
  }, [id]);
  const state = useSyncExternalStore(subscribe, () => chats.get(id)?.state ?? NOTHING);
  useEffect(() => {
    const chat = chatFiles(id);
    chat.speakers.push(say);
    // What was said while the chat was left: the last of it, as a line said now would replace the one before.
    const unsaid = chat.unsaid.splice(0).pop();
    if (unsaid) say(unsaid);
    return () => { chat.speakers = chat.speakers.filter((other) => other !== say); tidy(id, chat); };
  }, [id, say]);
  return state;
}
