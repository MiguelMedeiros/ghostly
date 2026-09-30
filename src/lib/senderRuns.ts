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

/** Two times on different days here: a run never goes past midnight. */
const otherDay = (a: number, b: number) => new Date(a).toDateString() !== new Date(b).toDateString();

/**
 * Who wrote each member's message in a group's timeline, by message id: their key, their name and picture, and where
 * the message stands in a run of theirs (the name above the first, the picture beside the last). A run is one
 * member's messages one after the other: another member's message, one of mine, a line of the group (someone joined,
 * a new name), a payment note shown in the timeline, a pause of more than `RUN_GAP_MS` or a new day ends it. A note
 * shown under its own payment bubble instead (`hiddenNotes`) is not in the timeline, and does not. Over the whole
 * history, not only the rows drawn yet: a long group draws its older rows a moment later (useTailFirst), and a run
 * must not change where it starts or ends when they come.
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
  /** `b` goes on the run `a` is in. */
  const goesOn = (a: RunRow | undefined, b: RunRow | undefined) => !!a && !!b && !!writer(a) && writer(a) === writer(b)
    && b.timestamp - a.timestamp <= RUN_GAP_MS && !otherDay(a.timestamp, b.timestamp);
  const authors = new Map<string, MessageAuthor>();
  shown.forEach((m, i) => {
    const key = writer(m);
    if (key) authors.set(m.id, { ...authorOf(key), first: !goesOn(shown[i - 1], m), last: !goesOn(m, shown[i + 1]) });
  });
  return authors;
}
