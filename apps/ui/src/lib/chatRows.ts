/*
 * A chat's list as it changes, for the page that shows it: it gets a new list with each message, whose rows keep their
 * objects but for the newest ones (`withWhole` in lib/storage). So what a walk found in the rows before the first that
 * differs still holds, and a message arriving in a chat of thousands costs what it does in a short one.
 */

/** How many rows two lists have the same from their start. */
function sharedRows<R>(a: readonly R[], b: readonly R[]): number {
  const most = Math.min(a.length, b.length);
  let same = 0;
  while (same < most && a[same] === b[same]) same++;
  return same;
}

/**
 * What `pick` gives for each row of a list, without the rows it gives nothing for, reading only the rows that changed
 * since the list before. `pick` reads the row alone. The same array while nothing in it changed; it is never changed
 * once given.
 */
export function rowPicker<R, T>(pick: (row: R) => T | undefined): (rows: readonly R[]) => readonly T[] {
  let list: readonly R[] = [];
  let picked: readonly T[] = [];
  /** The index in `list` of each one of `picked`. */
  let from: readonly number[] = [];
  return rows => {
    const same = sharedRows(list, rows);
    let kept = picked.length;
    while (kept > 0 && from[kept - 1]! >= same) kept--;
    const more: T[] = [], at: number[] = [];
    for (let i = same; i < rows.length; i++) {
      const value = pick(rows[i]!);
      if (value !== undefined) { more.push(value); at.push(i); }
    }
    list = rows;
    if (kept < picked.length || more.length) {
      picked = [...picked.slice(0, kept), ...more];
      from = [...from.slice(0, kept), ...at];
    }
    return picked;
  };
}

/** What names a contact: a chat's messages have it. */
export interface NickRow { id: string; sender: string; text: string; nick?: string }

/** The row that named the contact in `rows`, by its index (-1: none did), and the name as it said it. */
export interface NickRead { rows: readonly NickRow[]; at: number; nick?: string }

/**
 * The name the contact last gave in these rows: from the newest back, the first of their messages with one, or their
 * joining line. `last`, the read of the list before: the rows it went over and still here are not read again, and a
 * history where nobody says a name is not walked for each message.
 */
export function readContactNick(rows: readonly NickRow[], last?: NickRead): NickRead {
  const same = last ? sharedRows(last.rows, rows) : 0;
  const named = last?.at ?? -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (i < same && i > named) {
      i = named;
      if (i < 0) break;
    }
    const row = rows[i]!;
    if (row.sender !== "peer" && !(row.sender === "system" && row.id.startsWith("peer_"))) continue;
    if (row.nick) return { rows, at: i, nick: row.nick };
    const joined = row.text.match(/^👋 (.+) joined$/)?.[1];
    if (joined) return { rows, at: i, nick: joined };
  }
  return { rows, at: -1 };
}
