import type { GroupState } from "@ghostly/core";
import type { GroupLive, StoredGroup } from "../shared/types";
import type { GroupStore } from "./groups";

/**
 * A private group's record in two rows. A message sent or received changes a few fields of the group's state (my
 * sequence number, what I saw, my last frames); the rest, its membership chain above all, changes with a commit or a
 * secret only. Each commit carries the whole roster and the chain is never compacted, so the record grew with every
 * join and leave, and each message wrote all of it again: 50 KB in a group of 32 just made, 800 KB after 150 joins
 * and leaves. Now a message writes the group's small row (`GroupLive`, in the settings store) alone, and the record is
 * written when the rest changes.
 *
 * An app from before reads the record alone. Each time the record is written, its `state.seq` is `SEQ_BLOCK` above
 * mine (`StoredGroup.seqReserved`), and it is written again before I send at that number: such an app sends above
 * everything I said, and the members do not drop its messages as already seen. Back here, a record whose `state.seq`
 * is not the number reserved was written by such an app since, and the small row is stale: the record counts.
 */
export const SEQ_BLOCK = 1024;

/** The fields of the state the small row holds. */
const LIVE = ["seq", "seqEpoch", "seen", "sent", "alone", "provisional", "nicks"] as const;

const topOf = (state: GroupState): string => state.chain[state.chain.length - 1]?.sig ?? "";

/** The state as its record holds it, but for `LIVE`, in one string: its frames and statements by their signatures. */
function recordKey(state: GroupState): string {
  const { chain, relay, relayEdits, meta, metaPast, ...rest } = state;
  for (const field of LIVE) delete (rest as Partial<GroupState>)[field];
  return JSON.stringify([rest, chain.length, chain[0]?.sig, topOf(state), relay?.map(f => f.sig), relayEdits?.map(f => f.sig), meta?.sig, metaPast?.map(m => m.sig)]);
}

function liveOf(group: StoredGroup): GroupLive {
  const s = group.state!;
  return { top: topOf(s), state: { seq: s.seq, seqEpoch: s.seqEpoch, seen: s.seen, sent: s.sent, nicks: s.nicks, ...(s.alone && { alone: s.alone }), ...(s.provisional && { provisional: s.provisional }) },
    ...(group.came && { came: group.came }) };
}

const later = (a: number | undefined, b: number | undefined) => a === undefined ? b : b === undefined ? a : Math.max(a, b);

export class GroupRows {
  /** Per group, the state as its record holds it now (`seq` reserved), and its `recordKey`. */
  private readonly written = new Map<string, { key: string; state: GroupState }>();
  /** What the engine writes a private group through: its record holds the state as it was last written whole. */
  readonly store: GroupStore;

  constructor(private readonly raw: GroupStore) {
    this.store = {
      getGroups: () => raw.getGroups(),
      putGroup: group => this.put(group),
      deleteGroup: async groupId => { this.written.delete(groupId); await raw.deleteGroup(groupId); },
      getMessages: linkId => raw.getMessages(linkId),
    };
  }

  /** At load: the state of each record that no app from before wrote since takes what its small row says. */
  async load(groups: StoredGroup[]): Promise<void> {
    if (!this.raw.getGroupLive) return;
    const rows = await this.raw.getGroupLive().catch(() => new Map<string, GroupLive>());
    for (const group of groups) {
      const live = rows.get(group.id), state = group.state, held = group.seqReserved;
      if (!live || !state || group.community) continue;
      if (live.came) group.came = { ...group.came, ...live.came, peer: later(group.came?.peer, live.came.peer), mention: later(group.came?.mention, live.came.mention) };
      if (!held || held.e !== state.seqEpoch || held.n !== state.seq || live.top !== topOf(state) || live.state.seqEpoch !== state.seqEpoch || !(live.state.seq <= state.seq)) continue;
      this.written.set(group.id, { key: recordKey(state), state: structuredClone(state) });
      const merged = { ...state };
      for (const field of LIVE) delete (merged as Partial<GroupState>)[field];
      group.state = Object.assign(merged, live.state);
    }
  }

  /** A session's save: its small row alone while the rest of its state is what the record holds, else the record too. */
  async save(group: StoredGroup): Promise<void> {
    const written = this.written.get(group.id);
    if (this.raw.putGroupLive && written && holds(written.state, written.key, group.state!)) return this.raw.putGroupLive(group.id, liveOf(group));
    await this.put(group);
  }

  private async put(group: StoredGroup): Promise<void> {
    const state = group.state;
    if (!this.raw.putGroupLive || group.community) return this.raw.putGroup(group);
    // Out of the group, or not in it yet: no small row.
    if (!state) { this.written.delete(group.id); return this.raw.putGroup(group, null); }
    const was = this.written.get(group.id);
    if (was && holds(was.state, was.key, state)) return this.raw.putGroup({ ...group, state: was.state, seqReserved: { e: was.state.seqEpoch, n: was.state.seq } });
    // A copy: the session goes on changing the state it holds (a commit pushed on its chain) before it saves it.
    const written = { key: recordKey(state), state: { ...structuredClone(state), seq: state.seq + SEQ_BLOCK } };
    this.written.set(group.id, written);
    try {
      await this.raw.putGroup({ ...group, state: written.state, seqReserved: { e: state.seqEpoch, n: written.state.seq } }, liveOf(group));
    } catch (error) {
      // Not kept: the record still reserves what it did before, and the next save writes it whole again.
      if (this.written.get(group.id) === written) this.written.delete(group.id);
      throw error;
    }
  }
}

/** Whether a record holding `written` (its `recordKey` `key`) holds `state` too, but for what the small row says. */
function holds(written: GroupState, key: string, state: GroupState): boolean {
  return written.seqEpoch === state.seqEpoch && state.seq <= written.seq && key === recordKey(state);
}
