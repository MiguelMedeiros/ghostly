import {
  COMMUNITY_LIMITS, COMMUNITY_TOPOLOGY, CommunitySession, GROUP_READ_NOTE_COMMUNITY, KNOCK_TTL_MS, MEMBER_KEY,
  beaconKeys, beaconRecords, createIdentity, decodeCommunityLink, doorHubs, publicKeyFromZ32, encodeCommunityLink, freshHubs, identityFromSeedB64, knockIdentity, knockRecords, lobbyKeys, lobbyRecords, mergeBeacon,
  mergeKnocks, mergeLobby, pickHubs, rankHubs, readBeacon, readKnocks, readLobby, rosterHas, shouldBeHub,
  type CommunityFrame, type CommunityState, type GroupEntryLink, type Hub, type Roster,
} from "@ghostly/core";
import type { GroupEvent, GroupJoinStage, GroupView, StoredGroup, StoredMessage } from "../shared/types";
import type { GroupStore, GroupsHost } from "./groups";

/**
 * Community groups (`group-community/1`, WISP 9xx · Group Community): a link anyone can open, any
 * member lets people in, and online members elect a few hubs through a sealed Pkarr beacon. A hub
 * keeps edges with other hubs and with the members that asked it in its lobby, and relays; a
 * member keeps edges with one or two hubs. Membership, keys and catch-up are `CommunitySession`'s;
 * this class decides which edges exist, who answers knocks and who commits leaves.
 */
export interface CommunityTimings {
  /** How often the beacon is read, a hub's lobby polled and knocks looked at. */
  beaconReadMs: number;
  lobbyPollMs: number;
  lobbyWriteMs: number;
  knockPollMs: number;
  knockMs: number;
  slowKnockMs: number;
  patienceMs: number;
  /** A hub with no members this long steps down, when enough other hubs remain. */
  idleHubMs: number;
  /** An edge to a member that is down this long is dropped by its hub. */
  memberGoneMs: number;
  /** A knock nobody answered this long is answered by the next hub in rank, then by any. */
  knockFallbackMs: number;
  /** Upper bound of the random wait before becoming a hub. */
  hubJitterMs: number;
  /** A hub that has not opened my edge this long is avoided for a while. */
  hubWaitMs: number;
}
export const COMMUNITY_TIMINGS: CommunityTimings = {
  beaconReadMs: 10_000, lobbyPollMs: 3_000, lobbyWriteMs: 5_000, knockPollMs: 1_250, knockMs: 5_000, slowKnockMs: 20_000, patienceMs: 2 * 60_000,
  idleHubMs: 60_000, memberGoneMs: 60_000, knockFallbackMs: 30_000, hubJitterMs: 3_000, hubWaitMs: 20_000,
};

/**
 * Knocks are spread over a few Pkarr records (a joiner's shard follows from its key), so a crowd
 * opening the link at once is not six at a time; hubs read one shard per knock poll, in turn.
 */
export const KNOCK_SHARDS = 4;
const knockShard = (link: GroupEntryLink, key: string): GroupEntryLink => ({ g: `${link.g}.${publicKeyFromZ32(key)[0] % KNOCK_SHARDS}`, host: link.host });
const MAX_PENDING_ENTRIES = 8;
const ENTRY_TIMEOUT_MS = 3 * 60_000;
const ENTRY_UNANSWERED_MS = 90_000;
/**
 * Each attempt to let one joiner in belongs to one hub for this long (see `answerKnocks`): it opens
 * the entry session in the first `KNOCK_SLOT_OPEN_MS` and gives up after `ENTRY_UNANSWERED_MS`,
 * before the turn ends. A paired session over Pkarr can take the better part of a minute to come up.
 */
const KNOCK_SLOT_MS = 2 * 60_000;
const KNOCK_SLOT_OPEN_MS = 20_000;
/** How long a hub missing from the beacon still counts as one for the edges already up. */
const HUB_GRACE_MS = 3 * 60_000;
const REFUSED_FOR_MS = 10 * 60_000;
const ENTRY_LINGER_MS = 20_000;
const RELAYED_KEPT = 4096;
const MESSAGE_LINK = (groupId: string) => `group:${groupId}`;

/** Per group, in memory: the topology as this device sees and plays it. */
interface Live {
  session: CommunitySession;
  hub: boolean;
  hubSince: number;
  beacon: Hub[];
  lastBeaconRead: number;
  lastBeaconWrite: number;
  hubCandidateAt: number;
  /** As a hub: members I keep edges with → when their edge was last up (or they asked). */
  members: Map<string, number>;
  emptySince: number;
  lastLobbyPoll: number;
  /** As a member: the hubs I want, and when I last wrote in each one's lobby. */
  myHubs: string[];
  lobbyWrites: Map<string, number>;
  lastKnockPoll: number;
  /** Joiners with an entry session open: key → since; knocks first seen: key → when, and with which hubs at the door. */
  pendingEntries: Map<string, number>;
  knocksSeen: Map<string, { first: number; doors: string; changed?: boolean }>;
  knockShard?: number;
  /** As a member: when I started waiting for each hub, and hubs that did not take me (until when). */
  hubWaits: Map<string, number>;
  hubsAvoided: Map<string, number>;
  /** Hubs whose edge has been up: when it drops, the hub is gone. */
  hubsUp: Set<string>;
  /** Entry sessions kept open a little after the welcome went: link id → until. */
  lingering: Map<string, number>;
  lastRoster: Roster;
  lastStatus: string;
  relayed: Set<string>;
  lastTick?: number;
  forceHub?: boolean;
  lastCatchUp?: number;
  /** Hubs as last seen in the beacon: an edge to one stays while it is up, even if a reading of the beacon missed it. */
  seenHubs: Map<string, number>;
}

export class Communities {
  private readonly stored = new Map<string, StoredGroup>();
  private readonly live = new Map<string, Live>();
  private readonly lastMessageAt = new Map<string, number>();
  private readonly refused = new Map<string, number>();
  private readonly lastKnock = new Map<string, number>();
  constructor(private readonly host: GroupsHost, private readonly store: GroupStore, private readonly timings: CommunityTimings = COMMUNITY_TIMINGS, private readonly random: () => number = Math.random) {}

  /** The clock: the last tick's time (the engine ticks every second), so every decision reads one clock. */
  private time = 0;
  private now(): number { return this.time || Date.now(); }

  has(groupId: string): boolean { return this.stored.has(groupId); }
  session(groupId: string): CommunitySession | undefined { return this.live.get(groupId)?.session; }
  /** Is this device a hub of the group? (tests and the load harness) */
  isHub(groupId: string): boolean { return !!this.live.get(groupId)?.hub; }

  async load(groups: StoredGroup[]): Promise<void> {
    for (const group of groups) {
      this.stored.set(group.id, group);
      if (group.community) this.attach(group.community);
      const history = await this.store.getMessages(MESSAGE_LINK(group.id)), last = history[history.length - 1];
      if (last) this.lastMessageAt.set(group.id, last.timestamp);
      // Admissions in flight did not survive the restart; a joiner keeps its side.
      for (const [, linkId] of this.host.entries(group.id)) if (group.joining?.linkId !== linkId) await this.host.closeEdge(linkId);
    }
  }

  views(): GroupView[] {
    return [...this.stored.values()].flatMap((group): GroupView[] => {
      const live = this.live.get(group.id);
      const base = { id: group.id, profile: "community" as const, createdAt: group.createdAt, lastMessageAt: this.lastMessageAt.get(group.id) ?? 0, invited: [], memberLinks: {} };
      if (group.joining && (!live || live.session.status === "lost")) {
        return [{ ...base, name: group.joining.name || live?.session.name || "", isAdmin: false, members: [], canSend: false,
          invitation: { linkId: group.joining.linkId, contact: "", admin: group.joining.inviter, members: 0, accepted: true, viaLink: true, stage: this.joinStage(group) } }];
      }
      if (!live) return [];
      const s = live.session, edges = this.host.edges(group.id);
      const ready = (key: string) => { const id = edges.get(key); return !!id && this.host.linkReady(id, 2); };
      const hubs = freshHubs(live.beacon, this.now()).map(h => h.key);
      return [{ ...base, name: s.name, status: s.status, statusReason: s.state.statusReason, epoch: s.epoch, myKey: s.myKey, isAdmin: s.isAdmin,
        ...(s.isMember && s.entryKey ? { entryLink: encodeCommunityLink({ g: s.id, host: s.entryKey }) } : {}),
        canSend: s.canSend,
        community: { hub: live.hub, hubs: hubs.length, connected: [...edges.keys()].filter(ready).length },
        members: s.roster.map(([key, role]) => ({ key, role, me: key === s.myKey,
          nick: key === s.myKey ? undefined : (edges.get(key) && this.host.edgeNick(edges.get(key)!)) || s.state.nicks[key],
          online: key === s.myKey || ready(key), missing: s.missing(key) })) }];
    });
  }

  messages(groupId: string): Promise<StoredMessage[]> { return this.store.getMessages(MESSAGE_LINK(groupId)); }

  /** How far a join through the link got, as the joiner's app knows it. */
  private joinStage(group: StoredGroup): GroupJoinStage {
    const joining = group.joining!;
    if (joining.inviter) return "admitted";
    if (this.host.linkReady(joining.linkId, 2) || this.host.linkSeen?.(joining.linkId)) return "answered";
    return this.lastKnock.has(group.id) ? "knocked" : "knocking";
  }

  // -- what the person does --------------------------------------------------------------------

  async create(name: string): Promise<string> {
    const state = CommunitySession.create(name);
    const group: StoredGroup = { id: state.id, createdAt: state.createdAt, community: state };
    await this.store.putGroup(group);
    this.stored.set(group.id, group);
    this.attach(state);
    await this.event(group.id, "created", `Group created. ${GROUP_READ_NOTE_COMMUNITY}`, state.createdAt, 0);
    this.host.emit();
    return group.id;
  }

  /** Opens a `group2/` link: a member key, an entry session toward the link's entry key, and knocks. */
  async joinByLink(code: string): Promise<string> {
    const link = decodeCommunityLink(code);
    if (!link) throw new Error("This is not a link to a group");
    const existing = this.stored.get(link.g);
    const live = this.live.get(link.g);
    if (live && live.session.status === "active") return link.g;
    if (existing?.joining && existing.joining.host === link.host) return link.g;
    if (existing) await this.forget(link.g);
    await this.startJoining(link, createIdentity().seedB64, this.now());
    return link.g;
  }

  private async startJoining(link: GroupEntryLink, seedB64: string, since: number): Promise<void> {
    const linkId = await this.host.openEntry(link, "guest", seedB64, link.host);
    const group: StoredGroup = this.stored.get(link.g) ?? { id: link.g, createdAt: since };
    group.joining = { g: link.g, host: link.host, seedB64, linkId, name: group.community?.name ?? "", inviter: "", pieces: [], since };
    this.stored.set(link.g, group);
    await this.store.putGroup(group);
    this.host.emit();
    void this.knock(group, since).catch(() => {});
  }

  async send(groupId: string, text: string): Promise<{ error: string | null }> {
    const live = this.live.get(groupId);
    if (!live) return { error: "You are not in this group yet" };
    const result = await live.session.sendText(text, this.host.myNick?.());
    return "error" in result ? { error: result.error } : { error: null };
  }

  /**
   * Leaves: the request goes to the hubs, which keep it and commit it (any member can), and the
   * group goes from this device at once. An admin hands the role to a member first. Something must
   * be connected to carry the request.
   */
  async leave(groupId: string): Promise<void> {
    const live = this.live.get(groupId);
    if (!live) return this.forget(groupId);
    const s = live.session;
    if (s.status !== "active" || s.others.length === 0) return this.forget(groupId);
    const edges = [...this.host.edges(groupId).entries()].filter(([, id]) => this.host.linkReady(id, 2));
    if (!edges.length) throw new Error("Nobody in the group is connected right now to take your leave. Try again in a moment.");
    if (s.isAdmin) {
      const connected = new Set(edges.map(([key]) => key));
      const next = s.others.find(key => connected.has(key)) ?? s.others[0];
      await s.transferAdmin(next);
    }
    await s.leave();
    await this.forget(groupId);
  }

  successor(groupId: string): string | undefined {
    const s = this.live.get(groupId)?.session;
    if (!s) return undefined;
    const edges = this.host.edges(groupId);
    return s.others.find(key => { const id = edges.get(key); return !!id && this.host.linkReady(id, 2); }) ?? s.others[0];
  }

  async remove(groupId: string, key: string): Promise<void> { await this.require(groupId).remove(key); }
  async makeAdmin(groupId: string, key: string): Promise<void> { await this.require(groupId).transferAdmin(key); }
  async rotate(groupId: string): Promise<void> { await this.require(groupId).rotate(); }
  /** A new link (the old one reaches nobody), or none. */
  async replaceLink(groupId: string, off = false): Promise<string> {
    const s = this.require(groupId);
    if (!s.isAdmin) throw new Error("Only the admin can replace or turn off the group's link");
    await this.closeEntries(groupId);
    const key = await s.replaceLink(off);
    return key ? encodeCommunityLink({ g: groupId, host: key }) : "";
  }
  entryLink(groupId: string): string {
    const s = this.require(groupId);
    return s.entryKey ? encodeCommunityLink({ g: groupId, host: s.entryKey }) : "";
  }

  async forget(groupId: string): Promise<void> {
    const live = this.live.get(groupId);
    if (live?.hub) await this.publishBeacon(groupId, live, this.now(), false).catch(() => {});
    this.live.delete(groupId);
    this.stored.delete(groupId);
    this.lastMessageAt.delete(groupId);
    for (const linkId of [...this.host.edges(groupId).values(), ...this.host.entries(groupId).values()]) await this.host.closeEdge(linkId);
    await this.store.deleteGroup(groupId);
    this.host.emit();
  }

  private require(groupId: string): CommunitySession {
    const s = this.live.get(groupId)?.session;
    if (!s) throw new Error("Group not found");
    return s;
  }

  // -- the topology --------------------------------------------------------------------------

  /** Everything timed: beacon, hub election, lobbies, knocks, leaves, edges. The engine calls it every second or so. */
  async tick(now = Date.now()): Promise<void> {
    this.time = now;
    for (const group of [...this.stored.values()]) {
      const live = this.live.get(group.id);
      if (group.joining && (!live || live.session.status === "lost")) {
        const waited = now - group.joining.since, every = waited > this.timings.patienceMs ? this.timings.slowKnockMs : this.timings.knockMs;
        // Knocking stops as soon as a member's side of the entry session is seen, before it is up: that one is answering.
        if (!this.host.linkReady(group.joining.linkId, 2) && !this.host.linkSeen?.(group.joining.linkId) && now - (this.lastKnock.get(group.id) ?? 0) >= every) await this.knock(group, now).catch(() => {});
        if (!live) continue;
      }
      if (!live) continue;
      if (live.session.status === "lost" && !group.joining) {
        // My admission lost a race: I am nobody's hub and nobody's door any more; I knock again with
        // the same key, and whoever is there lets me in.
        if (live.hub) { live.hub = false; await this.publishBeacon(group.id, live, now, false).catch(() => {}); }
        await this.closeEntries(group.id);
        await this.startJoining({ g: group.id, host: live.session.entryKey }, live.session.state.seedB64, now);
        continue;
      }
      if (live.session.status !== "active") { await this.reconcile(group.id, live, now); continue; }
      await this.topology(group.id, live, now).catch(() => {});
    }
    for (const [key, until] of this.refused) if (until <= now) this.refused.delete(key);
  }

  private async topology(groupId: string, live: Live, now: number): Promise<void> {
    const s = live.session, me = s.myKey;
    live.lastTick = now;
    for (const [linkId, until] of live.lingering) if (now >= until) { live.lingering.delete(linkId); if ([...this.host.entries(groupId).values()].includes(linkId)) await this.host.closeEdge(linkId); }
    if (now - live.lastBeaconRead >= this.timings.beaconReadMs || live.lastBeaconRead === 0) await this.readBeacon(groupId, live, now);
    const others = freshHubs(live.beacon, now).filter(h => h.key !== me);
    if (!live.hub) {
      const want = () => shouldBeHub(me, live.beacon, now) || (!!live.forceHub && freshHubs(live.beacon, now).length < COMMUNITY_TOPOLOGY.maxHubs);
      if (want()) {
        if (!live.hubCandidateAt) live.hubCandidateAt = now + Math.floor(this.random() * this.timings.hubJitterMs);
        else if (now >= live.hubCandidateAt) {
          live.hubCandidateAt = 0;
          await this.readBeacon(groupId, live, now);
          if (want()) { live.forceHub = false; live.hub = true; live.hubSince = now; live.emptySince = now; await this.publishBeacon(groupId, live, now, true); }
        }
      } else live.hubCandidateAt = 0;
    }
    if (live.hub) {
      const load = this.hubLoad(groupId, live, now);
      if (load > 0) live.emptySince = now;
      // Stay listed; step down when idle and others can carry the group.
      // Idle, and the others can carry the group: step down. Not a hub cut off from every other hub,
      // which would only come back as one (and lose its turns at the door each time).
      const linkedToHub = [...this.host.edges(groupId)].some(([key, id]) => this.peerIsHub(live, key) && this.host.linkReady(id, 2));
      if (now - live.emptySince > this.timings.idleHubMs && others.length >= COMMUNITY_TOPOLOGY.minHubs && now - live.hubSince > this.timings.idleHubMs && linkedToHub) {
        live.hub = false;
        // No longer at the door: admissions in flight are closed, so they do not collide with the next door's.
        await this.closeEntries(groupId);
        await this.publishBeacon(groupId, live, now, false);
      } else if (now - live.lastBeaconWrite >= COMMUNITY_TOPOLOGY.beaconEveryMs || !live.beacon.some(h => h.key === me)
        // A load that moved much (or filled up) is said at once, so members stop asking a full hub.
        || (now - live.lastBeaconWrite >= 5_000 && Math.abs(load - (live.beacon.find(h => h.key === me)?.load ?? load)) >= 8)) {
        await this.publishBeacon(groupId, live, now, true);
      }
    }
    if (live.hub) {
      if (now - live.lastLobbyPoll >= this.timings.lobbyPollMs) { live.lastLobbyPoll = now; await this.pollLobby(groupId, live, now); }
      if (now - live.lastKnockPoll >= this.timings.knockPollMs) { live.lastKnockPoll = now; await this.answerKnocks(groupId, live, now); }
      await this.commitLeaves(live, others.map(h => h.key), now);
    } else {
      // A member: stick with hubs that are up and listed, fill up with the least loaded.
      const edges = this.host.edges(groupId);
      const fresh = new Set(others.map(h => h.key));
      for (const [key, until] of live.hubsAvoided) if (until <= now) live.hubsAvoided.delete(key);
      // A hub that has not taken me after a while is full, or gone: another one, or I become one. One
      // whose edge was up and dropped is gone now (its app closed): another one at once.
      for (const key of live.myHubs) {
        const id = edges.get(key);
        if (id && this.host.linkReady(id, 2)) { live.hubWaits.delete(key); live.hubsUp.add(key); continue; }
        if (live.hubsUp.delete(key)) { live.hubsAvoided.set(key, now + 2 * this.timings.hubWaitMs); live.hubWaits.delete(key); continue; }
        const since = live.hubWaits.get(key) ?? now;
        live.hubWaits.set(key, since);
        if (now - since > this.timings.hubWaitMs) { live.hubsAvoided.set(key, now + 2 * this.timings.hubWaitMs); live.hubWaits.delete(key); }
      }
      let kept = live.myHubs.filter(key => (fresh.has(key) || this.recentHub(live, key)) && !live.hubsAvoided.has(key));
      kept = kept.slice(0, COMMUNITY_TOPOLOGY.hubsPerMember);
      const picked = pickHubs(me, others, now, new Set(live.hubsAvoided.keys()));
      for (const key of picked) if (kept.length < Math.max(1, picked.length) && !kept.includes(key)) kept.push(key);
      live.myHubs = kept;
      // Every hub I know is full or will not take me: I carry myself, if the beacon has room.
      live.forceHub = !kept.length && others.length < COMMUNITY_TOPOLOGY.maxHubs;
      for (const hub of kept) {
        const id = edges.get(hub);
        if (id && this.host.linkReady(id, 2)) continue;
        if (now - (live.lobbyWrites.get(hub) ?? 0) >= this.timings.lobbyWriteMs) { live.lobbyWrites.set(hub, now); await this.askHub(groupId, live, hub, now).catch(() => {}); }
      }
    }
    for (const [key, since] of live.pendingEntries) {
      const linkId = this.host.entries(groupId).get(key), up = !!linkId && this.host.linkReady(linkId, 2);
      // Nobody came (the joiner got in elsewhere, or left): dropped. Came and did not finish: not answered for a while.
      if (!up && now - since > ENTRY_UNANSWERED_MS) live.pendingEntries.delete(key);
      else if (now - since > ENTRY_TIMEOUT_MS) { live.pendingEntries.delete(key); this.refused.set(key, now + REFUSED_FOR_MS); }
      else continue;
      if (linkId) await this.host.closeEdge(linkId);
    }
    // Missing a secret or waiting on an epoch: ask whoever I am connected to, now and then, until it
    // comes. And every half minute anyway: a commit or a message that went by while an edge was
    // down leaves nothing waiting here to ask about, and the other side's sync says what it has.
    if ((s.needsCatchUp && now - (live.lastCatchUp ?? 0) >= 5_000) || now - (live.lastCatchUp ?? 0) >= 30_000) {
      live.lastCatchUp = now;
      const ready = [...this.host.edges(groupId)].filter(([, id]) => this.host.linkReady(id, 2)).map(([key]) => key);
      for (const key of ready.slice(0, 3)) s.catchUp(key);
    }
    await this.reconcile(groupId, live, now);
  }

  private hubLoad(groupId: string, live: Live, now: number): number {
    const edges = this.host.edges(groupId);
    for (const [key, since] of live.members) {
      const id = edges.get(key);
      if (id && this.host.linkReady(id, 2)) live.members.set(key, now);
      else if (now - since > this.timings.memberGoneMs || live.session.wasRemoved(key)) live.members.delete(key);
    }
    return live.members.size;
  }

  private async readBeacon(groupId: string, live: Live, now: number): Promise<void> {
    live.lastBeaconRead = now;
    const keys = beaconKeys(live.session.state.rv, groupId);
    const records = await this.host.resolve(keys.identity.pubKeyZ32).catch(() => null);
    // Hubs I do not know yet are members newer than my view of the roster: exactly whom I need to catch up.
    live.beacon = readBeacon(keys, records ?? []);
    this.noteHubs(live, now);
  }

  private async publishBeacon(groupId: string, live: Live, now: number, listed: boolean): Promise<void> {
    const keys = beaconKeys(live.session.state.rv, groupId);
    const existing = readBeacon(keys, (await this.host.resolve(keys.identity.pubKeyZ32).catch(() => null)) ?? []);
    // Nobody drops a hub it does not know: a member behind on the roster would erase newer ones.
    const hubs = mergeBeacon(existing, live.session.myKey, listed ? { key: live.session.myKey, ts: now, load: live.members.size, since: live.hubSince || now } : null, now, key => !live.session.wasRemoved(key));
    await this.host.publish(keys.identity, beaconRecords(keys, hubs));
    live.beacon = hubs;
    this.noteHubs(live, now);
    live.lastBeaconWrite = now; live.lastBeaconRead = now;
  }

  private noteHubs(live: Live, now: number): void {
    for (const h of freshHubs(live.beacon, now)) live.seenHubs.set(h.key, now);
    for (const [key, at] of live.seenHubs) if (now - at > HUB_GRACE_MS) live.seenHubs.delete(key);
  }
  private recentHub(live: Live, key: string): boolean { return this.now() - (live.seenHubs.get(key) ?? -Infinity) <= HUB_GRACE_MS; }

  /** A member asks a hub for an edge: its key in the hub's lobby, and its side of the edge started. */
  private async askHub(groupId: string, live: Live, hub: string, now: number): Promise<void> {
    const keys = lobbyKeys(live.session.state.rv, groupId, hub);
    const existing = readLobby(keys, (await this.host.resolve(keys.identity.pubKeyZ32)) ?? []);
    await this.host.publish(keys.identity, lobbyRecords(keys, mergeLobby(existing, { key: live.session.myKey, ts: now }, now)));
  }

  private async pollLobby(groupId: string, live: Live, now: number): Promise<void> {
    const keys = lobbyKeys(live.session.state.rv, groupId, live.session.myKey);
    const entries = readLobby(keys, (await this.host.resolve(keys.identity.pubKeyZ32).catch(() => null)) ?? []);
    for (const { key, ts } of entries) {
      // Anyone the chain did not take out: a member whose admission lost a race, or who is ahead of me on the
      // roster, needs the edge to find out. The session hands nothing to someone who is not a member.
      if (now - ts > COMMUNITY_TOPOLOGY.lobbyFreshMs || key === live.session.myKey || live.session.wasRemoved(key)) continue;
      // Someone is asking: not the moment to step down.
      live.emptySince = now;
      if (!live.members.has(key) && live.members.size >= COMMUNITY_TOPOLOGY.hubCapacity) continue;
      live.members.set(key, Math.max(live.members.get(key) ?? 0, now));
    }
  }

  /** Every edge I want exists, and no other: hubs to hubs and to their members, members to their hubs. */
  private async reconcile(groupId: string, live: Live, now: number): Promise<void> {
    const s = live.session, existing = this.host.edges(groupId);
    const wanted = new Set<string>();
    if (s.status === "active") {
      if (live.hub) {
        for (const h of freshHubs(live.beacon, now)) if (h.key !== s.myKey) wanted.add(h.key);
        for (const key of live.members.keys()) wanted.add(key);
      } else for (const key of live.myHubs) wanted.add(key);
      // An edge that is up stays while its other end still counts on it, or was a hub a moment ago:
      // one reading of the beacon that missed a hub must not cut the group in two.
      for (const [key, id] of existing) if (this.host.linkReady(id, 2) && (live.members.has(key) || this.recentHub(live, key))) wanted.add(key);
    }
    for (const [key, id] of existing) if (!wanted.has(key)) await this.host.closeEdge(id);
    for (const key of wanted) if (!existing.has(key) && key !== s.myKey) { try { await this.host.openEdge(s.state, key); } catch { /* next tick */ } }
  }

  private async answerKnocks(groupId: string, live: Live, now: number): Promise<void> {
    const s = live.session;
    if (!s.entryKey || !s.state.entry.seedB64 || s.roster.length >= COMMUNITY_LIMITS.members) return;
    const link = { g: groupId, host: s.entryKey };
    const shard = { g: `${groupId}.${(live.knockShard = ((live.knockShard ?? -1) + 1) % KNOCK_SHARDS)}`, host: link.host };
    const knocks = readKnocks(shard, (await this.host.resolve(knockIdentity(shard).pubKeyZ32).catch(() => null)) ?? []);
    // The hubs that take turns at the door: listed lately and settled, the same set for every hub that
    // reads the beacon (a closed app stays listed until its entry goes stale; a new hub waits a minute).
    const hubs = doorHubs(live.beacon, now);
    if (!hubs.includes(s.myKey)) return;
    const door = [...hubs].sort()[0];
    for (const { key, ts } of knocks) {
      if (now - ts > KNOCK_TTL_MS || this.refused.has(key) || live.pendingEntries.has(key) || key === link.host) continue;
      // Still knocking means still waiting: a joiner stops once its entry session is up. Only those count
      // for a fallback, and for a member of the roster (its welcome was lost), only well after its admission.
      const stillKnocking = now - ts < 2 * this.timings.slowKnockMs;
      if (rosterHas(s.roster, key)) {
        const added = [...s.state.chain].reverse().find(c => c.k === "add" && c.s === key)?.ts ?? 0;
        if (!stillKnocking || ts < added + this.timings.knockFallbackMs) continue;
      }
      // Turns count from when this knock was first seen with the current set of hubs at the door: when
      // that set changes (the door's app closed), the new door answers at once instead of waiting a turn.
      const doorSig = [...hubs].sort().join(","), seen = live.knocksSeen.get(key);
      const changed = !!seen && seen.doors !== doorSig;
      const first = seen && !changed ? seen.first : now;
      live.knocksSeen.set(key, { first, doors: doorSig, changed: changed || !!seen?.changed });
      // After a change of doors, the hub that was the door may still be letting this joiner in: only a
      // joiner still knocking (it stops once it sees a member's side) is answered again.
      if (live.knocksSeen.get(key)!.changed && now - ts > 15_000) continue;
      // One door: the hub with the lowest key answers, so admissions are one after the other and
      // rarely race. Two hubs answering one joiner at once would collide on the same entry session
      // (it derives from the link's entry key and the joiner's key, the same for every hub) and
      // neither would get through; so each attempt belongs to one hub, in turns of `KNOCK_SLOT_MS`:
      // the door first, then the others in the order they rank for this joiner, round again. A hub
      // opens only early in its turn and gives up before it ends, so turns never overlap.
      const waited = now - first, order = [door, ...rankHubs(key, hubs.filter(k => k !== door))];
      const turn = Math.floor(waited / KNOCK_SLOT_MS) % order.length, early = waited % KNOCK_SLOT_MS < KNOCK_SLOT_OPEN_MS;
      if (order[turn] !== s.myKey || !early || (waited >= KNOCK_SLOT_MS && !stillKnocking)) continue;
      if (live.pendingEntries.size >= MAX_PENDING_ENTRIES) break;
      live.pendingEntries.set(key, now);
      try { await this.host.openEntry(link, "host", s.state.entry.seedB64, key); } catch { live.pendingEntries.delete(key); }
    }
    for (const [key, { first }] of live.knocksSeen) if (now - first > 2 * KNOCK_TTL_MS) live.knocksSeen.delete(key);
  }

  /** Leave requests: the door commits them (see `answerKnocks`); any hub after a while. */
  private async commitLeaves(live: Live, otherHubs: string[], now: number): Promise<void> {
    const s = live.session;
    if (!s.state.pendingLeaves.length) return;
    const mine = [s.myKey, ...otherHubs].sort()[0] === s.myKey;
    const since = (live as Live & { leavesSince?: number }).leavesSince ??= now;
    if (mine || now - since > this.timings.knockFallbackMs) { await s.commitPendingLeaves(now); (live as Live & { leavesSince?: number }).leavesSince = undefined; }
  }

  private async knock(group: StoredGroup, now = this.now()): Promise<void> {
    const joining = group.joining!;
    this.lastKnock.set(group.id, now);
    const me = identityFromSeedB64(joining.seedB64).pubKeyZ32;
    const link = knockShard({ g: group.id, host: joining.host }, me), identity = knockIdentity(link);
    const existing = readKnocks(link, (await this.host.resolve(identity.pubKeyZ32)) ?? []);
    await this.host.publish(identity, knockRecords(link, mergeKnocks(existing, { key: me, ts: now }, now)));
  }

  private async closeEntries(groupId: string): Promise<void> {
    const live = this.live.get(groupId);
    live?.pendingEntries.clear();
    for (const linkId of this.host.entries(groupId).values()) await this.host.closeEdge(linkId);
  }

  // -- frames ----------------------------------------------------------------------------------

  /** An entry session of a community came up with groups v2 on both sides: the hub invites. */
  entryReady(groupId: string, linkId: string, peer: string): boolean {
    const live = this.live.get(groupId);
    if (!live?.pendingEntries.has(peer) || !live.session.isMember) return false;
    try { this.host.sendOnLink(linkId, live.session.inviteFrame()); } catch { /* it closed */ }
    return true;
  }

  /** Admission frames on an entry session (either side). */
  async handleEntryFrame(linkId: string, frame: Record<string, unknown>): Promise<void> {
    const g = typeof frame.g === "string" ? frame.g : "";
    const group = this.stored.get(g);
    if (!group) return;
    switch (frame.t) {
      case "group-invite": {
        const joining = group.joining;
        if (!joining || joining.linkId !== linkId || typeof frame.admin !== "string" || !MEMBER_KEY.test(frame.admin)) return;
        // One admission at a time on this session: a second member answering the same knock waits its turn.
        if (joining.inviter && joining.inviter !== frame.admin && this.now() - (joining.invitedAt ?? 0) < ENTRY_LINGER_MS) return;
        joining.invitedAt = this.now();
        joining.inviter = frame.admin;
        joining.name = typeof frame.name === "string" ? frame.name.slice(0, 48) : joining.name;
        joining.pieces = [];
        await this.store.putGroup(group);
        this.host.sendOnLink(linkId, { t: "group-accept", v: 2, g, key: identityFromSeedB64(joining.seedB64).pubKeyZ32 });
        this.host.emit();
        return;
      }
      case "group-accept": {
        const live = this.live.get(g);
        const peer = [...this.host.entries(g)].find(([, id]) => id === linkId)?.[0];
        if (!live || !peer || frame.key !== peer || !live.pendingEntries.has(peer)) return;
        let welcome;
        // Already in the roster (their welcome was lost): the welcome again, with nothing committed.
        try { welcome = rosterHas(live.session.roster, peer) ? await live.session.rewelcome(peer) : await live.session.admit(peer); }
        catch { live.pendingEntries.delete(peer); await this.host.closeEdge(linkId); return; }
        for (const piece of welcome) { try { this.host.sendOnLink(linkId, piece); } catch { /* the joiner knocks again */ } }
        live.pendingEntries.delete(peer);
        live.knocksSeen.delete(peer);
        live.lingering.set(linkId, this.now() + ENTRY_LINGER_MS);
        this.host.emit();
        return;
      }
      case "group-chain": {
        const joining = group.joining;
        if (!joining || joining.linkId !== linkId || !Array.isArray(frame.commits)) return;
        if (joining.pieces.length * COMMUNITY_LIMITS.chainPiece > COMMUNITY_LIMITS.chain) return;
        joining.pieces.push(frame);
        return;
      }
      case "group-welcome": {
        const joining = group.joining;
        if (!joining || joining.linkId !== linkId || !joining.inviter) return;
        const joined = CommunitySession.join({ g, host: joining.host }, joining.pieces, frame, joining.seedB64);
        if ("error" in joined) { joining.pieces = []; return; }
        const again = !!this.live.get(g);
        // Whatever entry sessions this device still ran for the group (as a door before it lost its place) go.
        for (const [, id] of this.host.entries(g)) if (id !== linkId) await this.host.closeEdge(id);
        const member: StoredGroup = { id: g, createdAt: group.createdAt, community: joined.state };
        this.stored.set(g, member);
        this.live.delete(g);
        this.attach(joined.state);
        // The member who let me in is a hub and its app is open: my first hub.
        const live = this.live.get(g)!;
        live.myHubs = [joining.inviter];
        live.seenHubs.set(joining.inviter, this.now());
        await this.store.putGroup(member);
        if (!again) await this.event(g, "joined", `You joined. ${GROUP_READ_NOTE_COMMUNITY}`, this.now(), joined.state.chain.length - 1);
        this.lastKnock.delete(g);
        await this.host.closeEdge(linkId);
        this.host.emit();
        return;
      }
      case "group-decline": {
        const live = this.live.get(g);
        const peer = [...this.host.entries(g)].find(([, id]) => id === linkId)?.[0];
        if (live && peer) { live.pendingEntries.delete(peer); await this.host.closeEdge(linkId); }
        return;
      }
    }
  }

  /** A frame on an edge, from the member it is pinned to: handled, then relayed on by a hub. */
  async handleEdgeFrame(groupId: string, peerKey: string, frame: unknown): Promise<void> {
    const live = this.live.get(groupId);
    if (!live || !frame || typeof frame !== "object") return;
    const f = frame as Record<string, unknown>;
    // Addressed to someone else: a hub routes it, whoever it is for.
    if ((f.t === "group-secret" || f.t === "group-entry") && typeof f.to === "string" && f.to !== live.session.myKey) {
      if (!live.hub) return;
      const id = `${String(f.t)}:${f.to}:${String(f.h ?? f.x)}`;
      if (!this.remember(live, id)) return;
      const edges = this.host.edges(groupId), direct = edges.get(f.to);
      if (direct && this.host.linkReady(direct, 2)) { this.sendTo(direct, f); return; }
      for (const [key, id] of edges) if (key !== peerKey && this.peerIsHub(live, key)) this.sendTo(id, f);
      return;
    }
    const fresh = await live.session.handle(peerKey, frame);
    if (!fresh || !live.hub) return;
    // Relay: to every edge but the one it came on. Each hub passes a frame on once (the session says
    // whether it was new), so this is a flood with duplicates dropped: it does not need every hub to
    // have an edge to every other one yet, which a group whose hubs just changed does not.
    for (const [key, id] of this.host.edges(groupId)) if (key !== peerKey) this.sendTo(id, f);
  }

  private peerIsHub(live: Live, key: string): boolean {
    return this.recentHub(live, key) && !live.members.has(key);
  }
  private remember(live: Live, id: string): boolean {
    if (live.relayed.has(id)) return false;
    live.relayed.add(id);
    if (live.relayed.size > RELAYED_KEPT) live.relayed.delete(live.relayed.values().next().value!);
    return true;
  }
  private sendTo(linkId: string | undefined, frame: object): void {
    if (!linkId || !this.host.linkReady(linkId, 2)) return;
    try { this.host.sendOnLink(linkId, frame); } catch { /* down: the next sync carries it */ }
  }

  /** An edge came up: both sides say where they are. */
  edgeReady(groupId: string, peerKey: string, linkId: string): void {
    const live = this.live.get(groupId);
    if (!live || live.session.wasRemoved(peerKey)) return;
    if (live.hub && !this.peerIsHub(live, peerKey)) live.members.set(peerKey, this.now());
    this.sendTo(linkId, live.session.syncFrame());
    this.host.emit();
  }

  edgeNick(groupId: string, peerKey: string, nick: string | undefined): void {
    void this.live.get(groupId)?.session.setNick(peerKey, nick);
  }

  // -- internals -------------------------------------------------------------------------------

  private attach(state: CommunityState): void {
    const id = state.id;
    const session: CommunitySession = new CommunitySession(state, {
      save: async next => {
        const group = this.stored.get(id);
        if (!group || this.live.get(id)?.session !== session) return;
        group.community = next;
        await this.store.putGroup(group);
      },
      broadcast: (frame: CommunityFrame) => { for (const linkId of this.host.edges(id).values()) this.sendTo(linkId, frame); },
      direct: (to, frame) => this.sendTo(this.host.edges(id).get(to), frame),
      addressed: (to, frame) => {
        const edges = this.host.edges(id), live = this.live.get(id);
        const direct = edges.get(to);
        if (direct && this.host.linkReady(direct, 2)) { this.sendTo(direct, frame); return; }
        // Through the hubs I am connected to (as a hub: the other hubs).
        const hubs = new Set(live ? [...live.seenHubs.keys()].filter(key => this.recentHub(live, key)) : []);
        for (const [key, linkId] of edges) if (hubs.has(key) || live?.myHubs.includes(key)) this.sendTo(linkId, frame);
      },
      message: async m => {
        await this.host.storeMessage({ linkId: MESSAGE_LINK(id), id: m.id, text: m.text, sender: m.sender === session.myKey ? "me" : "peer", member: m.sender, timestamp: m.timestamp, via: "datalink" });
        this.lastMessageAt.set(id, Math.max(this.lastMessageAt.get(id) ?? 0, m.timestamp));
      },
      changed: () => { void this.membershipChanged(id); },
      clock: () => this.now(),
      relay: frame => { if (this.live.get(id)?.hub) for (const linkId of this.host.edges(id).values()) this.sendTo(linkId, frame); },
    });
    this.live.set(id, { session, hub: false, hubSince: 0, beacon: [], lastBeaconRead: 0, lastBeaconWrite: 0, hubCandidateAt: 0, members: new Map(), emptySince: 0,
      lastLobbyPoll: 0, myHubs: [], lobbyWrites: new Map(), lastKnockPoll: 0, pendingEntries: new Map(), knocksSeen: new Map(),
      hubWaits: new Map(), hubsAvoided: new Map(), hubsUp: new Set(), lingering: new Map(), seenHubs: new Map(),
      lastRoster: session.roster, lastStatus: session.status, relayed: new Set() });
  }

  private async membershipChanged(groupId: string): Promise<void> {
    const live = this.live.get(groupId);
    if (!live) return;
    const s = live.session, before = live.lastRoster, after = s.roster, top = s.top, when = this.now();
    live.lastRoster = after;
    const statusChanged = live.lastStatus !== s.status;
    live.lastStatus = s.status;
    const name = (key: string) => key === s.myKey ? "You" : s.state.nicks[key] ?? `Member ${key.slice(0, 8)}`;
    if (statusChanged && s.status === "removed") await this.event(groupId, "removed", s.state.statusReason ?? "You were removed from this group", when, s.epoch);
    else if (statusChanged && s.status === "forked") await this.event(groupId, "forked", s.state.statusReason ?? "The membership history forked", when, s.epoch);
    else if (s.status === "active" && before !== after) {
      for (const [key] of after) if (!rosterHas(before, key) && key !== s.myKey) await this.event(groupId, "joined", `${name(key)} joined`, when, top.e, key);
      for (const [key] of before) if (!rosterHas(after, key)) await this.event(groupId, "gone", `${name(key)} is no longer a member`, when, top.e, key);
      if (top.k === "role" && before.find(([k]) => k === top.s)?.[1] !== "admin") await this.event(groupId, "admin", `${name(top.s!)} ${top.s === s.myKey ? "are" : "is"} now the admin`, when, top.e, top.s);
      if (top.k === "rotate") await this.event(groupId, "rotated", "Keys rotated: a fresh epoch", when, top.e);
    }
    this.host.emit();
  }

  private async event(groupId: string, event: GroupEvent, text: string, timestamp: number, epoch: number, member?: string): Promise<void> {
    await this.host.storeMessage({ linkId: MESSAGE_LINK(groupId), id: `event:${epoch}:${event}:${member ?? ""}:${timestamp}`, text, sender: "peer", event, member, timestamp, via: "datalink" });
  }
}
