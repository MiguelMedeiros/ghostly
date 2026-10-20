import type { GroupView } from "@ghostly/browser/shared/types";

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
  const writer = (m: RunRow | undefined) => m && !m.event && !m.groupPay && m.sender === "peer" ? m.member : undefined;
  // Each pair of rows looked at once: a long group's catch-up runs this on every render, over the whole history.
  const sameDay = dayCheck();
  /** The row after `i` goes on the run row `i` is in. */
  const goesOn = (i: number) => {
    const a = shown[i], b = shown[i + 1];
    return !!a && !!b && !!writer(a) && writer(a) === writer(b) && b.timestamp - a.timestamp <= RUN_GAP_MS && sameDay(a.timestamp, b.timestamp);
  };
  const authors = new Map<string, MessageAuthor>();
  // Whether this row goes on the one before: what the row before found when it looked at its next.
  let continues = false;
  shown.forEach((m, i) => {
    const key = writer(m);
    const next = goesOn(i);
    if (key) authors.set(m.id, { ...authorOf(key), first: !continues, last: !next });
    continues = next;
  });
  return authors;
}

/**
 * `authorsOf` for a page that renders on every engine state: the last answer again while the rows, the rows folded
 * under another (`folded`: a folded row's id → its head's), the hidden notes, the roster's names and the authors'
 * pictures are what they were. The group and the set of notes are new objects each render, so they count by content.
 */
export function authorsMemo() {
  let last: { rows: readonly RunRow[]; folded: ReadonlyMap<string, unknown>; hidden: string; names: string; pictures: Map<string, string | undefined>; authors: Map<string, MessageAuthor> } | undefined;
  return (
    rows: readonly RunRow[], folded: ReadonlyMap<string, unknown>, group: Pick<GroupView, "members" | "formerNames">,
    hiddenNotes: ReadonlySet<string>, pictureOf: (key: string) => string | undefined,
  ): Map<string, MessageAuthor> => {
    const hidden = [...hiddenNotes].sort().join("\n");
    const names = JSON.stringify([group.members.map(m => [m.key, m.nick ?? ""]), group.formerNames ?? {}]);
    if (last && last.rows === rows && last.folded === folded && last.hidden === hidden && last.names === names
      && [...last.pictures].every(([key, picture]) => pictureOf(key) === picture)) return last.authors;
    const pictures = new Map<string, string | undefined>();
    const authors = authorsOf(rows.filter(m => !folded.has(m.id)), group, hiddenNotes, key => {
      const picture = pictureOf(key);
      pictures.set(key, picture);
      return picture;
    });
    last = { rows, folded, hidden, names, pictures, authors };
    return authors;
  };
}
