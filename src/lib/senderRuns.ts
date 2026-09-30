import type { GroupView } from "@ghostly/browser/shared/types";

/** Who wrote a group's message, as its row shows them (chat/SenderAvatar.tsx): their key, picture and place in a run. */
export interface MessageAuthor {
  /** The member's key: their colour (lib/memberColors.ts), and whom a tap opens. */
  key: string;
  /** Their name, for the initial when they have no picture ("" for one the group knows by key only). */
  name: string;
  picture?: string;
  /** The last message of a run of theirs: the picture sits beside it; the others keep its room empty. */
  last: boolean;
}

/** What a run needs of a group's row, as the engine keeps it. */
export interface RunRow {
  id: string;
  sender: string;
  member?: string;
  event?: unknown;
  groupPay?: { id: string };
}

/**
 * Who wrote each member's message in a group's timeline, by message id: their key, their name and picture, and whether
 * the message ends a run of theirs (the picture goes beside that one). A run is the members' messages one after the
 * other with nothing between them: a line of the group (someone joined, a new name) or a payment note shown in the
 * timeline ends it; a note shown under its own payment bubble instead (`hiddenNotes`) is not in the timeline, and does
 * not. Over the whole history, not only the rows drawn yet: a long group draws its older rows a moment later
 * (useTailFirst), and a run must not change where it ends when they come.
 */
export function authorsOf(
  rows: readonly RunRow[], group: Pick<GroupView, "members" | "formerNames">, hiddenNotes: ReadonlySet<string>,
  pictureOf: (key: string) => string | undefined,
): Map<string, MessageAuthor> {
  const shown = rows.filter(m => !(m.groupPay && hiddenNotes.has(m.groupPay.id)));
  const byKey = new Map<string, Omit<MessageAuthor, "last">>();
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
  const authors = new Map<string, MessageAuthor>();
  shown.forEach((m, i) => {
    const key = writer(m);
    if (key) authors.set(m.id, { ...authorOf(key), last: writer(shown[i + 1]) !== key });
  });
  return authors;
}
