import { useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
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

/** The chats and groups there are: one going takes its saved messages with it. */
const chatIds = (state: EngineState | null) => `${state?.links.map((l) => l.id).join(",") ?? ""}|${state?.groups.map((g) => g.id).join(",") ?? ""}`;

function start(): () => void {
  let ids = chatIds(engine.state);
  const offMessages = engine.onMessages((linkId: string, messages: StoredMessage[]) => {
    // Only a chat with a saved message: an edit there shows in the list, a delete takes it out.
    if (!rows.some((s) => s.message.linkId === linkId)) return;
    const now = new Map(messages.map((m) => [m.id, m]));
    if (rows.some((s) => s.message.linkId === linkId && (now.get(s.message.id)?.text !== s.message.text || now.get(s.message.id)?.edit?.at !== s.message.edit?.at))) soon();
  });
  const offState = engine.subscribe(() => {
    const next = chatIds(engine.state);
    if (next === ids) return;
    ids = next;
    soon();
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

/** Saves a message (`linkId`: a chat's link or `group:<id>`), or unsaves it with `remove`; the list follows. */
export async function setSaved(linkId: string, messageId: string, remove: boolean): Promise<{ error: string | null }> {
  const result = await engine.call("saveMessage", { linkId, messageId, ...(remove && { remove }) });
  if (stop) read();
  return result;
}
