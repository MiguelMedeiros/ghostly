import { replySnippet, withoutAppLink, type StatusCard } from "@ghostly/core";
import type { MessageReaction, ReactionNote } from "@ghostly/browser/shared/types";
import type { useI18n } from "../contexts/I18nContext";
import { filePreview } from "./chatList";
import { othersName } from "./groups";
import { messageSnippet } from "./replies";
import { appCardLine } from "./statusCards";
import type { ChatFile } from "./types";

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

/** Where a reaction's note is shown: its message's row when the chat holds it, and whether the chat draws an app card as one. */
export interface NoteQuote {
  row?: { text: string; card?: StatusCard; file?: ChatFile };
  /** `appCardsShown` of the note's chat. */
  appCards?: boolean;
}

/**
 * The chat list's line for a chat's latest reaction: "Ana reacted ❤️ to "…"", or "You reacted…" (a contact named "You":
 * "“You” reacted…"). Its message reads as in its quotes and the pinned bar (`reactionQuote`).
 */
export function reactionNoteText(note: ReactionNote, name: string, t: ReturnType<typeof useI18n>["t"], quote: NoteQuote = {}): string {
  const snippet = reactionQuote(note, t, quote);
  return note.by === "me" ? t("chat.reactions.noteMine", { emoji: note.emoji, snippet }) : t("chat.reactions.note", { name: othersName(name, t), emoji: note.emoji, snippet });
}

/**
 * The message a reaction's note quotes, in the reader's language: a voice message's, a video's or an app card's line, as
 * its quotes and the pinned bar say it (`messageSnippet`), never the English its text keeps for them (`fileMessageText`,
 * `statusCardText`). From its row when the chat holds it (a 1:1 chat's are in the list), else from what the note says it
 * is (`kind`, a group's); a note from before that says its `snippet`. An app card its chat draws as its text reads as
 * that text, never with the bundle's link.
 */
export function reactionQuote(note: ReactionNote, t: ReturnType<typeof useI18n>["t"], { row, appCards = false }: NoteQuote = {}): string {
  if (row) return row.card?.kind === "app" && !appCards ? replySnippet(withoutAppLink(row.text, row.card)) : messageSnippet(row, t, appCards);
  const kind = note.kind;
  if (kind && "voice" in kind) return filePreview({ voice: { duration: kind.voice } }, t) ?? note.snippet;
  if (kind && "video" in kind) return filePreview({ video: { duration: kind.video } }, t) ?? note.snippet;
  if (kind && "app" in kind) return appCardLine({ kind: "app", ...kind.app }, appCards, t) ?? note.snippet;
  return note.snippet;
}

/** My reaction's emoji now, or "" for none. */
export const myReaction = (reactions: Record<string, MessageReaction> | undefined) => reactions?.me?.e ?? "";
