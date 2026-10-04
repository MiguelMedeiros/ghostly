import {
  COMMUNITY_TOPOLOGY, MESH_HUBS, beaconKeys, beaconRecords, lobbyKeys, lobbyRecords, mayBeHub, meshHubs, mergeBeacon, mergeLobby, pickMeshHubs, readBeacon, readLobby, rosterHas,
  type GhostRecord, type GroupCommit, type GroupEdgeFrame, type GroupReactedFrame, type GroupSession, type Hub,
} from "@ghostly/core";
import type { StoredGroup } from "../shared/types";
import type { GroupsHost } from "./groups";
import { HubClocks } from "./hubClocks";

/** What `MeshHubs` needs of `Groups`: a group as stored, and saving it (what it records: hubs used, apps without hubs). */
export interface MeshHubsStore {
  stored(groupId: string): StoredGroup | undefined;
  save(group: StoredGroup): void;
}

/**
 * How often a private group's hubs are looked for and said (WISP 9xx · Group Mesh § Hubs). Every read and write here
 * is a background request: on public relays they spend part of the 20 background requests a minute an app allows
 * itself, and little of it. A member reads the beacon once a minute; a hub republishes its entry every 30 s (a read
 * and a write), as a community hub does, since an entry is stale after 90 s.
 */
export interface MeshHubTimings {
  /** A member that is not a hub reads the beacon this often (a hub reads it when it republishes). */
  beaconReadMs: number;
  beaconEveryMs: number;
  /** A hub polls its lobby every `lobbyPollMs` for `lobbyBusyMs` after someone new asked there, else every `lobbyIdlePollMs`. */
  lobbyPollMs: number;
  lobbyIdlePollMs: number;
  lobbyBusyMs: number;
  /** A member refreshes its request in a hub's lobby this often until the hub's edge is up. */
  lobbyWriteMs: number;
  /** A hub that has not taken me this long is avoided a while (another is picked). */
  hubWaitMs: number;
  /** A hub keeps the edge to a member of its own this long after it went down (so a member back soon finds it). */
  memberGoneMs: number;
  /** On start, edges wait this long for the first reading of the beacon (a large group does not open every edge at once). */
  firstReadMs: number;
  /** A hub missing from the beacon still counts this long: a reading that missed it, a commit that moved the beacon. */
  graceMs: number;
  /** The admin and a member it just admitted keep their edge this long, hubs or not (the welcome, the first sync). */
  keepMetMs: number;
  /** A hub says whom it reaches (`group-reach`) at most this often. */
  reachEveryMs: number;
}
export const MESH_HUB_TIMINGS: MeshHubTimings = {
  beaconReadMs: 60_000, beaconEveryMs: COMMUNITY_TOPOLOGY.beaconEveryMs, lobbyPollMs: 6_000, lobbyIdlePollMs: 30_000, lobbyBusyMs: 60_000, lobbyWriteMs: 20_000,
  hubWaitMs: 60_000, memberGoneMs: 5 * 60_000, firstReadMs: 30_000, graceMs: 3 * 60_000, keepMetMs: 2 * 60_000, reachEveryMs: 5_000,
};

/** A hub says whom it reaches this often even when nothing changed: members that cannot read the beacon learn it is one. */
const REACH_AGAIN_MS = 60_000;
/** Signed reactions a hub keeps to say again to a member whose edge opens. */
const REACTIONS_KEPT = 64;
/** How long the edge to a member a commit took out stays, for that commit to reach it. */
const GONE_LINGER_MS = 15_000;
/**
 * Two readings of the beacon no further apart than this say when an entry that moved between them was written
 * (`HubClocks`): a member reads it once a minute (`beaconReadMs`), and a little late at times. Half of it stays under
 * the 45 s by which two clocks must differ before an entry is moved, so clocks that agree are never moved.
 */
const HUB_CLOCK_READ_GAP_MS = 75_000;

/** What a hub says to its edges: the members it has an edge up with, and the members whose apps take no hubs. */
export interface GroupReachFrame { t: "group-reach"; g: string; k: string[]; l?: string[] }

/** Per private group, in memory: its hubs as this device sees and plays them. */
interface HubLive {
  started: number;
  /** The epoch whose beacon I read (the beacon moves with every commit). */
  epoch: number;
  /** The beacon's hubs, each entry in this app's time (`HubClocks.inMyTime`). */
  beacon: Hub[];
  /** Each hub's clock as its entry showed it, and my key in the group (whose entry is mine, never moved). */
  clocks: HubClocks;
  me: string;
  firstRead: boolean;
  lastRead: number;
  lastWrite: number;
  lastTry: number;
  hub: boolean;
  hubSince: number;
  /** As a hub: members whose edge is mine → when it was last up (or they asked in my lobby). */
  members: Map<string, number>;
  lastLobbyPoll: number;
  lobbyBusyUntil: number;
  /** As a member: the hubs I keep edges with, and my requests in their lobbies. */
  myHubs: string[];
  lobbyWrites: Map<string, number>;
  hubWaits: Map<string, number>;
  avoided: Map<string, number>;
  hubsUp: Set<string>;
  /** Hubs as last seen in the beacon, fresh: an edge to one stays a while after a reading misses it. */
  seenHubs: Map<string, number>;
  /** What each hub said it reaches. */
  reach: Map<string, Set<string>>;
  sentReach: string;
  lastReach: number;
  /** Members met over an admission: their edge is kept until then. */
  met: Map<string, number>;
  /** Edges to open expecting the other side at once (it asked in my lobby, or I asked in its). */
  expect: Set<string>;
  /** The hubs recorded last time (`StoredGroup.hubs`) count as seen, once, when the group is first looked at. */
  primed: boolean;
  /** How many edges the last `wanted` asked for: what paces them. */
  wantedSize: number;
  /** Members a commit just took out: their edge stays a moment, for the commit that tells them (a hub passes it on). */
  gone: Map<string, number>;
  /** As a hub: the signed reactions I passed on, the latest per member and message, said again to a member back. */
  reactions: Map<string, GroupReactedFrame>;
  /** As a hub: the edges it keeps (every other member), held for it in the budget of connections while they open. */
  need: number;
}

/**
 * The hubs of the private groups this device is in (WISP 9xx · Group Mesh § Hubs): whether a group runs on hubs, who
 * they are (the community's sealed beacon and lobbies, under the epoch's rendezvous secret), whether I am one, which
 * edges that asks for, and passing frames on as a hub. `Groups` owns the sessions and the edges; this decides.
 */
export class MeshHubs {
  private readonly live = new Map<string, HubLive>();

  constructor(private readonly host: GroupsHost, private readonly groups: MeshHubsStore, private readonly timings: MeshHubTimings = MESH_HUB_TIMINGS) {}

  /**
   * The hubs I kept edges with when the app last ran count as seen now: until the beacon is read (the relays' budget
   * may hold that back), and for a while after, they are where my edges go, rather than every member at once.
   */
  private prime(live: HubLive, group: StoredGroup, now: number): void {
    if (live.primed) return;
    live.primed = true;
    for (const key of group.hubs ?? []) if (!live.seenHubs.has(key)) live.seenHubs.set(key, now);
  }

  /** This app takes part in hubs at all: an app that does not (`hubs: false`) keeps the full mesh, as before revision 0.12. */
  get enabled(): boolean { return this.host.meshHubs?.() !== false; }
  private get staysOnline(): boolean { return !!this.host.staysOnline?.(); }

  private get(groupId: string, now: number): HubLive {
    let live = this.live.get(groupId);
    if (!live) {
      const clocks = new HubClocks(() => live!.me, HUB_CLOCK_READ_GAP_MS);
      this.live.set(groupId, (live = { started: now, epoch: -1, beacon: [], clocks, me: "", firstRead: false, lastRead: 0, lastWrite: 0, lastTry: 0, hub: false, hubSince: 0,
      members: new Map(), lastLobbyPoll: 0, lobbyBusyUntil: 0, myHubs: [], lobbyWrites: new Map(), hubWaits: new Map(), avoided: new Map(), hubsUp: new Set(),
      seenHubs: new Map(), reach: new Map(), sentReach: "", lastReach: 0, met: new Map(), expect: new Set(), wantedSize: 0, primed: false, gone: new Map(), reactions: new Map(), need: 0 }));
    }
    return live;
  }

  forget(groupId: string): void { this.live.delete(groupId); }

  /**
   * The edges this app may keep in a group, within its budget of connections (WISP 9xx · Group Mesh § Hubs, Budget):
   * what the other groups' links do not hold, less what the groups I am a hub of still have to open. Undefined for an
   * app without a budget. What this group holds itself does not count: a hub that stepped down would fit again at once.
   */
  room(groupId: string): number | undefined {
    const room = this.host.peerRoom?.(groupId);
    if (room === undefined) return undefined;
    let held = 0;
    for (const [g, live] of this.live) if (g !== groupId && live.hub) held += Math.max(0, live.need - this.host.edges(g).size);
    return Math.max(0, room - held);
  }

  /** Being a hub of this group, an edge with every other member, fits in this app's budget. Always, without one. */
  fits(groupId: string, session: GroupSession): boolean {
    const room = this.room(groupId);
    return room === undefined || session.others.length <= room;
  }

  /**
   * The edges to keep in a group: what the hubs ask for (every member, in a full mesh), within the budget. Past it, the
   * most useful first, and the rest are not opened (or close): the hubs I count on, the admin, members met a moment
   * ago, edges already up, then the others in a fixed order. A 1:1 chat or a call opened later still finds room.
   */
  edgesWanted(groupId: string, session: GroupSession, group: StoredGroup, now: number): Set<string> {
    const wanted = this.wanted(groupId, session, group, now) ?? new Set(session.others);
    const room = this.room(groupId);
    if (room === undefined || wanted.size <= room) return wanted;
    const live = this.live.get(groupId), edges = this.host.edges(groupId);
    const hubs = new Set([...live?.myHubs ?? [], ...this.large(session) ? this.hubs(groupId, session, now) : []]);
    const rank = (key: string) => hubs.has(key) ? 0 : key === session.admin ? 1 : (live?.met.get(key) ?? 0) > now ? 2
      : edges.has(key) && this.host.linkReady(edges.get(key)!) ? 3 : 4;
    return new Set([...wanted].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, room));
  }

  /** Large enough for hubs: past the threshold, and this app takes part. */
  large(session: GroupSession): boolean { return this.enabled && session.roster.length > MESH_HUBS.threshold; }

  /** I am a hub of this group now. */
  isHub(groupId: string): boolean { return !!this.live.get(groupId)?.hub; }

  /** The hubs I count on: fresh in the beacon, or seen there a moment ago; in the roster, not excluded, not me. */
  hubs(groupId: string, session: GroupSession, now: number): string[] {
    const live = this.live.get(groupId);
    if (!live || !this.large(session)) return [];
    const policy = session.hubPolicy, inRoster = (key: string) => rosterHas(session.roster, key);
    const out = new Set(meshHubs(live.beacon, session.myKey, policy, inRoster, now).map(h => h.key));
    for (const [key, at] of live.seenHubs) if (now - at <= this.timings.graceMs && key !== session.myKey && inRoster(key) && !policy.no.includes(key)) out.add(key);
    return [...out];
  }

  /** The group runs on hubs: it is large, and I am a hub or know of one. Else it is the full mesh. */
  active(groupId: string, session: GroupSession, now: number): boolean {
    return this.large(session) && (this.isHub(groupId) || this.hubs(groupId, session, now).length > 0);
  }

  /** A member admitted a moment ago, or the admin that admitted me: our edge stays a while, hubs or not. */
  met(groupId: string, key: string, now: number): void { this.get(groupId, now).met.set(key, now + this.timings.keepMetMs); }

  /**
   * A commit took these members out. Their edges close a little later, not at once: as a hub, the commit that tells
   * them is passed on after the session applied it, and nobody else may have an edge with them.
   */
  removed(groupId: string, keys: string[], now: number): void {
    const live = this.live.get(groupId);
    if (live) for (const key of keys) live.gone.set(key, now + GONE_LINGER_MS);
  }

  /** An edge `Groups` opens now should look fast for the other side (it asked me, or I asked it). */
  takeExpect(groupId: string, key: string): boolean { return !!this.live.get(groupId)?.expect.delete(key); }

  /**
   * The members this device keeps edges with, or null for every member (the full mesh: a group of 16 or fewer, no hub
   * anywhere, or an app without hubs). With hubs, a hub keeps an edge with every member; a member with its hubs. The
   * admin keeps edges with members whose apps take no hubs too (they would wait for a message to ask for the secret a
   * hub cannot seal for them).
   */
  wanted(groupId: string, session: GroupSession, group: StoredGroup, now: number): Set<string> | null {
    if (session.status !== "active" || !this.large(session)) return null;
    const live = this.get(groupId, now), me = session.myKey;
    this.prime(live, group, now);
    const out = new Set<string>();
    for (const [key, until] of live.met) if (until > now) out.add(key); else live.met.delete(key);
    const legacy = (group.legacy ?? []).filter(key => rosterHas(session.roster, key));
    if (!live.firstRead && now - live.started < this.timings.firstReadMs) {
      // Before the first reading of the beacon: the edges there are, whom I just met and the hubs I used last; nothing
      // closed (the group just grew past the threshold), and not every other edge opened at once (the app just started).
      for (const key of [...this.host.edges(groupId).keys(), ...group.hubs ?? []]) out.add(key);
    } else {
      const hubs = this.hubs(groupId, session, now);
      if (!live.hub && !hubs.length) { live.wantedSize = session.others.length; return null; }
      if (live.hub) {
        // A hub is there for everyone: an edge with every member, as in a full mesh. A member that has not read the
        // beacon (its relays' budget spent on the edges of a full mesh) still reaches it, and learns from it that it is
        // one (`group-reach`). The lobby only makes it look fast for those that asked.
        for (const key of session.others) out.add(key);
      } else if (!live.myHubs.length) {
        // Hubs known, none picked yet (the epoch's secret, which the lobbies need, has not arrived): nothing closes,
        // and the known hubs are dialed, rather than being left with no edge at all.
        for (const key of [...this.host.edges(groupId).keys(), ...hubs]) out.add(key);
      } else {
        for (const key of live.myHubs) out.add(key);
        // An admin on an app without hubs cannot be reached through them for a leave (it drops `group-bye`).
        const admin = session.admin;
        if (admin && legacy.includes(admin)) out.add(admin);
      }
      if (session.isAdmin) for (const key of legacy) out.add(key);
    }
    out.delete(me);
    for (const key of [...out]) if (!rosterHas(session.roster, key)) out.delete(key);
    live.wantedSize = out.size;
    const edges = this.host.edges(groupId);
    for (const [key, until] of live.gone) if (until <= now) live.gone.delete(key); else if (edges.has(key)) out.add(key);
    return out;
  }

  /** Edges this member keeps in a group: what paces them (`meshEdgeIntervals`), not the roster. */
  edgeLoad(groupId: string, session: GroupSession): number {
    const live = this.live.get(groupId);
    return live && this.large(session) && live.wantedSize ? live.wantedSize + 1 : session.roster.length;
  }

  /**
   * Once a tick per large group: reads the beacon, elects me or steps me down, and as a hub reads my lobby, as a member
   * picks my hubs and asks them. True when what `wanted` says may have changed.
   */
  async tick(groupId: string, session: GroupSession, group: StoredGroup, now: number): Promise<boolean> {
    const live = this.get(groupId, now);
    if (session.status !== "active" || !this.large(session)) {
      const was = live.hub || live.myHubs.length > 0;
      if (live.hub) { live.hub = false; await this.publish(groupId, session, live, now, false).catch(() => {}); }
      live.myHubs = []; live.members.clear();
      return was;
    }
    const rv = session.rendezvous;
    if (!rv) return false;
    live.me = session.myKey;
    this.prime(live, group, now);
    const before = this.shape(live);
    if (live.epoch !== session.epoch) {
      // A commit moved the beacon: read the new one now, and as a hub say so there at once.
      live.epoch = session.epoch; live.lastRead = 0; live.lastWrite = 0; live.lastTry = 0; live.beacon = [];
      live.clocks.restart();
    }
    const policy = session.hubPolicy, me = session.myKey, inRoster = (key: string) => rosterHas(session.roster, key);
    const may = mayBeHub(me, policy, inRoster, this.staysOnline);
    const readEvery = live.hub || may ? this.timings.beaconEveryMs : this.timings.beaconReadMs;
    if (!live.lastRead || now - live.lastRead >= readEvery) await this.read(groupId, session, live, now);
    const others = meshHubs(live.beacon, me, policy, inRoster, now);
    // A hub keeps an edge with every member: on an app with a budget of connections (a Mac's WKWebView opens about 46
    // in all), only while that fits beside its other groups. Pinned or not: past the budget, a call would not connect.
    const fits = this.fits(groupId, session);
    if (live.hub) live.need = session.others.length;
    if (!live.hub && may && fits && (policy.pin.includes(me) || others.length < MESH_HUBS.maxHubs)) {
      live.hub = true; live.hubSince = now; live.myHubs = []; live.need = session.others.length;
      await this.publish(groupId, session, live, now, true).catch(() => {});
    } else if (live.hub && (!may || !fits)) {
      live.hub = false; live.members.clear();
      await this.publish(groupId, session, live, now, false).catch(() => {});
    } else if (live.hub && now - live.lastTry >= 5_000 && (now - live.lastWrite >= this.timings.beaconEveryMs || !live.beacon.some(h => h.key === me))) {
      await this.publish(groupId, session, live, now, true).catch(() => {});
    }
    if (live.hub) {
      await this.serve(groupId, session, live, now, rv);
      // Where a hub's edges go after a restart, before it reads the beacon: the other hubs.
      const hubs = others.map(h => h.key).sort();
      if (hubs.length && (group.hubs ?? []).join() !== hubs.join()) { group.hubs = hubs; this.groups.save(group); }
    } else await this.pick(groupId, session, group, live, now, rv);
    return before !== this.shape(live);
  }

  private shape(live: HubLive): string { return `${live.hub}|${live.myHubs.join(",")}|${[...live.members.keys()].sort().join(",")}|${live.beacon.map(h => h.key).sort().join(",")}`; }

  private async read(groupId: string, session: GroupSession, live: HubLive, now: number): Promise<void> {
    live.lastRead = now;
    const keys = beaconKeys(session.rendezvous!, groupId);
    // Nothing there (no hub has written it yet) is a reading; a request that failed (the relays' budget) is not.
    let records: GhostRecord[] | null;
    try { records = await this.host.resolve(keys.identity.pubKeyZ32, true); } catch { return; }
    live.beacon = live.clocks.inMyTime(readBeacon(keys, records ?? []), now);
    live.firstRead = true;
    this.noteHubs(live, session, now);
  }

  private noteHubs(live: HubLive, session: GroupSession, now: number): void {
    for (const h of meshHubs(live.beacon, session.myKey, session.hubPolicy, key => rosterHas(session.roster, key), now)) live.seenHubs.set(h.key, now);
    for (const [key, at] of live.seenHubs) if (now - at > this.timings.graceMs || !rosterHas(session.roster, key)) live.seenHubs.delete(key);
  }

  /** My entry in the beacon (or none, stepping down), merged with the other fresh hubs I do not drop. */
  private async publish(groupId: string, session: GroupSession, live: HubLive, now: number, listed: boolean): Promise<void> {
    const rv = session.rendezvous;
    if (!rv) return;
    live.lastTry = now;
    const keys = beaconKeys(rv, groupId);
    let existing = live.beacon;
    if (live.lastRead !== now) {
      let records: GhostRecord[] | null;
      try { records = await this.host.resolve(keys.identity.pubKeyZ32, true); } catch { return; }
      existing = live.clocks.inMyTime(readBeacon(keys, records ?? []), now);
    }
    const policy = session.hubPolicy;
    const hubs = mergeBeacon(existing, session.myKey, listed ? { key: session.myKey, ts: now, load: live.members.size, since: live.hubSince || now } : null, now,
      key => rosterHas(session.roster, key) && !policy.no.includes(key));
    // Each entry as its hub dated it: no hub's entry is dated by another's clock.
    await this.host.publish(keys.identity, beaconRecords(keys, live.clocks.asWritten(hubs)), true);
    live.beacon = hubs; live.lastWrite = now; live.lastRead = now; live.firstRead = true;
    this.noteHubs(live, session, now);
  }

  /** As a hub: who asked in my lobby, and which of my members are still around. */
  private async serve(groupId: string, session: GroupSession, live: HubLive, now: number, rv: string): Promise<void> {
    const edges = this.host.edges(groupId);
    // An edge up is a member of mine, whoever opened it: the full mesh I was part of before hubs, a member back.
    const hubs = new Set(this.hubs(groupId, session, now));
    for (const [key, id] of edges) if (!hubs.has(key) && rosterHas(session.roster, key) && this.host.linkReady(id)) live.members.set(key, now);
    for (const [key, since] of live.members) {
      const id = edges.get(key);
      if (!rosterHas(session.roster, key)) live.members.delete(key);
      else if (id && this.host.linkReady(id)) live.members.set(key, now);
      else if (now - since > this.timings.memberGoneMs) live.members.delete(key);
    }
    const every = now < live.lobbyBusyUntil ? this.timings.lobbyPollMs : this.timings.lobbyIdlePollMs;
    if (now - live.lastLobbyPoll >= every) {
      live.lastLobbyPoll = now;
      const keys = lobbyKeys(rv, groupId, session.myKey);
      const entries = readLobby(keys, (await this.host.resolve(keys.identity.pubKeyZ32, true).catch(() => null)) ?? []);
      for (const { key, ts } of entries) {
        // Only members: someone removed, or a key the roster never had, is nobody's member here.
        if (now - ts > COMMUNITY_TOPOLOGY.lobbyFreshMs || key === session.myKey || !rosterHas(session.roster, key)) continue;
        if (!live.members.has(key)) {
          live.lobbyBusyUntil = now + this.timings.lobbyBusyMs;
          live.expect.add(key);
          const id = edges.get(key);
          if (id && !this.host.linkReady(id)) this.host.expectPeer?.(id);
        }
        live.members.set(key, Math.max(live.members.get(key) ?? 0, now));
      }
    }
    this.sayReach(groupId, session, live, now);
  }

  /** As a member: keep the hubs that took me, replace those that did not or went, and ask the ones not up yet. */
  private async pick(groupId: string, session: GroupSession, group: StoredGroup, live: HubLive, now: number, rv: string): Promise<void> {
    const edges = this.host.edges(groupId), me = session.myKey;
    const hubs = new Set(this.hubs(groupId, session, now));
    for (const [key, until] of live.avoided) if (until <= now) live.avoided.delete(key);
    for (const key of live.myHubs) {
      const id = edges.get(key);
      if (id && this.host.linkReady(id)) { live.hubWaits.delete(key); live.hubsUp.add(key); continue; }
      // Up, then down: its app closed. Another at once.
      if (live.hubsUp.delete(key)) { live.avoided.set(key, now + 2 * this.timings.hubWaitMs); live.hubWaits.delete(key); continue; }
      const since = live.hubWaits.get(key) ?? now;
      live.hubWaits.set(key, since);
      if (now - since > this.timings.hubWaitMs) { live.avoided.set(key, now + 2 * this.timings.hubWaitMs); live.hubWaits.delete(key); }
    }
    const fresh = meshHubs(live.beacon, me, session.hubPolicy, key => rosterHas(session.roster, key), now);
    // Hubs only seen a moment ago are candidates too (a reading missed them), after the fresh ones.
    const candidates: Hub[] = [...fresh, ...[...hubs].filter(key => !fresh.some(h => h.key === key)).map(key => ({ key, ts: 0, load: 0 }))];
    const kept = live.myHubs.filter(key => hubs.has(key) && !live.avoided.has(key));
    for (const key of pickMeshHubs(me, candidates, now, new Set(live.avoided.keys()))) if (kept.length < MESH_HUBS.hubsPerMember && !kept.includes(key)) kept.push(key);
    // Every hub avoided: the least bad ones rather than none, while there are hubs.
    if (!kept.length) kept.push(...pickMeshHubs(me, candidates, now));
    if (kept.join() !== live.myHubs.join()) {
      live.myHubs = kept;
      for (const [key] of live.hubsUp) if (!kept.includes(key)) live.hubsUp.delete(key);
      if (kept.length && (group.hubs ?? []).join() !== kept.join()) { group.hubs = kept; this.groups.save(group); }
    }
    for (const hub of kept) {
      const id = edges.get(hub);
      if (id && this.host.linkReady(id)) continue;
      if (now - (live.lobbyWrites.get(hub) ?? 0) < this.timings.lobbyWriteMs) continue;
      live.lobbyWrites.set(hub, now);
      if (!id) live.expect.add(hub); else this.host.expectPeer?.(id);
      const keys = lobbyKeys(rv, groupId, hub);
      try {
        const existing = readLobby(keys, (await this.host.resolve(keys.identity.pubKeyZ32, true)) ?? []);
        // Dated by the hub's clock, where mine differs: the hub reads its lobby by its own, and so do the members that write there.
        const theirs = now - live.clocks.ahead(hub);
        await this.host.publish(keys.identity, lobbyRecords(keys, mergeLobby(existing, { key: me, ts: theirs }, theirs)), true);
      } catch { live.lobbyWrites.delete(hub); }
    }
  }

  /** As a hub: whom I reach, to my edges, when it changed (at most every `reachEveryMs`), or to one edge that just opened. */
  private sayReach(groupId: string, session: GroupSession, live: HubLive, now: number, only?: string): void {
    const edges = this.host.edges(groupId);
    const up = [...edges].filter(([key, id]) => rosterHas(session.roster, key) && this.host.linkReady(id)).map(([key]) => key).sort();
    const said = up.join(",");
    // Said when it changed (at most every `reachEveryMs`), and once a minute anyway: it is also how members that could
    // not read the beacon know I am a hub.
    if (!only && ((said === live.sentReach && now - live.lastReach < REACH_AGAIN_MS) || now - live.lastReach < this.timings.reachEveryMs)) return;
    if (!only) { live.sentReach = said; live.lastReach = now; }
    const legacy = this.legacyOf(groupId);
    const frame: GroupReachFrame = { t: "group-reach", g: groupId, k: up, ...(legacy.length ? { l: legacy } : {}) };
    for (const [key, id] of edges) {
      if ((only && key !== only) || !rosterHas(session.roster, key) || !this.host.linkReady(id)) continue;
      try { this.host.sendOnLink(id, frame); } catch { /* closing */ }
    }
  }
  private legacyOf(groupId: string): string[] { return this.groups.stored(groupId)?.legacy ?? []; }

  /**
   * An edge came up: as a hub, the member counts as mine and hears whom I reach. `hubs`: its app takes part in hubs
   * (`paired-groups` 4); one that does not is recorded, so hubs keep edges with it. True when `group` changed.
   */
  edgeReady(groupId: string, session: GroupSession, group: StoredGroup, key: string, hubs: boolean, now: number): boolean {
    let changed = false;
    const legacy = new Set(group.legacy ?? []);
    if (!hubs && !legacy.has(key)) { legacy.add(key); changed = true; }
    if (hubs && legacy.delete(key)) changed = true;
    if (changed) group.legacy = [...legacy].sort();
    const live = this.live.get(groupId);
    if (live?.hub && this.large(session)) {
      if (!this.hubs(groupId, session, now).includes(key)) live.members.set(key, now);
      this.sayReach(groupId, session, live, now, key);
      // Reactions are in no log: what I passed on lately, again, to a member back (it keeps the newest of each).
      const id = this.host.edges(groupId).get(key);
      if (id) for (const frame of live.reactions.values()) if (frame.k !== key && rosterHas(session.roster, frame.k)) { try { this.host.sendOnLink(id, frame); } catch { break; } }
    }
    return changed;
  }

  /**
   * As a hub, a member's signed reaction goes on to my other edges, the first time I see that number from that member
   * for that message; and it is kept (the latest `REACTIONS_KEPT`) for members whose edge opens later.
   */
  passReaction(groupId: string, session: GroupSession, from: string, frame: GroupReactedFrame): void {
    const live = this.live.get(groupId);
    if (!live?.hub) return;
    const at = `${frame.k} ${frame.id}`, held = live.reactions.get(at);
    if (held && held.n >= frame.n) return;
    live.reactions.delete(at);
    live.reactions.set(at, frame);
    while (live.reactions.size > REACTIONS_KEPT) live.reactions.delete(live.reactions.keys().next().value!);
    for (const [key, id] of this.host.edges(groupId)) {
      if (key === from || key === frame.k || !rosterHas(session.roster, key) || !this.host.linkReady(id)) continue;
      try { this.host.sendOnLink(id, frame); } catch { /* closing */ }
    }
  }

  /** What a hub says it reaches, and which members' apps take no hubs (kept, so a new hub serves them too). True when `group` changed. */
  reached(groupId: string, session: GroupSession, group: StoredGroup, from: string, frame: Record<string, unknown>, now: number): boolean {
    if (!rosterHas(session.roster, from) || !Array.isArray(frame.k) || frame.k.length > session.roster.length) return false;
    const live = this.get(groupId, now);
    live.reach.set(from, new Set(frame.k.filter((key): key is string => typeof key === "string" && rosterHas(session.roster, key))));
    // Only hubs say whom they reach: one that does is seen as a hub, as a reading of the beacon would (not one the admin excluded).
    if (!session.hubPolicy.no.includes(from) && from !== session.myKey) live.seenHubs.set(from, now);
    if (!Array.isArray(frame.l) || frame.l.length > session.roster.length) return false;
    const legacy = new Set(group.legacy ?? []);
    let changed = false;
    for (const key of frame.l) if (typeof key === "string" && key !== session.myKey && rosterHas(session.roster, key) && !legacy.has(key)) { legacy.add(key); changed = true; }
    if (changed) group.legacy = [...legacy].sort();
    return changed;
  }

  /** A member I have no edge with is reachable through a hub whose edge to me is up and that says it reaches them. */
  viaHub(groupId: string, session: GroupSession, key: string, now: number): boolean {
    const live = this.live.get(groupId);
    if (!live) return false;
    const edges = this.host.edges(groupId), hubs = new Set(this.hubs(groupId, session, now));
    for (const [hub, keys] of live.reach) {
      if (!hubs.has(hub)) continue;
      const id = edges.get(hub);
      if (keys.has(key) && id && this.host.linkReady(id)) return true;
    }
    return false;
  }

  /**
   * As a hub, what the session took for the first time goes on to every other edge that is up: not back where it came
   * from, nor to its author. Everyone else takes it as a frame handed on (WISP 9xx § Catch-up).
   */
  passOn(groupId: string, session: GroupSession, from: string, frames: GroupEdgeFrame[]): number {
    const live = this.live.get(groupId);
    if (!live?.hub || !frames.length) return 0;
    let sent = 0;
    for (const [key, id] of this.host.edges(groupId)) {
      if (key === from || !this.host.linkReady(id)) continue;
      // Someone just taken out hears the commit that says so, and nothing else.
      const member = rosterHas(session.roster, key);
      const until = member ? Infinity : removalEpoch(session.state.chain, key);
      for (const frame of frames) {
        if (authorOf(frame) === key || (!member && (frame.t !== "group-commit" || frame.commit.e > until))) continue;
        try { this.host.sendOnLink(id, frame); sent++; } catch { break; }
      }
    }
    return sent;
  }
}

/**
 * The epoch of the commit that took `key` out of the group for the last time: the one after the last roster it was
 * in. -1 for a key the chain never had. Someone out of the roster is sent no commit past it.
 */
export function removalEpoch(chain: readonly GroupCommit[], key: string): number {
  for (let e = chain.length - 1; e >= 0; e--) if (rosterHas(chain[e].m, key)) return e + 1;
  return -1;
}

function authorOf(frame: GroupEdgeFrame): string | undefined {
  switch (frame.t) {
    case "group-msg": case "group-edit": return frame.s;
    case "group-bye": return frame.k;
    case "group-commit": return frame.commit.by;
    case "group-meta": return frame.by;
    default: return undefined;
  }
}
