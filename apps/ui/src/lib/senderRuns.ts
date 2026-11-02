import type { GroupView } from "@ghostly/browser/shared/types";
import { sharedRows } from "./chatRows";

/** Who wrote a group's message, as its row shows them (chat/SenderAvatar.tsx): their key, picture and place in a run. */
export interface MessageAuthor {
  /** The member's key: their colour (lib/memberColors.ts), and whom a tap opens. */
  key: string;
  /** Their name, for the initial when they have no picture ("" for one the group knows by key only). */
  name: string;
  picture?: string;
  /** The first message of a run of theirs: their name goes above it, and above none of the others. */
  first: boolean;
  /** The last message of a run of theirs: the picture sits beside it; the others keep its room empty. */
  last: boolean;
}

/** What a run needs of a group's row, as the engine keeps it. */
export interface RunRow {
  id: string;
  sender: string;
  timestamp: number;
  member?: string;
  event?: unknown;
  groupPay?: { id: string };
}

/** A pause this long between two messages of one member starts a new run (the name again above the next). */
export const RUN_GAP_MS = 5 * 60_000;

/**
 * Whether two times are on one day here (a run never goes past midnight). The last day worked out is kept as its two
 * midnights: a history comes in time order, so a Date is made once a day, not twice a message (local time is slow).
 */
function dayCheck(): (a: number, b: number) => boolean {
  let from = 0, to = -1;
  return (a, b) => {
    if (a < from || a >= to) {
      const day = new Date(a);
      from = day.setHours(0, 0, 0, 0);
      to = day.setDate(day.getDate() + 1);
    }
    return b >= from && b < to;
  };
}

/**
 * Who wrote each member's message in a group's timeline, by message id: their key, their name and picture, and where
 * the message stands in a run of theirs (the name above the first, the picture beside the last). A run is one
 * member's messages one after the other: another member's message, one of mine, a line of the group (someone joined,
 * a new name), a payment note shown in the timeline, a pause of more than `RUN_GAP_MS` or a new day ends it. A note
 * shown under its own payment bubble instead (`hiddenNotes`) is not in the timeline, and does not. Over the whole
 * history, not only the rows in the page: a long group has a window of its rows there (useRowWindow), and a run
 * must not change where it starts or ends as the window moves.
 */
export function authorsOf(
  rows: readonly RunRow[], group: Pick<GroupView, "members" | "formerNames">, hiddenNotes: ReadonlySet<string>,
  pictureOf: (key: string) => string | undefined,
): Map<string, MessageAuthor> {
  const shown = rows.filter(m => !(m.groupPay && hiddenNotes.has(m.groupPay.id)));
  return authorsOn(shown, 0, new Map(), group, pictureOf);
}

/** `authors`, those of the rows of `shown` before `from` (a run starts at `from`, or `from` is 0), with those of the rest. */
function authorsOn(
  shown: readonly RunRow[], from: number, authors: Map<string, MessageAuthor>,
  group: Pick<GroupView, "members" | "formerNames">, pictureOf: (key: string) => string | undefined,
): Map<string, MessageAuthor> {
  const byKey = new Map<string, Omit<MessageAuthor, "first" | "last">>();
  const authorOf = (key: string) => {
    let author = byKey.get(key);
    if (!author) {
      const member = group.members.find(m => m.key === key);
      const picture = pictureOf(key);
      author = { key, name: member?.nick || group.formerNames?.[key] || "", ...(picture && { picture }) };
      byKey.set(key, author);
    }
    return author;
  };
  // Each pair of rows looked at once: a long group's catch-up runs this on every render, over the whole history.
  const sameDay = dayCheck();
  /** The row after `i` goes on the run row `i` is in. */
  const goesOn = (i: number) => {
    const a = shown[i], b = shown[i + 1];
    return !!a && !!b && !!writer(a) && writer(a) === writer(b) && b.timestamp - a.timestamp <= RUN_GAP_MS && sameDay(a.timestamp, b.timestamp);
  };
  // Whether this row goes on the one before: what the row before found when it looked at its next.
  let continues = false;
  for (let i = from; i < shown.length; i++) {
    const m = shown[i]!;
    const key = writer(m);
    const next = goesOn(i);
    if (key) authors.set(m.id, { ...authorOf(key), first: !continues, last: !next });
    continues = next;
  }
  return authors;
}

/** Whose run a row is on: a member's message, not mine, a line of the group or a payment's note. */
function writer(m: RunRow | undefined): string | undefined {
  return m && !m.event && !m.groupPay && m.sender === "peer" ? m.member : undefined;
}

/**
 * `authorsOf` for a page that renders on every engine state: the last answer again while the rows, the rows folded
 * under another (`folded`: a folded row's id → its head's), the hidden notes, the roster's names and the authors'
 * pictures are what they were. The group and the set of notes are new objects each render, so they count by content.
 * A new list keeps the objects of the rows it had (lib/chatRows.ts): the runs before the last one those rows reach are
 * as they were, and only the rows from that run on are read again, so a message in a long group costs what it does in
 * a short one. A new fold of a row before that run, a new hidden note, name or picture reads the whole history again.
 * So the map given is the one given before, changed, while only rows at the end changed: read it in the render it came in.
 */
export function authorsMemo() {
  let last: Read | undefined;
  return (
    rows: readonly RunRow[], folded: ReadonlyMap<string, unknown>, group: Pick<GroupView, "members" | "formerNames">,
    hiddenNotes: ReadonlySet<string>, pictureOf: (key: string) => string | undefined,
  ): ReadonlyMap<string, MessageAuthor> => {
    const hidden = [...hiddenNotes].sort().join("\n");
    const names = JSON.stringify([group.members.map(m => [m.key, m.nick ?? ""]), group.formerNames ?? {}]);
    const same = !!last && last.hidden === hidden && last.names === names
      && [...last.pictures].every(([key, picture]) => pictureOf(key) === picture);
    if (same && last!.rows === rows && last!.folded === folded) return last!.authors;
    const from = same ? redoneFrom(last!, rows, folded) : 0;
    // Kept and changed from the run on, not copied: a copy of a long group's would be a walk of its history again.
    const pictures = from ? last!.pictures : new Map<string, string | undefined>();
    const authors = from ? last!.authors : new Map<string, MessageAuthor>();
    const shown = from ? last!.shown : [], at = from ? last!.at : [];
    const start = from ? at[from]! : 0;
    for (let i = from; i < shown.length; i++) authors.delete(shown[i]!.id);
    shown.length = at.length = from;
    for (let i = start; i < rows.length; i++) {
      const m = rows[i]!;
      if (folded.has(m.id) || (m.groupPay && hiddenNotes.has(m.groupPay.id))) continue;
      shown.push(m);
      at.push(i);
    }
    authorsOn(shown, from, authors, group, key => {
      const picture = pictureOf(key);
      pictures.set(key, picture);
      return picture;
    });
    last = { rows, folded, hidden, names, pictures, shown, at, authors };
    return authors;
  };
}

/** What `authorsMemo` read last, and what it found. */
interface Read {
  rows: readonly RunRow[]; folded: ReadonlyMap<string, unknown>; hidden: string; names: string; pictures: Map<string, string | undefined>;
  /** The rows of `rows` in the runs (not folded, not hidden), and the index in `rows` of each. */
  shown: RunRow[]; at: number[]; authors: Map<string, MessageAuthor>;
}

/**
 * Where in `last.shown` the runs of a new list start to differ from those found before (0: from the start): at the run
 * of the last row the new list has the same, since a row after it may go on it. A row before that folded or unfolded
 * since (a bot's routines become a stack when enough of them come in a row) changes which rows count from there.
 */
function redoneFrom(last: Read, rows: readonly RunRow[], folded: ReadonlyMap<string, unknown>): number {
  const same = sharedRows(last.rows, rows);
  let from = last.at.length;
  while (from > 0 && last.at[from - 1]! >= same) from--;
  if (from === 0) return 0;
  from--;
  while (from > 0 && last.authors.get(last.shown[from]!.id)?.first === false) from--;
  if (folded === last.folded) return from;
  const changed = [...folded.keys()].filter(id => !last.folded.has(id)).concat([...last.folded.keys()].filter(id => !folded.has(id)));
  if (!changed.length) return from;
  // Only the rows after the run's first are read again: a change there is read with them. The first itself folded
  // would let the row after it go on the run before, which is not read again.
  const cut = last.at[from]! + 1;
  const after = new Set([...rows.slice(cut), ...last.rows.slice(cut)].map(m => m.id));
  return changed.every(id => after.has(id)) ? from : 0;
}
