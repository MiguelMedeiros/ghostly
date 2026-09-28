import { fromBase64Url } from "./bytes";
import { decryptText, encryptText, epochKeys } from "./groupCrypto";
import { GROUP_ID } from "./groupCommits";
import { TYPING_FRAME, TypingReceiver, type TypingActivity, type TypingFrame } from "./pairedTyping";

/**
 * The typing indicator of a private group (WISP 9xx · Group Mesh § Typing): "Ana is typing", said on the group's
 * edges only, the way a 1:1 chat says it on its session (WISP 401 § Typing), with the same kinds, limits and wording.
 *
 *     {"t":"group-typing","g":"<group>","e":3,"n":"<nonce>","c":"<sealed>"}
 *
 * `c` is the 1:1 frame's word (`{"s":"start","kind":"recording"}`, `{"s":"stop"}`) sealed under the message key of
 * epoch `e`, bound to the group, the epoch and the sender (the member the edge is pinned to): a frame another member
 * replays on its own edge does not open. It is presence, not a message: no id, no sequence number, never stored,
 * never handed on in a catch-up, never in the chain, never passed on by a hub. Older apps drop the frame.
 *
 * Community groups do not carry it yet: everything a community carries is a stored message that hubs relay and
 * members hand on in catch-ups, and typing is not one.
 */

export const GROUP_TYPING_FRAME = "group-typing";

export interface GroupTypingFrame { t: typeof GROUP_TYPING_FRAME; g: string; e: number; n: string; c: string }

/** A sealed word is a few dozen bytes; anything much longer is not one and is dropped before it is opened. */
const MAX_BOX = 512;

const typingAad = (groupId: string, epoch: number, sender: string) => JSON.stringify(["ghostly-group typing", groupId, epoch, sender]);

/** A 1:1 typing frame (from a `TypingSender`, one per group), sealed for the group under the epoch's secret (base64url). */
export function sealGroupTyping(groupId: string, epoch: number, secretB64: string, sender: string, word: TypingFrame): GroupTypingFrame {
  const { t: _t, ...inner } = word;
  const { n, c } = encryptText(epochKeys(fromBase64Url(secretB64), groupId, epoch).message, typingAad(groupId, epoch, sender), JSON.stringify(inner));
  return { t: GROUP_TYPING_FRAME, g: groupId, e: epoch, n, c };
}

/** The epoch a `group-typing` frame says it is sealed under, or null when it is not one for this group. */
export function groupTypingEpoch(raw: unknown, groupId: string): number | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  if (f.t !== GROUP_TYPING_FRAME || f.g !== groupId || !GROUP_ID.test(groupId)) return null;
  if (!Number.isSafeInteger(f.e) || (f.e as number) < 0 || typeof f.n !== "string" || typeof f.c !== "string" || f.c.length > MAX_BOX) return null;
  return f.e as number;
}

/**
 * The word inside a `group-typing` frame from `sender`, as a 1:1 typing frame (`TypingReceiver` reads it, kind and
 * status checked there), or null when it does not open under that epoch's secret or is not a word.
 */
export function openGroupTyping(raw: GroupTypingFrame, secretB64: string, sender: string): TypingFrame | null {
  const plain = decryptText(epochKeys(fromBase64Url(secretB64), raw.g, raw.e).message, typingAad(raw.g, raw.e, sender), raw.n, raw.c);
  if (plain === null) return null;
  try {
    const inner = JSON.parse(plain) as Record<string, unknown>;
    if (!inner || typeof inner !== "object" || (inner.s !== "start" && inner.s !== "stop")) return null;
    return { t: TYPING_FRAME, s: inner.s, ...(typeof inner.kind === "string" ? { kind: inner.kind as TypingFrame["kind"] } : {}), ...(typeof inner.status === "string" ? { status: inner.status } : {}) };
  } catch { return null; }
}

/** Who is typing in one group: member key → what they are doing, in the order they started. */
export type GroupTyping = { member: string; activity: TypingActivity }[];

/**
 * The members' words in one group: one `TypingReceiver` per member, so each has the 1:1 timeout (6 s without a new
 * `start`) and its own rate limit (a member flooding frames is held where it was, and nobody else is). The caller
 * says who is a member: a frame from anyone else never reaches it. `onChange` hears every change.
 */
export class GroupTypingBoard {
  private readonly members = new Map<string, TypingReceiver>();

  constructor(private readonly onChange: () => void, private readonly now: () => number = Date.now) {}

  /** A word from `member`, already opened. False when it was dropped (malformed, or over the member's limit). */
  receive(member: string, word: Record<string, unknown>): boolean {
    let receiver = this.members.get(member);
    if (!receiver) this.members.set(member, (receiver = new TypingReceiver(() => this.onChange(), this.now)));
    return receiver.receive(word);
  }

  /** A message from `member` arrived, or it left the group: it is not typing any more. */
  clear(member: string): void { this.members.get(member)?.clear(); }

  /** Nobody is typing: the group was left, or this app stopped. */
  clearAll(): void { for (const receiver of this.members.values()) receiver.clear(); this.members.clear(); }

  /** Who is typing now, among `members` when given (someone the roster took out is not shown). */
  typing(members?: readonly string[]): GroupTyping {
    const out: GroupTyping = [];
    for (const [member, receiver] of this.members) {
      const activity = receiver.peerActivity;
      if (activity && (!members || members.includes(member))) out.push({ member, activity });
    }
    return out;
  }
}
