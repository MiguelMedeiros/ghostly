import type { StoredMessage } from "./types";

/**
 * What changed in a chat's or a group's history (its link id, or `group:<id>`): the rows added or changed, as stored
 * now, and the ids of those deleted. The engine sends this instead of the whole history on each change.
 */
export interface MessageChanges {
  messages: StoredMessage[];
  deleted: string[];
}

/** The store's order (`db.getMessages`): by time, then by id. */
function comesBefore(a: StoredMessage, b: StoredMessage): boolean {
  return a.timestamp < b.timestamp || (a.timestamp === b.timestamp && a.id < b.id);
}

/**
 * A history with these changes made: what `db.getMessages` would read now, in its order. A new list; the one given is
 * left as it was. A new row lands where its time puts it, most often at the end.
 */
export function applyMessageChanges(history: readonly StoredMessage[], changes: MessageChanges): StoredMessage[] {
  // The last one given for an id wins.
  const upserts = [...new Map(changes.messages.map((m) => [m.id, m])).values()];
  const gone = new Set([...changes.deleted, ...upserts.map((m) => m.id)]);
  const out = gone.size ? history.filter((m) => !gone.has(m.id)) : history.slice();
  for (const message of upserts) {
    if (changes.deleted.includes(message.id)) continue;
    let low = 0, high = out.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (comesBefore(out[mid]!, message)) low = mid + 1;
      else high = mid;
    }
    out.splice(low, 0, message);
  }
  return out;
}
