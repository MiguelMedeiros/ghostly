/*
 * A chat's list as it changes, for the page that shows it: it gets a new list with each message, whose rows keep their
 * objects but for the ones that changed (the mirror in platform/sync; lib/storage's `withWhole` for the rows its stored
 * copy left out, `keepRows` for the ones it holds, parsed again after each save). So what a walk found
 * in the rows before the first that differs still holds, and so does what it found in the rows after the last that
 * differs: a message arriving in a chat of thousands costs what it does in a short one, and so does a reaction, an edit
 * or a delivery mark on one of its oldest messages.
 */

/** The last two lists compared, and what came of it: every walk of a page compares the same two. */
let compared: { a: readonly unknown[]; b: readonly unknown[]; same: number; tail?: number } | undefined;

/** How many rows two lists have the same from their start. */
export function sharedRows<R>(a: readonly R[], b: readonly R[]): number {
  if (compared?.a === a && compared.b === b) return compared.same;
  const most = Math.min(a.length, b.length);
  let same = 0;
  while (same < most && a[same] === b[same]) same++;
  compared = { a, b, same };
  return same;
}

/**
 * How many rows two lists have the same at their end, after the ones they have the same from their start
 * (`sharedRows`): the rows `a` has from `sharedRows` to `a.length - sharedTail` are the ones `b` has in their place.
 */
export function sharedTail<R>(a: readonly R[], b: readonly R[]): number {
  const same = sharedRows(a, b);
  if (compared!.tail !== undefined) return compared!.tail;
  const most = Math.min(a.length, b.length) - same;
  let tail = 0;
  while (tail < most && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  compared!.tail = tail;
  return tail;
}

/** The first index of `sorted` (ascending) whose number is `at` or more. */
function firstFrom(sorted: readonly number[], at: number): number {
  let low = 0, high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid]! < at) low = mid + 1;
    else high = mid;
  }
  return low;
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
    const same = sharedRows(list, rows), tail = sharedTail(list, rows);
    // What `list` had from `same` to `end` is what `rows` has from `same` to `end + moved`.
    const end = list.length - tail, moved = rows.length - list.length;
    const kept = firstFrom(from, same), after = firstFrom(from, end);
    const more: T[] = [], at: number[] = [];
    for (let i = same; i < end + moved; i++) {
      const value = pick(rows[i]!);
      if (value !== undefined) { more.push(value); at.push(i); }
    }
    list = rows;
    // A row changed into one that gives the same (a reaction on a message, picked by its id): the same array.
    const alike = after - kept === more.length && more.every((value, j) => value === picked[kept + j]);
    if (alike && (!moved || after === from.length) && at.every((i, j) => i === from[kept + j])) return picked;
    if (!alike) picked = picked.slice(0, kept).concat(more, picked.slice(after));
    const later = from.slice(after);
    from = from.slice(0, kept).concat(at, moved ? later.map(i => i + moved) : later);
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
  let same = last ? sharedRows(last.rows, rows) : 0;
  // The rows from `end` on are the last read's from `end - moved` on, read already.
  const moved = last ? rows.length - last.rows.length : 0;
  let end = last ? rows.length - sharedTail(last.rows, rows) : rows.length;
  let named = last?.at ?? -1;
  if (named >= end - moved) named += moved;
  // The row that named the contact changed: the rows before it were never read.
  else if (named >= same) {
    same = 0;
    end = rows.length;
    named = -1;
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    // What the last read went over without a name (after the row that named the contact, before or after the rows that
    // changed) is not read again.
    if (i > named && (i >= end || i < same)) {
      i = i >= end ? Math.max(end, named + 1) : named + 1;
      continue;
    }
    const row = rows[i]!;
    if (row.sender !== "peer" && !(row.sender === "system" && row.id.startsWith("peer_"))) continue;
    if (row.nick) return { rows, at: i, nick: row.nick };
    const joined = row.text.match(/^👋 (.+) joined$/)?.[1];
    if (joined) return { rows, at: i, nick: joined };
  }
  return { rows, at: -1 };
}
