import { useMemo, useSyncExternalStore } from "react";
import { engine, type ListChanges } from "@ghostly/browser/platform/engine";
import type { EngineState, SavedMessage, StoredMessage } from "@ghostly/browser/shared/types";

/*
 * The profile's saved messages (`savedMessages`): marks kept on this device, never sent. One store for the app: it asks
 * once when something first shows it, again after a save or an unsave made here, and (at most every `SETTLE_MS`) when
 * a chat with a saved message changes, since an edit or a delete there changes the list, or a chat or group goes.
 */

const SETTLE_MS = 120;
const NONE: readonly SavedMessage[] = [];

let rows: readonly SavedMessage[] = NONE;
let loaded = false;
let asked = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let stop: (() => void) | null = null;
const listeners = new Set<() => void>();

const same = (a: readonly SavedMessage[], b: readonly SavedMessage[]) => a.length === b.length && a.every((s, i) => {
  const m = s.message, n = b[i].message;
  return s.savedAt === b[i].savedAt && m.linkId === n.linkId && m.id === n.id && m.text === n.text && m.edit?.at === n.edit?.at;
});

function read(): void {
  const mine = ++asked;
  void engine.call("savedMessages").then((next) => {
    // An older answer after a newer question says nothing; a store nobody shows any more keeps nothing.
    if (mine !== asked || !stop) return;
    const first = !loaded;
    loaded = true;
    if (first || !same(rows, next)) {
      rows = next;
      for (const listener of listeners) listener();
    }
  }, () => {});
}

function soon(): void {
  if (timer) return;
  timer = setTimeout(() => { timer = null; if (stop) read(); }, SETTLE_MS);
}

/**
 * The chats and groups there are: one going takes its saved messages with it. A set, since the engine orders groups by
 * their last message: a message moving a group up the list changes nothing here.
 */
const chatIds = (state: EngineState | null) => new Set([...state?.links.map((l) => l.id) ?? [], ...state?.groups.map((g) => `group:${g.id}`) ?? []]);
const sameIds = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((id) => b.has(id));

/**
 * One list of the state (its chats, or its groups) as held: its ids in the order they came, and each id with the last
 * check that saw it (`seen`), so that an id met twice in one check shows.
 */
type HeldIds = { order: string[]; seen: Map<string, number> };
const holdIds = (list: readonly { id: string }[] = []): HeldIds => ({ order: list.map((x) => x.id), seen: new Map(list.map((x) => [x.id, 0])) });

/**
 * Whether `list` has the held ids, building nothing: the same ids in the same order (the chats, which the engine
 * orders by when they were made), or else as many ids, each one held and none twice (the groups, which a message moves
 * up the list). False says only that they may differ.
 */
function sameList(list: readonly { id: string }[], held: HeldIds, check: number): boolean {
  const { order, seen } = held;
  if (list.length !== order.length) return false;
  let i = 0;
  while (i < list.length && list[i].id === order[i]) i++;
  if (i === list.length) return true;
  if (list.length !== seen.size) return false;
  for (let j = 0; j < list.length; j++) {
    const id = list[j].id, last = seen.get(id);
    if (last === undefined || last === check) return false;
    seen.set(id, check);
  }
  // The same ids in a new order: the next state, likely in this one, is told by the order alone.
  for (let j = 0; j < list.length; j++) order[j] = list[j].id;
  return true;
}

/**
 * Holds the chats and groups of `state` and tells whether a later state's differ (holding those instead): what
 * `chatIds` + `sameIds` say, without building anything when they are the same. Each engine state comes here (up to
 * 20 a second while a file moves) and a chat or group comes or goes rarely, so a state is first checked against the ids
 * held (`sameList`); only when that fails are the sets built and compared.
 */
export function chatsChange(state: EngineState | null): (next: EngineState | null) => boolean {
  let ids = chatIds(state), links = holdIds(state?.links), groups = holdIds(state?.groups), check = 0;
  return (next) => {
    check++;
    if (sameList(next?.links ?? [], links, check) && sameList(next?.groups ?? [], groups, check)) return false;
    const now = chatIds(next);
    links = holdIds(next?.links);
    groups = holdIds(next?.groups);
    if (sameIds(now, ids)) return false;
    ids = now;
    return true;
  };
}

function start(): () => void {
  const changed = chatsChange(engine.state);
  const offMessages = engine.onMessages((linkId: string, messages: StoredMessage[], changes?: ListChanges) => {
    // Only a chat with a saved message: an edit there shows in the list, a delete takes it out.
    const here = rows.filter((s) => s.message.linkId === linkId);
    if (!here.length) return;
    const differs = (s: SavedMessage, m: StoredMessage | undefined) => m?.text !== s.message.text || m?.edit?.at !== s.message.edit?.at;
    if (changes) {
      // What changed is all there is to look at: a chat sent only its newest page (the extension's tabs) does not hold
      // a saved message older than it, and each message coming in would read them all again.
      const changed = new Map(changes.messages.map((m) => [m.id, m]));
      if (here.some((s) => changes.deleted.includes(s.message.id) || (changed.has(s.message.id) && differs(s, changed.get(s.message.id))))) soon();
      return;
    }
    // A newest page leaves the older rows out: one missing from it is not gone.
    const whole = engine.whole(linkId);
    const now = new Map(messages.map((m) => [m.id, m]));
    if (here.some((s) => (whole || now.has(s.message.id)) && differs(s, now.get(s.message.id)))) soon();
  });
  const offState = engine.subscribe(() => {
    if (changed(engine.state)) soon();
  });
  read();
  return () => {
    offMessages(); offState();
    if (timer) { clearTimeout(timer); timer = null; }
    rows = NONE; loaded = false;
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  stop ??= start();
  return () => {
    listeners.delete(listener);
    if (!listeners.size && stop) { const end = stop; stop = null; end(); }
  };
}

/** The saved messages, the last saved first, each as it is now; empty until the engine answered. */
export function useSavedMessages(): readonly SavedMessage[] {
  return useSyncExternalStore(subscribe, () => rows);
}

/** Whether the engine answered yet: until then `useSavedMessages` is empty because nothing is known. */
export function useSavedRead(): boolean {
  return useSyncExternalStore(subscribe, () => loaded);
}

/** The ids of the saved messages of one chat (`linkId`: its link, or `group:<id>`): what its rows' ⋮ say. */
export function useSavedIn(linkId: string | undefined): ReadonlySet<string> {
  const saved = useSavedMessages();
  return useMemo(() => new Set(saved.flatMap((s) => s.message.linkId === linkId ? [s.message.id] : [])), [saved, linkId]);
}

/** Saves a message (`linkId`: a chat's link or `group:<id>`), or unsaves it with `remove`; the list follows. */
export async function setSaved(linkId: string, messageId: string, remove: boolean): Promise<{ error: string | null }> {
  const result = await engine.call("saveMessage", { linkId, messageId, ...(remove && { remove }) });
  if (stop) read();
  return result;
}
