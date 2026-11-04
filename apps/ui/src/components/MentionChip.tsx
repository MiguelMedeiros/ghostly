import { MENTION_EVERYONE } from "@ghostly/core";
import type { Atom } from "../lib/parse";
import type { MentionView } from "../lib/parse/mentions";
import { useMemberText } from "../contexts/MemberColorsContext";

/**
 * A mention in a group message, as the rich text draws it (the `member-mention` atom): "@" and the member's name as it is
 * now, in their colour (lib/memberColors.ts), a mention of me marked stronger than the others; where that is not what the message says, what it says is the title.
 * Text only: nothing from the message becomes markup.
 * Only the name is isolated (the rich text leaves this atom bare): "@" stays a neutral of the message around it, so it
 * leads the name on the message's reading side even when the name starts in another script ("@بوب Bob" in English).
 */
export function MentionChip({ atom }: { atom: Atom<"member-mention", MentionView> }) {
  const m = atom.data;
  const memberText = useMemberText();
  return (
    <span data-testid="mention" data-key={m.key} data-me={m.me || undefined} title={m.written !== undefined && m.written !== m.name ? `@${m.written}` : m.me ? undefined : `@${m.name}`}
      className={m.me ? "rounded px-0.5 font-semibold text-link bg-link/20" : `font-semibold ${m.key === MENTION_EVERYONE ? "text-link" : memberText(m.key)}`}>
      @<bdi>{m.name}</bdi>
    </span>
  );
}
