import type { Atom } from "../lib/parse";
import type { MentionView } from "../lib/parse/mentions";

/**
 * A mention in a group message, as the rich text draws it (the `member-mention` atom): "@" and the member's name as it is
 * now, a mention of me stronger than the others. Text only: nothing from the message becomes markup.
 */
export function MentionChip({ atom }: { atom: Atom<"member-mention", MentionView> }) {
  const m = atom.data;
  return (
    <span data-testid="mention" data-key={m.key} data-me={m.me || undefined} title={m.me ? undefined : `@${m.name}`}
      className={m.me ? "rounded px-0.5 font-semibold text-link bg-link/20" : "font-semibold text-link"}>
      @{m.name}
    </span>
  );
}
