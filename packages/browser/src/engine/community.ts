import {
  COMMUNITY_LIMITS, COMMUNITY_TOPOLOGY, CommunitySession, GROUP_READ_NOTE_COMMUNITY, KNOCK_TTL_MS, MAX_KNOCKS, MEMBER_KEY,
  beaconKeys, beaconRecords, createIdentity, decodeCommunityLink, doorHubs, entryParams, publicKeyFromZ32, encodeCommunityLink, freshHubs, identityFromSeedB64, knockIdentity, knockRecords, lobbyKeys, lobbyRecords, mergeBeacon,
  mergeKnocks, mergeLobby, pickHubs, rankHubs, readBeacon, readKnocks, readLobby, rosterHas, shouldBeHub,
  type CommunityFrame, type CommunityState, type GroupEntryLink, type Hub, type Roster,
} from "@ghostly/core";
import type { GroupEvent, GroupJoinStage, GroupView, StoredGroup, StoredMessage } from "../shared/types";
import type { GroupStore, GroupsHost } from "./groups";
import { traceJoin } from "./joinTrace";

/** The line a change of a group's picture leaves in its history (both profiles). */
export const pictureText = (name: string, set: boolean) => `${name} ${set ? "changed" : "removed"} the group's picture`;

/**
 * Community groups (`group-community/1`, WISP 9xx · Group Community): a link anyone can open, any
 * member lets people in, and online members elect a few hubs through a sealed Pkarr beacon. A hub
 * keeps edges with other hubs and with the members that asked it in its lobby, and relays; a
 * member keeps edges with one or two hubs. Membership, keys and catch-up are `CommunitySession`'s;
 * this class decides which edges exist, who answers knocks and who commits leaves.
 */
export interface CommunityTimings {
  /**
   * How often the beacon is read. Not less often: hubs agree on who is at the door from entries
   * republished in the last 45 s (`doorHubs`), so a reading must never be much older than 10 s. A hub
   * alone in it has nobody to agree with and reads it only when it republishes (a new hub is not at
   * the door for its first minute, and is seen long before).
   */
  beaconReadMs: number;
  /** A hub polls its lobby every `lobbyPollMs` for `lobbyBusyMs` after someone new asked there, every `lobbyIdlePollMs` otherwise. */
  lobbyPollMs: number;
  lobbyIdlePollMs: number;
  lobbyBusyMs: number;
  /** A member refreshes its request in a hub's lobby this often until the hub opens its edge. */
  lobbyWriteMs: number;
  /**
   * The door reads the knock bell every `knockPollMs` (`knockWarmPollMs` for `knockWarmMs` after the
   * link was shown, `knockBusyPollMs` while it is letting someone in) and one of the other knock
   * records every `knockShardPollMs`; the other hubs at the door read one record every `otherHubKnockPollMs`.
   */
  knockPollMs: number;
  knockWarmPollMs: number;
  knockWarmMs: number;
  knockBusyPollMs: number;
  knockShardPollMs: number;
  otherHubKnockPollMs: number;
  /** A joiner refreshes its knock this often, `slowKnockMs` once it has waited `patienceMs`. */
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
  /** A newcomer connects to the member who let it in before it considers being a hub itself. */
  newcomerMs: number;
}
/**
 * Every periodic read and write here is a background request (`PkarrTransport`): on relays they may
 * spend 20 of each relay's 30 requests a minute, and spend far less, so that the entry sessions and
 * edges they lead to (an admission signals two links, about 10 requests on each relay) find the rest.
 * A lone door spends about 22 a minute on both relays together, 11 on each: the bell 15, the other
 * knock records 1, its lobby 2, the beacon 6 (republished twice, a read and a write to each relay);
 * with other hubs, 4 more reads of the beacon; less while it is letting someone in.
 */
export const COMMUNITY_TIMINGS: CommunityTimings = {
  beaconReadMs: 10_000, lobbyPollMs: 6_000, lobbyIdlePollMs: 30_000, lobbyBusyMs: 60_000, lobbyWriteMs: 20_000,
  knockPollMs: 4_000, knockWarmPollMs: 2_500, knockWarmMs: 60_000, knockBusyPollMs: 6_000, knockShardPollMs: 60_000, otherHubKnockPollMs: 15_000,
  knockMs: 10_000, slowKnockMs: 20_000, patienceMs: 2 * 60_000,
  idleHubMs: 60_000, memberGoneMs: 60_000, knockFallbackMs: 30_000, hubJitterMs: 3_000, hubWaitMs: 20_000, newcomerMs: 30_000,
};

/**
 * Knocks go to a few Pkarr records: the **bell** (record 0) while it has room, and a joiner's own
 * record (1 to 3, from its key) when a crowd opening the link at once has filled it. The door reads
 * the bell often and the others now and then, all of them while the bell is full: one read finds a
 * knock whenever the crowd is small, and a crowd is not six at a time.
 */
export const KNOCK_SHARDS = 4;
const KNOCK_BELL = 0;
const knockRecord = (link: GroupEntryLink, n: number): GroupEntryLink => ({ g: `${link.g}.${n}`, host: link.host });
const ownKnockRecord = (key: string): number => 1 + publicKeyFromZ32(key)[0] % (KNOCK_SHARDS - 1);
/** Knocks in the bell that make it full: the next joiner goes to its own record. */
const BELL_FULL = MAX_KNOCKS - 1;
/** How long the door reads every knock record after it found the bell full. */
const CROWD_MS = 2 * 60_000;
const BEACON_RETRY_MS = 5_000;
/** An admission's links keep looking fast (see `keepLooking`), renewed this often, an edge for this long. */
const REARM_MS = 20_000;
const AWAIT_EDGE_MS = 2 * 60_000;
/** After letting someone in, the door keeps its reads at the admitting pace this long. */
const ADMITTED_QUIET_MS = 30_000;
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

/**
 * A member key for a joiner whose entry session the member's side dials. Of a paired session's two
 * ends only the lower key dials, and only once it has seen the other; the member's side opens when it
 * sees the knock, and the joiner has been there since it knocked, so the member's side can dial at
 * once: two trips through Pkarr instead of three (offer, answer), which on public relays is seconds.
 * The session's keys derive from both ends' keys (`entryParams`), so the joiner draws keys (two on
 * average) until its end is the higher one.
 */
export function dialedKey(link: GroupEntryLink): string {
  for (let i = 0; ; i++) {
    const me = createIdentity(), params = entryParams(link, me.seed, me.pubKeyZ32, link.host);
    if (identityFromSeedB64(params.seedB64).pubKeyZ32 > params.peerPubKeyZ32 || i >= 32) return me.seedB64;
  }
}

/** Per group, in memory: the topology as this device sees and plays it. */
interface Live {
  session: CommunitySession;
  hub: boolean;
  hubSince: number;
  beacon: Hub[];
  lastBeaconRead: number;
  lastBeaconWrite: number;
  lastBeaconTry: number;
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
  /** Knock records: every one read at once next time (`knocksScanned` false); the last of the others read, and when; the bell full until. */
  knocksScanned: boolean;
  knockCursor: number;
  lastShardPoll: number;
  crowdUntil: number;
  /** The hubs at the door when I last looked, and the link shown until (the door reads faster meanwhile). */
  doors: string;
  warmUntil: number;
  /** My lobby is polled fast until then. */
  lobbyBusyUntil: number;
  /** Members whose edge is due any moment (we just met over the admission): opened expecting them, and since when it is awaited. */
  expect: Set<string>;
  awaited: Map<string, number>;
  /** As a newcomer: when I was let in; as a door: when I last let someone in. */
  joinedAt: number;
  admittedAt: number;
  lastRearm: number;
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
  /** Joiners: groups whose knock is out (published), and the knock record it is in. */
  private readonly knocked = new Set<string>();
  private readonly knockAt = new Map<string, number>();
  constructor(private readonly host: GroupsHost, private readonly store: GroupStore, private readonly timings: CommunityTimings = COMMUNITY_TIMINGS, private readonly random: () => number = Math.random) {}

  /** Application frames and pair payloads handed to the engine, one after the other per group. */
  private readonly deliveries = new Map<string, Promise<void>>();
  private deliver(groupId: string, task: () => Promise<void> | void): void {
    const next = (this.deliveries.get(groupId) ?? Promise.resolve()).then(task).catch(() => {});
    this.deliveries.set(groupId, next);
    void next.then(() => { if (this.deliveries.get(groupId) === next) this.deliveries.delete(groupId); });
  }
  /** Resolves once what was received so far has been handed on (tests). */
  async idle(): Promise<void> { await Promise.all([...this.deliveries.values()]); }

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
        canSend: s.canSend, ...(s.picture ? { picture: s.picture } : {}),
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
    return this.knocked.has(group.id) ? "knocked" : "knocking";
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
    await this.startJoining(link, dialedKey(link), this.now());
    return link.g;
  }

  private async startJoining(link: GroupEntryLink, seedB64: string, since: number): Promise<void> {
    this.lastKnock.delete(link.g); this.knocked.delete(link.g); this.knockAt.delete(link.g);
    const linkId = await this.host.openEntry(link, "guest", seedB64, link.host);
    const group: StoredGroup = this.stored.get(link.g) ?? { id: link.g, createdAt: since };
    group.joining = { g: link.g, host: link.host, seedB64, linkId, name: group.community?.name ?? "", inviter: "", pieces: [], since };
    this.stored.set(link.g, group);
    await this.store.putGroup(group);
    this.host.emit();
    traceJoin(link.g, "join.start");
    void this.knock(group, since).catch(() => {});
  }

  async send(groupId: string, text: string): Promise<{ error: string | null }> {
    const live = this.live.get(groupId);
    if (!live) return { error: "You are not in this group yet" };
    const result = await live.session.sendText(text, this.host.myNick?.());
    return "error" in result ? { error: result.error } : { error: null };
  }

  /** An application frame to everyone in the group (WISP 9xx · Group Community § Payments). */
  async sendApp(groupId: string, frame: Record<string, unknown>): Promise<void> {
    const live = this.live.get(groupId);
    if (!live) throw new Error("You are not in this group yet");
    const result = await live.session.sendApp(frame, this.host.myNick?.());
    if ("error" in result) throw new Error(result.error);
  }

  /** A payload for one member only, sealed to them and carried by the group (hubs relay it, members keep it for them). */
  async sendPair(groupId: string, to: string, payload: Record<string, unknown>): Promise<void> {
    const live = this.live.get(groupId);
    if (!live) throw new Error("You are not in this group yet");
    const result = await live.session.sendPair(to, payload, this.host.myNick?.());
    if ("error" in result) throw new Error(result.error);
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
  async setPicture(groupId: string, picture: string | null): Promise<void> { await this.require(groupId).setPicture(picture); }
  /** A new link (the old one reaches nobody), or none. */
  async replaceLink(groupId: string, off = false): Promise<string> {
    const s = this.require(groupId);
    if (!s.isAdmin) throw new Error("Only the admin can replace or turn off the group's link");
    await this.closeEntries(groupId);
    const key = await s.replaceLink(off);
    return key ? encodeCommunityLink({ g: groupId, host: key }) : "";
  }
  /** The link was shown to be handed out: whoever gets it opens it soon, so the door looks for knocks faster a while. */
  linkShown(groupId: string): void {
    const live = this.live.get(groupId);
    if (live) live.warmUntil = this.now() + this.timings.knockWarmMs;
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
    // Back after a while away (the app was closed or asleep): knocks left meanwhile may be in any record.
    if (live.lastTick !== undefined && now - live.lastTick > 10_000) live.knocksScanned = false;
    live.lastTick = now;
    // An entry session kept open after the welcome went, until the joiner closes its side (it does on the
    // welcome) or a while: left open, it would look fast for a joiner that is gone, spending the relays' budget.
    for (const [linkId, until] of live.lingering) if (now >= until || !this.host.linkReady(linkId, 2)) { live.lingering.delete(linkId); if ([...this.host.entries(groupId).values()].includes(linkId)) await this.host.closeEdge(linkId); }
    const alone = live.hub && !freshHubs(live.beacon, now).some(h => h.key !== me);
    if (now - live.lastBeaconRead >= (alone ? COMMUNITY_TOPOLOGY.beaconEveryMs : this.timings.beaconReadMs) || live.lastBeaconRead === 0) await this.readBeacon(groupId, live, now);
    const others = freshHubs(live.beacon, now).filter(h => h.key !== me);
    if (!live.hub) {
      // A newcomer first connects to the member who let it in (a hub): only then, or a while after, is it one more.
      const settled = () => now - live.joinedAt >= this.timings.newcomerMs || !freshHubs(live.beacon, now).some(h => h.key !== me);
      const want = () => settled() && (shouldBeHub(me, live.beacon, now) || (!!live.forceHub && freshHubs(live.beacon, now).length < COMMUNITY_TOPOLOGY.maxHubs));
      if (want()) {
        // With no hub at all there is nobody to agree with: at once (another member doing the same is one
        // more hub, which steps down when idle). Otherwise a random wait, so a crowd does not all step up.
        if (!live.hubCandidateAt) live.hubCandidateAt = now + (freshHubs(live.beacon, now).length ? Math.floor(this.random() * this.timings.hubJitterMs) : 0);
        if (now >= live.hubCandidateAt) {
          live.hubCandidateAt = 0;
          if (live.lastBeaconRead !== now) await this.readBeacon(groupId, live, now);
          if (want()) {
            live.forceHub = false; live.hub = true; live.hubSince = now; live.emptySince = now;
            live.knocksScanned = false;
            await this.publishBeacon(groupId, live, now, true);
            traceJoin(groupId, "hub.elected");
          }
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
      } else if (now - live.lastBeaconTry < BEACON_RETRY_MS) {
        // A publish that just failed (the relays' budget, say) is tried again in a moment, not every tick.
      } else if (now - live.lastBeaconWrite >= COMMUNITY_TOPOLOGY.beaconEveryMs || !live.beacon.some(h => h.key === me)
        // A load that moved much (or filled up) is said at once, so members stop asking a full hub.
        || (now - live.lastBeaconWrite >= 5_000 && Math.abs(load - (live.beacon.find(h => h.key === me)?.load ?? load)) >= 8)) {
        await this.publishBeacon(groupId, live, now, true);
      }
    }
    if (live.hub) {
      // Letting someone in: the budget goes to that session first, the lobby waits.
      const busy = this.admitting(groupId, live, now);
      const lobbyEvery = now < live.lobbyBusyUntil && !busy ? this.timings.lobbyPollMs : this.timings.lobbyIdlePollMs;
      if (now - live.lastLobbyPoll >= lobbyEvery) { live.lastLobbyPoll = now; await this.pollLobby(groupId, live, now); }
      await this.answerKnocks(groupId, live, now, busy);
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
    await this.keepLooking(groupId, live, now);
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

  /**
   * The links of an admission look fast for the other side (`expectPeer`) for half a minute from when
   * they open. When the relays' budget is short (a second admission in the same minute), their polls
   * wait for it, and the half minute can run out first: they would then look only every half minute,
   * and a join would take a minute more. So each keeps looking fast until it is up, for a while:
   * a poll the budget refuses costs nothing.
   */
  private async keepLooking(groupId: string, live: Live, now: number): Promise<void> {
    if (!this.host.expectPeer || now - live.lastRearm < REARM_MS) return;
    live.lastRearm = now;
    const edges = this.host.edges(groupId), entries = this.host.entries(groupId);
    for (const [key, since] of live.awaited) {
      const id = edges.get(key);
      if (!id || this.host.linkReady(id, 2) || now - since > AWAIT_EDGE_MS) live.awaited.delete(key);
      else this.host.expectPeer(id);
    }
    for (const [key] of live.pendingEntries) {
      const id = entries.get(key);
      if (id && !this.host.linkReady(id, 2)) this.host.expectPeer(id);
    }
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
    const records = await this.host.resolve(keys.identity.pubKeyZ32, true).catch(() => null);
    // Hubs I do not know yet are members newer than my view of the roster: exactly whom I need to catch up.
    live.beacon = readBeacon(keys, records ?? []);
    this.noteHubs(live, now);
  }

  private async publishBeacon(groupId: string, live: Live, now: number, listed: boolean): Promise<void> {
    live.lastBeaconTry = now;
    const keys = beaconKeys(live.session.state.rv, groupId);
    // Read this very tick already: what it said is what there is to merge with.
    const existing = live.lastBeaconRead === now ? live.beacon : readBeacon(keys, (await this.host.resolve(keys.identity.pubKeyZ32, true).catch(() => null)) ?? []);
    // Nobody drops a hub it does not know: a member behind on the roster would erase newer ones.
    const hubs = mergeBeacon(existing, live.session.myKey, listed ? { key: live.session.myKey, ts: now, load: live.members.size, since: live.hubSince || now } : null, now, key => !live.session.wasRemoved(key));
    await this.host.publish(keys.identity, beaconRecords(keys, hubs), true);
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
    const existing = readLobby(keys, (await this.host.resolve(keys.identity.pubKeyZ32, true)) ?? []);
    await this.host.publish(keys.identity, lobbyRecords(keys, mergeLobby(existing, { key: live.session.myKey, ts: now }, now)), true);
    traceJoin(groupId, "lobby.written");
  }

  private async pollLobby(groupId: string, live: Live, now: number): Promise<void> {
    const keys = lobbyKeys(live.session.state.rv, groupId, live.session.myKey);
    const entries = readLobby(keys, (await this.host.resolve(keys.identity.pubKeyZ32, true).catch(() => null)) ?? []);
    for (const { key, ts } of entries) {
      // Anyone the chain did not take out: a member whose admission lost a race, or who is ahead of me on the
      // roster, needs the edge to find out. The session hands nothing to someone who is not a member.
      if (now - ts > COMMUNITY_TOPOLOGY.lobbyFreshMs || key === live.session.myKey || live.session.wasRemoved(key)) continue;
      // Someone is asking: not the moment to step down.
      live.emptySince = now;
      if (!live.members.has(key) && live.members.size >= COMMUNITY_TOPOLOGY.hubCapacity) continue;
      if (!live.members.has(key)) { traceJoin(groupId, "lobby.seen", { age: now - ts }); live.lobbyBusyUntil = now + this.timings.lobbyBusyMs; }
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
    for (const key of wanted) if (!existing.has(key) && key !== s.myKey) {
      const expect = live.expect.delete(key);
      try { await this.host.openEdge(s.state, key, expect); if (expect) live.awaited.set(key, now); } catch { /* next tick */ }
    }
  }

  /**
   * Letting someone in: an entry session of mine, or the edge to someone I just let in, is not up yet,
   * or was a moment ago. The two links of an admission spend a good part of the minute's relay budget
   * signaling; the reads that can wait leave them the rest a while.
   */
  private admitting(groupId: string, live: Live, now: number): boolean {
    const entries = this.host.entries(groupId), edges = this.host.edges(groupId);
    const down = (id: string | undefined) => !id || !this.host.linkReady(id, 2);
    return now - live.admittedAt < ADMITTED_QUIET_MS || [...live.pendingEntries.keys()].some(key => down(entries.get(key))) || [...live.expect].some(key => down(edges.get(key)));
  }

  /**
   * Which knock records to read now (none, most of the time): every one at once the first time
   * (a hub just elected, an app back, a change of door), since a knock left while nobody was at the
   * door may be in any; then the door the bell, and the others in turn; the other hubs one in turn, slowly.
   */
  private knockRecordsToRead(live: Live, door: boolean, busy: boolean, now: number): number[] {
    // (While letting someone in, the link was just shown or members ask in my lobby, the other records wait.)
    if (!live.knocksScanned) {
      live.knocksScanned = true;
      live.lastKnockPoll = live.lastShardPoll = now;
      // Someone may be knocking this very moment (told to wait for a member's app): the bell faster a little while.
      if (door) live.warmUntil = Math.max(live.warmUntil, now + this.timings.knockWarmMs / 3);
      return Array.from({ length: KNOCK_SHARDS }, (_, n) => n);
    }
    const crowd = now < live.crowdUntil;
    const every = !door ? this.timings.otherHubKnockPollMs : busy && !crowd ? this.timings.knockBusyPollMs
      : now < live.warmUntil ? this.timings.knockWarmPollMs : this.timings.knockPollMs;
    if (now - live.lastKnockPoll < every) return [];
    live.lastKnockPoll = now;
    if (!door) return [live.knockCursor = (live.knockCursor + 1) % KNOCK_SHARDS];
    // The link was just shown: one or two people open it, and they knock in the bell (the rest waits a little).
    if (!crowd && (now - live.lastShardPoll < this.timings.knockShardPollMs || busy || now < live.warmUntil || now < live.lobbyBusyUntil)) return [KNOCK_BELL];
    live.lastShardPoll = now;
    live.knockCursor = live.knockCursor % (KNOCK_SHARDS - 1) + 1;
    return [KNOCK_BELL, live.knockCursor];
  }

  private async answerKnocks(groupId: string, live: Live, now: number, busy: boolean): Promise<void> {
    const s = live.session;
    if (!s.entryKey || !s.state.entry.seedB64 || s.roster.length >= COMMUNITY_LIMITS.members) return;
    const link = { g: groupId, host: s.entryKey };
    // The hubs that take turns at the door: listed lately and settled, the same set for every hub that
    // reads the beacon (a closed app stays listed until its entry goes stale; a new hub waits a minute).
    const hubs = doorHubs(live.beacon, now);
    if (!hubs.includes(s.myKey)) return;
    const door = [...hubs].sort()[0], doorSig = [...hubs].sort().join(",");
    // Just became the door (the one before went): whatever knocked meanwhile, in any record.
    if (live.doors !== doorSig) { if (door === s.myKey && live.doors) live.knocksScanned = false; live.doors = doorSig; }
    const records = this.knockRecordsToRead(live, door === s.myKey, busy, now);
    if (!records.length) return;
    const read = await Promise.all(records.map(async n => {
      const record = knockRecord(link, n);
      return readKnocks(record, (await this.host.resolve(knockIdentity(record).pubKeyZ32, true).catch(() => null)) ?? []);
    }));
    const bell = records.indexOf(KNOCK_BELL);
    if (bell >= 0 && read[bell].filter(k => now - k.ts < KNOCK_TTL_MS).length >= BELL_FULL) live.crowdUntil = now + CROWD_MS;
    // A joiner that moved from the bell to its own record is in both for a while: its newest knock counts.
    const newest = new Map<string, number>();
    for (const { key, ts } of read.flat()) newest.set(key, Math.max(ts, newest.get(key) ?? 0));
    const knocks = [...newest].map(([key, ts]) => ({ key, ts }));
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
      const seen = live.knocksSeen.get(key);
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
      traceJoin(groupId, "knock.seen", { age: now - ts, turn });
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

  /**
   * Leaves (or refreshes) my knock: in the bell while it has room, in my own record once a crowd has
   * filled it. The first one goes out at once; refreshes are background requests, and keep my side of
   * the entry session looking fast while I still expect a member to answer soon.
   */
  private async knock(group: StoredGroup, now = this.now()): Promise<void> {
    const joining = group.joining!;
    const first = !this.lastKnock.has(group.id);
    this.lastKnock.set(group.id, now);
    if (!first && now - joining.since < this.timings.patienceMs) this.host.expectPeer?.(joining.linkId);
    const me = identityFromSeedB64(joining.seedB64).pubKeyZ32, link = { g: group.id, host: joining.host };
    const started = Date.now();
    const read = async (n: number) => { const record = knockRecord(link, n); return { record, knocks: readKnocks(record, (await this.host.resolve(knockIdentity(record).pubKeyZ32, !first)) ?? []) }; };
    let n = this.knockAt.get(group.id) ?? KNOCK_BELL, { record, knocks } = await read(n);
    if (n === KNOCK_BELL && !knocks.some(k => k.key === me) && knocks.filter(k => k.key !== me && now - k.ts < KNOCK_TTL_MS).length >= BELL_FULL) ({ record, knocks } = await read(n = ownKnockRecord(me)));
    await this.host.publish(knockIdentity(record), knockRecords(record, mergeKnocks(knocks, { key: me, ts: now }, now)), !first);
    this.knockAt.set(group.id, n);
    traceJoin(group.id, "knock.published", { ms: Date.now() - started, record: n });
    if (!this.knocked.has(group.id)) { this.knocked.add(group.id); this.host.emit(); }
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
    try { this.host.sendOnLink(linkId, live.session.inviteFrame()); traceJoin(groupId, "invite.sent"); } catch { /* it closed */ }
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
        traceJoin(g, "invite.received");
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
        try { welcome = rosterHas(live.session.roster, peer) ? await live.session.rewelcome(peer) : await live.session.admit(peer, this.now()); }
        catch { live.pendingEntries.delete(peer); await this.host.closeEdge(linkId); return; }
        for (const piece of welcome) { try { this.host.sendOnLink(linkId, piece); } catch { /* the joiner knocks again */ } }
        traceJoin(g, "welcome.sent");
        live.pendingEntries.delete(peer);
        live.knocksSeen.delete(peer);
        live.lingering.set(linkId, this.now() + ENTRY_LINGER_MS);
        this.host.entryDone?.(linkId);
        live.admittedAt = this.now();
        // Its first hub is me (it knows): its edge at once, both sides looking fast, no lobby in between.
        if (live.hub && (live.members.has(peer) || live.members.size < COMMUNITY_TOPOLOGY.hubCapacity)) {
          live.members.set(peer, this.now());
          if (!this.host.edges(g).has(peer)) live.expect.add(peer);
          await this.reconcile(g, live, this.now());
        }
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
        traceJoin(g, "welcome.received");
        const again = !!this.live.get(g);
        // Whatever entry sessions this device still ran for the group (as a door before it lost its place) go.
        for (const [, id] of this.host.entries(g)) if (id !== linkId) await this.host.closeEdge(id);
        const member: StoredGroup = { id: g, createdAt: group.createdAt, community: joined.state };
        this.stored.set(g, member);
        this.live.delete(g);
        this.attach(joined.state);
        // The member who let me in is a hub and its app is open: my first hub, which is opening our edge
        // now too (no lobby needed, both sides look fast); the lobby only if that edge is not up in a while.
        const live = this.live.get(g)!, now = this.now();
        live.myHubs = [joining.inviter];
        live.seenHubs.set(joining.inviter, now);
        live.expect.add(joining.inviter);
        live.lobbyWrites.set(joining.inviter, now);
        live.joinedAt = now;
        await this.store.putGroup(member);
        if (!again) await this.event(g, "joined", `You joined. ${GROUP_READ_NOTE_COMMUNITY}`, now, joined.state.chain.length - 1);
        this.lastKnock.delete(g);
        this.knocked.delete(g);
        this.knockAt.delete(g);
        await this.host.closeEdge(linkId);
        await this.reconcile(g, live, now);
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
      // Outside the session's queue, in order: what they carry (a payment) may send through the session again.
      app: m => this.deliver(id, () => this.host.communityApp?.(id, m.sender, m.frame)),
      pair: m => this.deliver(id, () => this.host.communityPair?.(id, m.sender, m.payload)),
      changed: () => { void this.membershipChanged(id); },
      metaChanged: (by, picture) => {
        const name = by === session.myKey ? "You" : session.state.nicks[by] ?? `Member ${by.slice(0, 8)}`;
        void this.event(id, "picture", pictureText(name, !!picture), this.now(), session.epoch, by).then(() => this.host.emit());
      },
      clock: () => this.now(),
      relay: frame => { if (this.live.get(id)?.hub) for (const linkId of this.host.edges(id).values()) this.sendTo(linkId, frame); },
    });
    this.live.set(id, { session, hub: false, hubSince: 0, beacon: [], lastBeaconRead: 0, lastBeaconWrite: 0, lastBeaconTry: 0, hubCandidateAt: 0, members: new Map(), emptySince: 0,
      lastLobbyPoll: 0, myHubs: [], lobbyWrites: new Map(), lastKnockPoll: 0, pendingEntries: new Map(), knocksSeen: new Map(),
      hubWaits: new Map(), hubsAvoided: new Map(), hubsUp: new Set(), lingering: new Map(), seenHubs: new Map(),
      knocksScanned: false, knockCursor: 0, lastShardPoll: 0, crowdUntil: 0, doors: "", warmUntil: 0, lobbyBusyUntil: 0, expect: new Set(), awaited: new Map(), joinedAt: 0, admittedAt: 0, lastRearm: 0,
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

  /**
   * A line in the group's history. Its id carries its time, and the engine's clock moves once a tick: two
   * lines of one kind within a tick (a picture changed, then removed) get distinct times, a millisecond
   * apart, or the store would keep the first and drop the second as already there.
   */
  private async event(groupId: string, event: GroupEvent, text: string, timestamp: number, epoch: number, member?: string): Promise<void> {
    const last = this.lastEventAt.get(groupId) ?? 0;
    if (timestamp <= last) timestamp = last + 1;
    this.lastEventAt.set(groupId, Math.max(last, timestamp));
    await this.host.storeMessage({ linkId: MESSAGE_LINK(groupId), id: `event:${epoch}:${event}:${member ?? ""}:${timestamp}`, text, sender: "peer", event, member, timestamp, via: "datalink" });
  }
  private readonly lastEventAt = new Map<string, number>();
}
