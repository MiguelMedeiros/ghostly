import { GROUP_VERSION_SIGNALS, SIGNAL_CARRIERS, SIGNAL_FRESH_MS, SIGNAL_HOLD_MS, SIGNAL_REPLY_MS, SIGNALS_PER_MINUTE, groupSignalFrame, readGroupSignal, rosterHas, type GroupSession } from "@ghostly/core";
import type { StoredGroup } from "../shared/types";
import type { GroupsHost } from "./groups";

/** What the signals need of the groups: a group's session and stored row, and the clock. */
export interface MeshSignalsScope {
  session(groupId: string): GroupSession | undefined;
  stored(groupId: string): StoredGroup | undefined;
  now(): number;
}

/**
 * Edge signaling through members (WISP 902 · Group Mesh § Signaling through members; `CarriedTransport` in core): which
 * links an edge's packet is handed to, what a member does with one that is for someone else, and what happens to one
 * that is for me. A packet is the edge's own Pkarr packet, signed under a key only its two ends derive: whoever
 * carries it sees a signed blob, as a relay does, and the edge checks it as it checks a relay's answer.
 */
export class MeshSignals {
  /** A joiner's entry session, kept after the welcome while its edges open: group → link id. */
  private readonly kept = new Map<string, string>();
  /** Packets for an edge that is not started yet (the commit that names its member is being applied): group → member → packet. */
  private readonly waiting = new Map<string, Map<string, { payload: Uint8Array; at: number }>>();
  /** `<group> <member>` → when mine last went back the way theirs came. */
  private readonly replied = new Map<string, number>();
  /** `<group> <member>` → when I passed its frames on, within the minute. */
  private readonly passed = new Map<string, number[]>();
  /** `<group> <member>` → the link its last carried packet came on: mine for it goes there first. */
  private readonly via = new Map<string, string>();
  /** Frames to pass on to a member no link reaches yet: `<group> <to>` → from → the newest, and when it came. */
  private readonly held = new Map<string, Map<string, { payload: Uint8Array; at: number }>>();

  constructor(private readonly host: GroupsHost, private readonly scope: MeshSignalsScope) {}

  private ready(linkId: string | undefined): linkId is string {
    return !!linkId && this.host.linkReady(linkId, GROUP_VERSION_SIGNALS);
  }

  /**
   * The links my packet for the edge to `to` goes on: one of the two of us beside the edge when there is one (the
   * entry session that admitted one of us, the chat the invitation went over), else a few members whose edges are up.
   */
  private links(groupId: string, session: GroupSession, group: StoredGroup, to: string): { links: string[]; sure: boolean } {
    const kept = this.kept.get(groupId);
    const direct = [this.host.entries(groupId).get(to), group.contacts?.[to], to === session.admin ? kept : undefined].find(id => this.ready(id));
    if (direct) return { links: [direct], sure: true };
    const out: string[] = [];
    const edges = this.host.edges(groupId);
    // The admin keeps an edge with every member (it is who admits them), and the entry session reaches the admin.
    const admin = session.admin && session.admin !== session.myKey ? edges.get(session.admin) : undefined;
    const sure = this.ready(kept) || this.ready(admin);
    if (this.ready(kept)) out.push(kept);
    const proven = this.via.get(`${groupId} ${to}`);
    if (proven && proven !== kept && this.ready(proven) && [...edges.values()].includes(proven)) out.push(proven);
    for (const key of [session.admin, ...session.others]) {
      if (out.length >= SIGNAL_CARRIERS) break;
      if (!key || key === to || key === session.myKey) continue;
      const edge = edges.get(key);
      if (this.ready(edge) && !out.includes(edge)) out.push(edge);
    }
    return { links: out.slice(0, SIGNAL_CARRIERS), sure };
  }

  /**
   * Hands my packet for the edge to `to` to links that reach it or may pass it on. `taken`: how many took it. `sure`:
   * one of them is a link of the two of us, or reaches the admin (`CarriedHooks.carry`).
   */
  carry(groupId: string, to: string, payload: Uint8Array): { taken: number; sure: boolean } {
    const session = this.scope.session(groupId), group = this.scope.stored(groupId);
    if (!session || !group || group.left || session.status !== "active" || to === session.myKey || !rosterHas(session.roster, to)) return { taken: 0, sure: false };
    const frame = groupSignalFrame(groupId, session.myKey, to, payload);
    const { links, sure } = this.links(groupId, session, group, to);
    let taken = 0;
    for (const linkId of links) {
      try { this.host.sendOnLink(linkId, frame); taken++; } catch { /* it closed: the relays carry it */ }
    }
    return { taken, sure: sure && taken > 0 };
  }

  /**
   * A `group-signal` that came on `linkId`, whose other end is the member `via` (none: an entry session's admin side
   * as the joiner sees it). For me: the edge takes it, and my own packet goes back the same way when theirs was news.
   * For someone else: passed on once, to a link that reaches them, and only when it is its sender's own.
   */
  received(linkId: string, via: string | undefined, raw: unknown): void {
    const frame = readGroupSignal(raw);
    if (!frame) return;
    const session = this.scope.session(frame.g), group = this.scope.stored(frame.g);
    if (!session || !group || group.left || session.status !== "active") return;
    if (frame.from === session.myKey || !rosterHas(session.roster, frame.from)) return;
    const edges = this.host.edges(frame.g);
    if (frame.to === session.myKey) {
      const edge = edges.get(frame.from);
      if (!edge) {
        let waiting = this.waiting.get(frame.g);
        if (!waiting) this.waiting.set(frame.g, (waiting = new Map()));
        waiting.set(frame.from, { payload: frame.payload, at: this.scope.now() });
        return;
      }
      // Over the edge itself, while it is up (`direct`): the packet the relays got, so the edge knows it is not news.
      if (linkId === edge) { this.host.signalIn?.(edge, frame.payload, true); return; }
      if (!this.host.signalIn?.(edge, frame.payload)) return;
      const key = `${frame.g} ${frame.from}`, now = this.scope.now();
      this.via.set(key, linkId);
      if (now - (this.replied.get(key) ?? -Infinity) < SIGNAL_REPLY_MS) return;
      const mine = this.host.edgeSignal?.(edge);
      if (!mine) return;
      this.replied.set(key, now);
      try { this.host.sendOnLink(linkId, groupSignalFrame(frame.g, session.myKey, frame.from, mine)); } catch { /* it closed */ }
      return;
    }
    if (frame.hop || via !== frame.from || !rosterHas(session.roster, frame.to)) return;
    const key = `${frame.g} ${frame.from}`, now = this.scope.now();
    const recent = (this.passed.get(key) ?? []).filter(at => now - at < 60_000);
    if (recent.length >= SIGNALS_PER_MINUTE) { this.passed.set(key, recent); return; }
    recent.push(now);
    this.passed.set(key, recent);
    const target = [edges.get(frame.to), this.host.entries(frame.g).get(frame.to), group.contacts?.[frame.to]].find(id => this.ready(id));
    if (!target) {
      // My edge to that member is not up, and may be in a moment: its newest frame from this one waits for it.
      const slot = `${frame.g} ${frame.to}`;
      let held = this.held.get(slot);
      if (!held) this.held.set(slot, (held = new Map()));
      held.set(frame.from, { payload: frame.payload, at: now });
      return;
    }
    try { this.host.sendOnLink(target, groupSignalFrame(frame.g, frame.from, frame.to, frame.payload, true)); } catch { /* it closed */ }
  }

  /**
   * My packet for the edge to `to`, over that edge itself while it is up (`CarriedHooks.direct`): the packet the relays
   * just took, so the member does not take that one for news after I said goodbye. Only to an app that takes them.
   */
  direct(groupId: string, to: string, linkId: string, payload: Uint8Array): boolean {
    const session = this.scope.session(groupId);
    if (!session || session.status !== "active" || !this.ready(linkId) || this.host.edges(groupId).get(to) !== linkId) return false;
    try { this.host.sendOnLink(linkId, groupSignalFrame(groupId, session.myKey, to, payload)); return true; } catch { return false; }
  }

  /** A packet that came for the edge to `from` before the edge was started, once. */
  take(groupId: string, from: string): Uint8Array | undefined {
    const waiting = this.waiting.get(groupId), kept = waiting?.get(from);
    waiting?.delete(from);
    return kept && this.scope.now() - kept.at < SIGNAL_FRESH_MS ? kept.payload : undefined;
  }

  /**
   * An edge came up: its member may reach the ones I do not yet. My packets for the edges still down go through it,
   * so an app back after a restart, or a member whose first edge just opened, has the rest within a moment.
   */
  edgeReady(groupId: string, session: GroupSession, peerKey: string, linkId: string): void {
    if (!this.ready(linkId)) return;
    // What other members handed me for this one while no link reached it.
    const slot = `${groupId} ${peerKey}`, held = this.held.get(slot), now = this.scope.now();
    this.held.delete(slot);
    for (const [from, frame] of held ?? []) {
      if (now - frame.at >= SIGNAL_HOLD_MS || !rosterHas(session.roster, from)) continue;
      try { this.host.sendOnLink(linkId, groupSignalFrame(groupId, from, peerKey, frame.payload, true)); } catch { return; /* it closed again */ }
    }
    const edges = this.host.edges(groupId);
    for (const key of session.others) {
      if (key === peerKey) continue;
      const edge = edges.get(key);
      if (!edge || this.host.linkReady(edge)) continue;
      const mine = this.host.edgeSignal?.(edge);
      if (!mine) continue;
      try { this.host.sendOnLink(linkId, groupSignalFrame(groupId, session.myKey, key, mine)); } catch { return; /* it closed again */ }
    }
  }

  /** The joiner's entry session stays after the welcome (`keep`), and goes once the admin's edge is up or the time is. */
  keep(groupId: string, linkId: string): void { this.kept.set(groupId, linkId); }
  keptEntry(groupId: string): string | undefined { return this.kept.get(groupId); }
  release(groupId: string, linkId: string): boolean {
    if (this.kept.get(groupId) !== linkId) return false;
    this.kept.delete(groupId);
    return true;
  }

  forget(groupId: string): void {
    this.kept.delete(groupId);
    this.waiting.delete(groupId);
    for (const map of [this.replied, this.passed, this.via, this.held]) for (const key of [...map.keys()]) if (key.startsWith(`${groupId} `)) map.delete(key);
  }
}
