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
 * would write again every time. `came` is the small row's.
 *
 * And the hubs I keep for my next start (`StoredGroup.hubs`, at most eight keys): they change each time a hub goes
 * offline or comes back, and wrote the whole record each time (two hubs away 90 s every 2 minutes: 30 whole records,
 * 1.7 MB, per other hub in 30 min in a group of 31). Only read at the next start, before the beacon is: an app from
 * before, or a row it left stale, starts on the hubs of an older list, and reads the beacon as before. With them,
 * the members whose apps said they take rosters past eight (`StoredGroup.large`), noted when an edge with one first
 * comes up: a member moving to a hub it never had an edge with noted it, and wrote the whole record for that. The row
 * holds the ones noted since the record was written whole, and the list only grows: at load, the record's and the
 * row's together, so none an app from before noted in the record since is lost.
 */
const LIGHT = ["pin", "removedIds", "removals", "hubs", "large"] as const;

const topOf = (state: GroupState): string => state.chain[state.chain.length - 1]?.sig ?? "";

/** The state as its record holds it, but for `LIVE`, in one string: its frames and statements by their signatures. */
function recordKey(state: GroupState): string {
  const { chain, relay, relayEdits, meta, metaPast, ...rest } = state;
  for (const field of LIVE) delete (rest as Partial<GroupState>)[field];
  return JSON.stringify([rest, chain.length, chain[0]?.sig, topOf(state), relay?.map(f => f.sig), relayEdits?.map(f => f.sig), meta?.sig, metaPast?.map(m => m.sig)]);
}

/** The record but for its state, `LIGHT` and `came` (the small row's), in one string. */
function restKey(group: StoredGroup): string {
  const { state: _state, seqReserved: _reserved, came: _came, ...rest } = group;
  for (const field of LIGHT) delete (rest as Partial<StoredGroup>)[field];
  return JSON.stringify(rest);
}

/** The row for `group`, whose record holds the members' apps in `kept` (`StoredGroup.large`) already. */
function lightOf(group: StoredGroup, kept: readonly string[]): GroupLight {
  const large = group.large?.filter(key => !kept.includes(key));
  return { ...(group.pin && { pin: group.pin }), removedIds: group.removedIds ?? [], removals: group.removals ?? [], ...(group.hubs && { hubs: group.hubs }), ...(large?.length ? { large } : {}) };
}

function liveOf(group: StoredGroup): GroupLive {
  const s = group.state!;
  return { top: topOf(s), state: { seq: s.seq, seqEpoch: s.seqEpoch, seen: s.seen, sent: s.sent, nicks: s.nicks, ...(s.alone && { alone: s.alone }), ...(s.provisional && { provisional: s.provisional }),
    // A text saved before its row is stored (`unsaid`) is saved with its counter and frame, in the same row.
    ...(s.unsaid?.length ? { unsaid: s.unsaid } : {}) },
    ...(group.came && { came: group.came }) };
}

const later = (a: number | undefined, b: number | undefined) => a === undefined ? b : b === undefined ? a : Math.max(a, b);

export class GroupRows {
  /**
   * Per group, the state as its record holds it now (`seq` reserved), its `recordKey`, the rest of it (`restKey`), and
   * the members' apps it notes (`StoredGroup.large`).
   */
  private readonly written = new Map<string, { key: string; state: GroupState; rest: string; large: string[] }>();
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
   * At load: the state of each record that no app from before wrote since takes what its small row says, and its pin,
   * deletions for everyone, hubs and members' apps what their row says.
   */
  async load(groups: StoredGroup[]): Promise<void> {
    if (!this.raw.getGroupLive) return;
    const rows = await this.raw.getGroupLive().catch(() => new Map<string, GroupLive>());
    const lights = await this.raw.getGroupLight?.().catch(() => undefined) ?? new Map<string, GroupLight>();
    for (const group of groups) {
      const live = rows.get(group.id), state = group.state, held = group.seqReserved;
      if (!live || !state || group.community) continue;
      if (live.came) group.came = { ...group.came, ...live.came, peer: later(group.came?.peer, live.came.peer), mention: later(group.came?.mention, live.came.mention) };
      if (!held || held.e !== state.seqEpoch || held.n !== state.seq || live.top !== topOf(state) || live.state.seqEpoch !== state.seqEpoch || !(live.state.seq <= state.seq)) continue;
      const light = lights.get(group.id), recorded = group.large ?? [];
      if (light) {
        if (light.pin) group.pin = light.pin; else delete group.pin;
        if (light.removedIds.length) group.removedIds = light.removedIds; else delete group.removedIds;
        if (light.removals.length) group.removals = light.removals; else delete group.removals;
        // Absent from a row of a build from before they were kept there: the record's count.
        if (light.hubs) group.hubs = light.hubs;
        if (light.large) group.large = [...new Set([...recorded, ...light.large])];
      }
      this.written.set(group.id, { key: recordKey(state), state: structuredClone(state), rest: restKey(group), large: recorded });
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
    if (was && holds(was.state, was.key, state)) {
      const rest = restKey(group);
      // Only a pin, a deletion for everyone, the hubs or a member's app noted changed: their row alone, the record stays
      // as it is.
      if (rest === was.rest && this.raw.putGroupLight) return this.raw.putGroupLight(group.id, lightOf(group, was.large));
      const record = { ...group, state: was.state, seqReserved: { e: was.state.seqEpoch, n: was.state.seq } };
      await this.whole(group, record);
      was.rest = rest; was.large = record.large ?? [];
      return;
    }
    // A copy: the session goes on changing the state it holds (a commit pushed on its chain) before it saves it.
    const written = { key: recordKey(state), state: { ...structuredClone(state), seq: state.seq + SEQ_BLOCK }, rest: restKey(group), large: group.large ?? [] };
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
   * the deletions, the hubs and the members' apps again. One that changed while it was being written goes to its row
   * again after it.
   */
  private async whole(group: StoredGroup, record: StoredGroup): Promise<void> {
    const kept = record.large ?? [], light = JSON.stringify(lightOf(record, kept));
    await this.raw.putGroup(record, liveOf(group));
    if (this.raw.putGroupLight && JSON.stringify(lightOf(group, kept)) !== light) await this.raw.putGroupLight(group.id, lightOf(group, kept));
  }
}

/** Whether a record holding `written` (its `recordKey` `key`) holds `state` too, but for what the small row says. */
function holds(written: GroupState, key: string, state: GroupState): boolean {
  return written.seqEpoch === state.seqEpoch && state.seq <= written.seq && key === recordKey(state);
}
