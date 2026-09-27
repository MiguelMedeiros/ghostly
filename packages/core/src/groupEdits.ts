import { utf8Encode } from "./bytes";
import { MEMBER_KEY } from "./groupCommits";
import { MENTION_LIMITS, validMentions, type GroupMention } from "./groupMentions";
import { validEditNumber } from "./pairedEdits";

/**
 * Editing a sent text in a group (WISP 9xx § Edits, both profiles). As in a 1:1 chat (WISP 401 § Edits), the author says
 * the whole new text of one of its own messages with an edit number of its own per message, and the highest number
 * wins whatever order edits arrive in. A group has no receipts: the author says an edit to every member it can, and
 * again later (a private group: when an edge opens; a community: its members catch up from each other).
 *
 * - A private group (`group-mesh/1`) sends a `group-edit` frame of its own over each edge, sealed under the key of the
 *   epoch the message was sent in and signed by its author (`GroupSession.sendEdit`).
 * - A community (`group-community/1`) sends an application frame through the group, sealed and signed like any payload,
 *   so every hub carries it and a member who was away gets it with the catch-up:
 *
 *       { "x": { "t": "edit", "id": <message id>, "v": 3, "ts": 1790000000000, "text": "Done: 12 of 12", "m"?: [mentions] } }
 *
 * Older apps drop both: a mesh session ignores a `t` it does not know, a community app the `x` frames it does not know.
 */

export const GROUP_EDIT_FRAME = "group-edit";
export const COMMUNITY_EDIT_FRAME = "edit";

/** One edit of a group message: the message's id in the group, its edit number, when it was made, the whole new text, its mentions. */
export interface GroupEdit {
  id: string;
  /** The edit number, 1 for the first edit (`MAX_EDITS_PER_MESSAGE` at most). */
  e: number;
  ts: number;
  /** The whole new text. */
  m: string;
  /** Places of the new text that name members. */
  k?: GroupMention[];
}

/** An edit as a group hands it to the engine: `sender` is the member it is authenticated as. */
export interface GroupIncomingEdit extends GroupEdit { sender: string }

/** The text bound of a group edit, as a message's: 16 KiB of UTF-8. */
export const GROUP_EDIT_TEXT_BYTES = 16 * 1024;

const MESH_ID = /^([a-km-uw-z13-9]{52}):(\d{1,9}):(\d{1,9})$/;
const COMMUNITY_ID = /^([a-km-uw-z13-9]{52}):(\d{1,9}):([0-9a-f]{16}):(\d{1,9})$/;

/** A private group's message id (`<sender>:<epoch>:<seq>`), split; null when it is not one. */
export function meshMessageRef(id: string): { s: string; e: number; n: number } | null {
  const match = MESH_ID.exec(id);
  if (!match || !MEMBER_KEY.test(match[1])) return null;
  return { s: match[1], e: Number(match[2]), n: Number(match[3]) };
}

/** Whose message a community's id names (`<sender>:<epoch>:<commit>:<seq>`); null when it is not one. */
export function communityMessageAuthor(id: string): string | null {
  const match = COMMUNITY_ID.exec(id);
  return match && MEMBER_KEY.test(match[1]) ? match[1] : null;
}

/** A text an edit may carry: trimmed, not empty, within the bound. */
export function validEditText(text: unknown): text is string {
  return typeof text === "string" && !!text && text === text.trim() && utf8Encode(text).length <= GROUP_EDIT_TEXT_BYTES;
}

/** The `x` frame a community edit travels as. */
export function communityEditFrame(edit: GroupEdit): Record<string, unknown> {
  return { t: COMMUNITY_EDIT_FRAME, id: edit.id, v: edit.e, ts: edit.ts, text: edit.m, ...(edit.k?.length ? { m: edit.k } : {}) };
}

/**
 * The edit a community `x` frame says, from `sender` (whom the group authenticated it as), or null when it is not a
 * valid edit of one of the sender's own messages. Mentions that do not hold are left out, never the edit; a community
 * names no one as everyone.
 */
export function parseCommunityEdit(frame: Record<string, unknown>, sender: string): GroupEdit | null {
  if (frame?.t !== COMMUNITY_EDIT_FRAME) return null;
  const { id, v, ts, text } = frame;
  if (typeof id !== "string" || communityMessageAuthor(id) !== sender || !validEditNumber(v)) return null;
  if (typeof ts !== "number" || !Number.isSafeInteger(ts) || ts <= 0 || !validEditText(text)) return null;
  const k = validMentions(frame.m, text, false);
  return { id, e: v, ts, m: text, ...(k.length ? { k } : {}) };
}

/**
 * The mentions of an edited text: the places the message named that are still there, found by their words (the text
 * around them may have changed, or their order), and those `added` while editing. Where two overlap, `added` wins.
 */
export function carryMentions(before: { text: string; mentions?: readonly GroupMention[] }, after: string, added: readonly GroupMention[], everyone: boolean): GroupMention[] {
  const was = Array.from(before.text), now = Array.from(after);
  const overlaps = (a: GroupMention, b: GroupMention) => a.o < b.o + b.l && b.o < a.o + a.l;
  const carried: GroupMention[] = [];
  for (const m of [...(before.mentions ?? [])].sort((a, b) => a.o - b.o)) {
    const words = was.slice(m.o, m.o + m.l);
    // The first place with its words that no mention carried already holds: "@Bob … @Bob" keeps both, in either order.
    for (let at = indexOf(now, words, 0); at >= 0; at = indexOf(now, words, at + 1)) {
      const place = { k: m.k, o: at, l: m.l };
      if (carried.some(c => overlaps(c, place))) continue;
      carried.push(place);
      break;
    }
  }
  const fresh = validMentions(added.map(({ k, o, l }) => ({ k, o, l })), after, everyone);
  const all = [...fresh, ...carried.filter(m => !fresh.some(a => overlaps(a, m)))].sort((a, b) => a.o - b.o);
  return validMentions(all.slice(0, MENTION_LIMITS.count), after, everyone);
}

function indexOf(points: readonly string[], words: readonly string[], from: number): number {
  if (!words.length) return -1;
  outer: for (let i = from; i + words.length <= points.length; i++) {
    for (let j = 0; j < words.length; j++) if (points[i + j] !== words[j]) continue outer;
    return i;
  }
  return -1;
}
