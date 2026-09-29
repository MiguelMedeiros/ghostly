import type { MessageReaction, ReactionNote } from "@ghostly/browser/shared/types";
import type { useI18n } from "../contexts/I18nContext";

/*
 * Reactions in the chat's view (WISP 400 § Reactions): the chips a message's reactions make, and the chat list's line.
 */

/** One chip: an emoji, how many chose it, whether I did, and who (names, "You" first). */
export interface ReactionChip { emoji: string; count: number; mine: boolean; who: string[]; first: number }

/**
 * A message's reactions as chips: one per emoji, the most chosen first (then the earliest). Taken-back reactions are
 * left out. `nameOf` names a reactor (`peer`, or a member's key); mine is "You".
 */
export function reactionChips(reactions: Record<string, MessageReaction> | undefined, nameOf: (by: string) => string, you: string): ReactionChip[] {
  const chips = new Map<string, ReactionChip>();
  for (const [by, r] of Object.entries(reactions ?? {})) {
    if (!r.e) continue;
    const chip = chips.get(r.e) ?? { emoji: r.e, count: 0, mine: false, who: [], first: r.at };
    chip.count++;
    chip.first = Math.min(chip.first, r.at);
    if (by === "me") { chip.mine = true; chip.who.unshift(you); } else chip.who.push(nameOf(by));
    chips.set(r.e, chip);
  }
  return [...chips.values()].sort((a, b) => b.count - a.count || a.first - b.first);
}

/** The chat list's line for a chat's latest reaction: "Ana reacted ❤️ to "…"", or "You reacted…". */
export function reactionNoteText(note: ReactionNote, name: string, t: ReturnType<typeof useI18n>["t"]): string {
  return note.by === "me" ? t("chat.reactions.noteMine", { emoji: note.emoji, snippet: note.snippet }) : t("chat.reactions.note", { name, emoji: note.emoji, snippet: note.snippet });
}

/** My reaction's emoji now, or "" for none. */
export const myReaction = (reactions: Record<string, MessageReaction> | undefined) => reactions?.me?.e ?? "";
