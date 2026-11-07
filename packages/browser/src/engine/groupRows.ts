import type { GroupState } from "@ghostly/core";
import type { GroupLight, GroupLive, StoredGroup } from "../shared/types";
import type { GroupStore } from "./groups";

/**
 * A private group's record in two rows. A message sent or received changes a few fields of the group's state (my
 * sequence number, what I saw, my last frames, my texts not yet stored or said); the rest, its membership chain above
 * all, changes with a commit or a secret only. Each commit carries the whole roster and the chain is never compacted,
 * so the record grew with every join and leave, and each message wrote all of it again: 50 KB in a group of 32 just
 * made, 800 KB after 150 joins and leaves. Now a message writes the group's small row (`GroupLive`, in the settings
 * store) alone, and the record is written when the rest changes.
 *
 * An app from before reads the record alone. Each time the record is written, its `state.seq` is `SEQ_BLOCK` above
 * mine (`StoredGroup.seqReserved`), and it is written again before I send at that number: such an app sends above
 * everything I said, and the members do not drop its messages as already seen. Back here, a record whose `state.seq`
 * is not the number reserved was written by such an app since, and the small row is stale: the record counts.
 */
export const SEQ_BLOCK = 1024;

/** The fields of the state the small row holds. */
const LIVE = ["seq", "seqEpoch", "seen", "sent", "alone", "provisional", "nicks", "unsaid"] as const;

/**
 * The fields of the record a row of their own holds (`GroupLight`) while nothing else of it changed: what a pin (mine
 * or a member's) and a deletion for everyone change. Each wrote the whole record, as a message did before (150 KB in a
 * group of 31 after 20 joins and leaves, 350 KB after 60). Apart from the small row: up to 500 ids each, which a message
 * would write again every time. `came` is the small row's. The same row holds the state's `relayEdits` (up to 64 frames):
 * each edit and deletion for everyone a member's app takes in changes them, and wrote the whole record too.
 */
const LIGHT = ["pin", "removedIds", "removals"] as const;

const topOf = (state: GroupState): string => state.chain[state.chain.length - 1]?.sig ?? "";

/** The members' edits the state keeps to hand on, by their signatures. */
const editsOf = (state: GroupState): string => (state.relayEdits ?? []).map(f => f.sig).join(" ");

/** The state as its record holds it, but for `LIVE` and `relayEdits`, in one string: its frames and statements by their signatures. */
function recordKey(state: GroupState): string {
  const { chain, relay, relayEdits: _edits, meta, metaPast, ...rest } = state;
  for (const field of LIVE) delete (rest as Partial<GroupState>)[field];
  return JSON.stringify([rest, chain.length, chain[0]?.sig, topOf(state), relay?.map(f => f.sig), meta?.sig, metaPast?.map(m => m.sig)]);
}

/** The record but for its state, `LIGHT` and `came` (the small row's), in one string. */
function restKey(group: StoredGroup): string {
  const { state: _state, seqReserved: _reserved, came: _came, ...rest } = group;
  for (const field of LIGHT) delete (rest as Partial<StoredGroup>)[field];
  return JSON.stringify(rest);
}

const lightOf = (group: StoredGroup): GroupLight => ({ ...(group.pin && { pin: group.pin }), removedIds: group.removedIds ?? [], removals: group.removals ?? [], relayEdits: group.state?.relayEdits ?? [] });

function liveOf(group: StoredGroup): GroupLive {
  const s = group.state!;
  return { top: topOf(s), state: { seq: s.seq, seqEpoch: s.seqEpoch, seen: s.seen, sent: s.sent, nicks: s.nicks, ...(s.alone && { alone: s.alone }), ...(s.provisional && { provisional: s.provisional }),
    // A text saved before its row is stored (`unsaid`) is saved with its counter and frame, in the same row.
    ...(s.unsaid?.length ? { unsaid: s.unsaid } : {}) },
    ...(group.came && { came: group.came }) };
}

const cameOf = (group: StoredGroup): string => JSON.stringify(group.came ?? {});

const later = (a: number | undefined, b: number | undefined) => a === undefined ? b : b === undefined ? a : Math.max(a, b);

export class GroupRows {
  /**
   * Per group, the state as its record holds it now (`seq` reserved), its `recordKey`, the rest of it (`restKey`), the
   * members' edits written last, in the record or in their row (`editsOf`), and the `came` its small row holds (`cameOf`).
   */
  private readonly written = new Map<string, { key: string; state: GroupState; rest: string; edits: string; came: string }>();
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

  /**
   * At load: the state of each record that no app from before wrote since takes what its small row says, and its pin
   * and deletions for everyone what their row says.
   */
  async load(groups: StoredGroup[]): Promise<void> {
    if (!this.raw.getGroupLive) return;
    const rows = await this.raw.getGroupLive().catch(() => new Map<string, GroupLive>());
    const lights = await this.raw.getGroupLight?.().catch(() => undefined) ?? new Map<string, GroupLight>();
    for (const group of groups) {
      const live = rows.get(group.id), state = group.state, held = group.seqReserved;
      if (!live || !state || group.community) continue;
      if (!held || held.e !== state.seqEpoch || held.n !== state.seq || live.top !== topOf(state) || live.state.seqEpoch !== state.seqEpoch || !(live.state.seq <= state.seq)) {
        if (live.came) group.came = { ...group.came, ...live.came, peer: later(group.came?.peer, live.came.peer), mention: later(group.came?.mention, live.came.mention) };
        continue;
      }
      // Written with the record and each time `came` changed since: a mark taken back (`unmark`) stays back.
      if (live.came) group.came = live.came; else delete group.came;
      const light = lights.get(group.id);
      if (light) {
        if (light.pin) group.pin = light.pin; else delete group.pin;
        if (light.removedIds.length) group.removedIds = light.removedIds; else delete group.removedIds;
        if (light.removals.length) group.removals = light.removals; else delete group.removals;
      }
      const merged = { ...state };
      for (const field of LIVE) delete (merged as Partial<GroupState>)[field];
      group.state = Object.assign(merged, live.state, light?.relayEdits && { relayEdits: light.relayEdits });
      this.written.set(group.id, { key: recordKey(state), state: structuredClone(state), rest: restKey(group), edits: editsOf(group.state), came: cameOf(group) });
    }
  }

  /**
   * A session's save: its small row alone while the rest of its state is what the record holds, and the members' edits'
   * row when they changed; else the record too.
   */
  async save(group: StoredGroup): Promise<void> {
    const written = this.written.get(group.id), state = group.state!, edits = editsOf(state);
    if (this.raw.putGroupLive && written && holds(written.state, written.key, state) && (edits === written.edits || this.raw.putGroupLight)) {
      await this.raw.putGroupLive(group.id, liveOf(group));
      written.came = cameOf(group);
      if (edits === written.edits) return;
      await this.raw.putGroupLight!(group.id, lightOf(group));
      written.edits = edits;
      return;
    }
    await this.put(group);
  }

  private async put(group: StoredGroup): Promise<void> {
    const state = group.state;
    if (!this.raw.putGroupLive || group.community) return this.raw.putGroup(group);
    // Out of the group, or not in it yet: no small row.
    if (!state) { this.written.delete(group.id); return this.raw.putGroup(group, null); }
    const was = this.written.get(group.id);
    if (was && holds(was.state, was.key, state)) {
      const rest = restKey(group);
      // Only a pin, a deletion for everyone or the members' edits changed: their row alone, the record stays as it is.
      if (rest === was.rest && this.raw.putGroupLight) {
        await this.raw.putGroupLight(group.id, lightOf(group));
        was.edits = editsOf(state);
        // A mark taken back with them (`unmark`): the small row says so.
        const came = cameOf(group);
        if (came !== was.came) { await this.raw.putGroupLive(group.id, liveOf(group)); was.came = came; }
        return;
      }
      // The record holds the edits as they are now, with the rest of the state as it holds it.
      await this.whole(group, { ...group, state: { ...was.state, relayEdits: state.relayEdits }, seqReserved: { e: was.state.seqEpoch, n: was.state.seq } });
      Object.assign(was, { rest, edits: editsOf(state), came: cameOf(group) });
      return;
    }
    // A copy: the session goes on changing the state it holds (a commit pushed on its chain) before it saves it.
    const written = { key: recordKey(state), state: { ...structuredClone(state), seq: state.seq + SEQ_BLOCK }, rest: restKey(group), edits: editsOf(state), came: cameOf(group) };
    this.written.set(group.id, written);
    try {
      await this.whole(group, { ...group, state: written.state, seqReserved: { e: state.seqEpoch, n: written.state.seq } });
    } catch (error) {
      // Not kept: the record still reserves what it did before, and the next save writes it whole again.
      if (this.written.get(group.id) === written) this.written.delete(group.id);
      throw error;
    }
  }

  /**
   * The record written whole as `record`, with the small row, and its `GroupLight` row deleted: the record holds the pin,
   * the deletions and the members' edits again. One that changed while it was being written goes to its row again after it.
   */
  private async whole(group: StoredGroup, record: StoredGroup): Promise<void> {
    const light = JSON.stringify(lightOf(record));
    await this.raw.putGroup(record, liveOf(group));
    if (this.raw.putGroupLight && JSON.stringify(lightOf(group)) !== light) await this.raw.putGroupLight(group.id, lightOf(group));
  }
}

/** Whether a record holding `written` (its `recordKey` `key`) holds `state` too, but for what the small row says. */
function holds(written: GroupState, key: string, state: GroupState): boolean {
  return written.seqEpoch === state.seqEpoch && state.seq <= written.seq && key === recordKey(state);
}
