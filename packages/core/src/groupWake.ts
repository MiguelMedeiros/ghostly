import { MENTION_EVERYONE, validMentions, wireMentions, type GroupMention } from "./groupMentions";
import { WAKE_INTERVAL_MS, parseWakeFrame, wakeFrame, type WakeTarget } from "./pairedWake";

/**
 * Wake-up push in a private group (WISP 902 · Group Mesh § Wake-up push): a member whose web app is closed is woken
 * when a message names it. `wake/1` as a 1:1 chat has it (WISP 401 § Wake-up push), carried on the group's edges: each
 * member shares its subscription with each other member on their own edge, under a token of that edge alone, and
 * only in a group it has not muted:
 *
 *     {"t":"group-wake","g":"<group id>","w":{"e":…,"p":…,"a":…,"vp":…,"vk":…,"k":"<token>"}}
 *     {"t":"group-wake","g":"<group id>","w":null}              (muted, or stopped: forget it)
 *
 * The author of a message wakes the members it names by key (never `*`, everyone), and only those it cannot reach now.
 * The push is the 1:1 one, `{"wake":1,"k":"<token>"}`: no text, no group, no author. A community has no edge between
 * two members, so it has none of this (§ Wake-up push, not yet).
 */

export const GROUP_WAKE_FRAME = "group-wake";

/** At most one wake-up to a member in this long, whatever group names it: a mention storm is one push. */
export const GROUP_WAKE_MEMBER_INTERVAL_MS = WAKE_INTERVAL_MS;
/** At most this many wake-ups from one group in `GROUP_WAKE_GROUP_WINDOW_MS`: a message naming 16 wakes four. */
export const GROUP_WAKE_GROUP_LIMIT = 4;
export const GROUP_WAKE_GROUP_WINDOW_MS = 60_000;
/** Frames a member reads on one edge in a minute: it changes when the other member rotates or mutes. */
export const GROUP_WAKE_RECEIVE_LIMIT = 6;

export type GroupWakeFrame = { t: typeof GROUP_WAKE_FRAME; g: string; w: ReturnType<typeof wakeFrame>["w"] };

export function groupWakeFrame(groupId: string, target: WakeTarget | null): GroupWakeFrame {
  return { t: GROUP_WAKE_FRAME, g: groupId, w: wakeFrame(target).w };
}

/** What a `group-wake` frame says for this group: a target, null (forget it), or undefined (malformed, or another group's). */
export function parseGroupWakeFrame(frame: Record<string, unknown>, groupId: string): WakeTarget | null | undefined {
  if (frame.t !== GROUP_WAKE_FRAME || frame.g !== groupId) return undefined;
  return parseWakeFrame(frame);
}

/**
 * The members a message wakes, as its author sends it: those it names by key (the mentions that hold on the trimmed
 * text), each once, in order. Never `*`: everyone is a group's whole roster, and a wake-up is for one person.
 */
export function mentionedMembers(mentions: readonly GroupMention[] | undefined, text: string): string[] {
  const named = validMentions(wireMentions(mentions ?? []), text.trim(), false);
  return [...new Set(named.map(m => m.k).filter(k => k !== MENTION_EVERYONE))];
}

/**
 * The limits of group wake-ups on the author's side: one per member per `GROUP_WAKE_MEMBER_INTERVAL_MS` (across
 * groups), and `GROUP_WAKE_GROUP_LIMIT` per group per `GROUP_WAKE_GROUP_WINDOW_MS`. In memory, as the 1:1 limiter.
 */
export class GroupWakeLimiter {
  private readonly members = new Map<string, number>();
  private readonly groups = new Map<string, number[]>();
  constructor(
    private readonly memberInterval = GROUP_WAKE_MEMBER_INTERVAL_MS,
    private readonly groupLimit = GROUP_WAKE_GROUP_LIMIT,
    private readonly groupWindow = GROUP_WAKE_GROUP_WINDOW_MS,
  ) {}
  /** Whether a wake-up to `member` for `group` may go now; if so, it counts against both. */
  take(group: string, member: string, now = Date.now()): boolean {
    const before = this.members.get(member);
    if (before !== undefined && now - before < this.memberInterval) return false;
    const recent = (this.groups.get(group) ?? []).filter(at => now - at < this.groupWindow);
    if (recent.length >= this.groupLimit) { this.groups.set(group, recent); return false; }
    this.members.set(member, now);
    this.groups.set(group, [...recent, now]);
    return true;
  }
  /** The member is reachable again: the next time it is away, a mention may wake it at once. */
  reset(member: string): void {
    this.members.delete(member);
  }
}

/**
 * Who the author of a message wakes: the members it names, that shared how, that it cannot reach now, within the
 * limits. `target` answers a member's shared target (its edge's), `reachable` whether it is live (its edge, or a hub).
 */
export function groupWakes<T>(options: {
  group: string; mentions: readonly GroupMention[] | undefined; text: string;
  target: (member: string) => T | undefined; reachable: (member: string) => boolean;
  limiter: GroupWakeLimiter; now?: number;
}): { member: string; target: T }[] {
  const wakes: { member: string; target: T }[] = [];
  for (const member of mentionedMembers(options.mentions, options.text)) {
    const target = options.target(member);
    if (target === undefined || options.reachable(member)) continue;
    if (!options.limiter.take(options.group, member, options.now)) continue;
    wakes.push({ member, target });
  }
  return wakes;
}
