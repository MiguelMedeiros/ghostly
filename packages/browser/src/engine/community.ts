import {
  COMMUNITY_LIMITS, COMMUNITY_TOPOLOGY, CommunitySession, GROUP_READ_NOTE_COMMUNITY, KNOCK_TTL_MS, MAX_KNOCKS, MEMBER_KEY,
  beaconKeys, beaconRecords, createIdentity, decodeCommunityLink, doorHubs, groupName, entryParams, publicKeyFromZ32, encodeCommunityLink, freshHubs, identityFromSeedB64, knockIdentity, knockRecords, lobbyKeys, lobbyRecords, mergeBeacon, newerHead, readBeaconHead, type CommunityHead,
  mentionsMember, receivedTimestamp, mergeKnocks, mergeLobby, pickHubs, rankHubs, readBeacon, readKnocks, readLobby, rosterHas, shouldBeHub,
  type CommunityFrame, type CommunityMessageFrame, type GroupEdit, type GroupMention, type WireReply, type StatusCard, type CommunityState, type GroupEntryLink, type GroupMetaChange, type Hub, type Roster,
} from "@ghostly/core";
import type { GroupEvent, GroupJoinStage, GroupView, StoredGroup, StoredMessage } from "../shared/types";
import { groupReply } from "../shared/replies";
import { FramesTaken, arrivalNow, cameAt, cameOrWritten, editKey, eventTime, mentionAt, mentionFields, noteCame, peerMessageAt, type GroupStore, type GroupsHost } from "./groups";
import { HubClocks } from "./hubClocks";
import { traceJoin } from "./joinTrace";

/** The line a change of a group's picture leaves in its history (both profiles). */
export const pictureText = (name: string, set: boolean) => `${name} ${set ? "changed" : "removed"} the group's picture`;
/** The line a new name leaves (both profiles): `group` is the name the group has now. */
export const renameText = (name: string, group: string) => `${name} renamed the group to “${group}”`;

/** The lines a statement that changed the group's name or picture leaves in its history, in that order. */
export function metaLines(name: string, change: GroupMetaChange, group: string): { event: GroupEvent; text: string }[] {
  return [
    ...("name" in change ? [{ event: "renamed" as const, text: renameText(name, group) }] : []),
    ...("picture" in change ? [{ event: "picture" as const, text: pictureText(name, !!change.picture) }] : []),
  ];
}

/**
 * Community groups (`group-community/1`, WISP 903 · Group Community): a link anyone can open, any
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
/**
 * After a restart, the edges of the last run stay open this long, whatever the topology picks at first: the members
 * and hubs at their other ends watch for this app to come back (a member keeps a hub that went away `hubWaitMs`, a
 * hub its members a minute, another hub three), and the app dials those that were live once at start (`resume`).
 */
const RESTORED_EDGE_MS = 60_000;
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
/**
 * A knock the relays have not taken yet (their budget refused it) is tried again this soon: within `WRITE_FIRST_MS`
 * of the refusal, while the budget still keeps the next request it frees for that write.
 */
export const UNKNOCKED_RETRY_MS = 3_000;
const KNOCK_SLOT_OPEN_MS = 20_000;
/** How long a hub missing from the beacon still counts as one for the edges already up. */
const HUB_GRACE_MS = 3 * 60_000;
/**
 * A member cut off by a hub that left waits this long for the hub that takes it in its place before it may step up as
 * a hub itself: long enough for that hub's lobby reading (every 6 s once a hub left) and an edge, short enough that a
 * group that needs one more hub gets it.
 */
const CUT_OFF_STEP_UP_MS = 15_000;
/** A lobby request this recent is from a member still looking fast for my side of the edge: mine opens expecting it. */
const LOBBY_EXPECT_MS = 30_000;
/**
 * A lobby is one record every member asking a hub writes, each reading it and writing it back with its own request: two
 * members writing at once (both cut off by the same leave, in the same second) each write what they read, and the later
 * write drops the earlier request. So a member reads the lobby back this long after its write (plus up to `LOBBY_CHECK_JITTER_MS`, so
 * the members who wrote together do not read and write together again) and asks again at once if its request is gone.
 */
const LOBBY_CHECK_MS = 2_000;
const LOBBY_CHECK_JITTER_MS = 3_000;
const REFUSED_FOR_MS = 10 * 60_000;
const ENTRY_LINGER_MS = 20_000;
const RELAYED_KEPT = 4096;
/**
 * Someone the chain took out while its app was closed comes back believing it is a member: it asks in a hub's lobby,
 * or lists itself as a hub. A hub then keeps an edge to it for a moment, only to hand it the commit that took it out
 * (`farewell`): at most `FAREWELL_EDGES` at a time, each awaited `FAREWELL_WAIT_MS` and closed `FAREWELL_LINGER_MS`
 * after the commit went; the same key is not waited for again for a while (longer once it was told).
 */
const FAREWELL_EDGES = 4;
const FAREWELL_WAIT_MS = 2 * 60_000;
const FAREWELL_LINGER_MS = 10_000;
const FAREWELL_RETRY_MS = 60_000;
const FAREWELL_TOLD_MS = 10 * 60_000;
const FAREWELL_SAY_MS = 10_000;
/**
 * A key asking from before the commit that took it out was there and was sent that commit: not waited for. The two
 * times are two devices' clocks (the asker's, the commit's signer's), so "before" allows this much between them:
 * a returning member whose clock runs behind the admin's is told all the same.
 */
const FAREWELL_SKEW_MS = 5 * 60_000;
/** Two readings of the beacon no further apart than this say when an entry that moved between them was written (`HubClocks`). */
const HUB_CLOCK_READ_GAP_MS = 45_000;
/** A member that opens the group's link again knocks to check it is still in, this long at most (`joinByLink`). */
const CHECK_MS = 3 * 60_000;
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
  /** The beacon's hubs, each entry in this app's time (`HubClocks.inMyTime`). */
  beacon: Hub[];
  /** Each hub's clock as its entry showed it. */
  hubClocks: HubClocks;
  /** The newest message frame the beacon names (WISP 903 § Head), as last read or written. */
  head: CommunityHead | null;
  lastBeaconRead: number;
  /** When the beacon was last read or written for good (`lastBeaconRead` also counts a reading that failed). */
  beaconAt: number;
  /**
   * The beacon was read at least once in this run (always, in a group of one: nobody else can be a hub). Until then
   * nothing says who the hubs are, which is not the same as there being none. And when a read last failed.
   */
  beaconKnown: boolean;
  beaconFailedAt: number;
  beaconAskedAt?: number;
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
  /** As a member: the lobby requests to read back (`LOBBY_CHECK_MS`): hub → when, and the time my request said. */
  lobbyChecks?: Map<string, { at: number; ts: number }>;
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
  /** As a hub: the other hubs whose edge to me is up (when one drops, its members are about to ask in my lobby). */
  hubPeersUp?: Set<string>;
  /** As a hub: the other hubs whose edge to me dropped, and when (`hubDead`). */
  hubPeersDown?: Map<string, number>;
  /** As a hub stepping down: when I took myself out of the beacon (0: not stepping down), and not before when the next try. */
  leaving: number;
  stepDownAt: number;
  /** Hubs taken in place of one that left: all its members ask them at once, so each gets the longer wait. */
  replacing?: Set<string>;
  /** As a member cut off by a hub that left: since when (it does not step up as a hub for `CUT_OFF_STEP_UP_MS`). */
  cutOffSince?: number;
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
  /**
   * The edges this app had when it started (its last run's), and since when (0: until the first tick): they stay open
   * `RESTORED_EDGE_MS`, as their other ends are likely watching for this app to come back.
   */
  restored: Map<string, number>;
  /** As a hub: keys the chain took out that I keep an edge to until they are told (since when, told when); keys not waited for until; and when each was last told. */
  farewells: Map<string, { since: number; told?: number }>;
  farewellQuiet: Map<string, number>;
  farewellSaid: Map<string, number>;
  hubsMemo?: { beacon: Hub[]; top: object; leaves: object; hubs: Hub[] };
}

export class Communities {
  private readonly stored = new Map<string, StoredGroup>();
  private readonly live = new Map<string, Live>();
  private readonly lastMessageAt = new Map<string, number>();
  /** The latest message from another member, per group: what makes it unread in the list. */
  private readonly lastPeerMessageAt = new Map<string, number>();
  private readonly lastMentionAt = new Map<string, number>();
  private readonly refused = new Map<string, number>();
  private readonly lastKnock = new Map<string, number>();
  /** Joiners: groups whose knock is out (published), and the knock record it is in. */
  private readonly knocked = new Set<string>();
  private readonly knockAt = new Map<string, number>();
  /** Joiners: how many others had a knock still being refreshed in the record I last read (they wait with me). */
  private readonly knockingWith = new Map<string, number>();
  /** My frames an edge took, and which of them carry an edit (`frame id → editKey`). */
  private readonly frames = new FramesTaken();
  private readonly carriers = new Map<string, string>();

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
  isHub(groupId: string): boolean { const live = this.live.get(groupId); return !!live?.hub && live.session.status === "active"; }

  async load(groups: StoredGroup[]): Promise<void> {
    for (const group of groups) {
      this.stored.set(group.id, group);
      if (group.community) this.attach(group.community);
      // Messages only, as while the app runs: a membership line or a payment's note moves neither the list nor unread.
      const history = await this.store.getMessages(MESSAGE_LINK(group.id)), said = history.filter(m => !m.event && !m.groupPay);
      const last = said[said.length - 1], lastPeer = [...said].reverse().find(m => m.sender !== "me");
      if (last) this.lastMessageAt.set(group.id, last.timestamp);
      // A message that came later than it was written counts from when it came, as it did while the app ran (`noteCame`).
      const peerAt = cameOrWritten(lastPeer?.timestamp, lastPeer ? group.came?.peer : undefined);
      if (peerAt) this.lastPeerMessageAt.set(group.id, peerAt);
      const mention = [...history].reverse().find(m => m.mentioned);
      const mentionAt = cameOrWritten(mention?.timestamp, mention ? group.came?.mention : undefined);
      if (mentionAt) this.lastMentionAt.set(group.id, mentionAt);
      // Admissions in flight did not survive the restart; a joiner keeps its side.
      for (const [, linkId] of this.host.entries(group.id)) if (group.joining?.linkId !== linkId) await this.host.closeEdge(linkId);
      // The edges of the last run stay a while, whatever the topology wants at first (see `reconcile`).
      const live = this.live.get(group.id);
      if (live) for (const key of this.host.edges(group.id).keys()) live.restored.set(key, 0);
    }
  }

  /** A community as kept here, to change in place and save (`Groups.setPin`). */
  record(groupId: string): StoredGroup | undefined { return this.stored.get(groupId); }

  views(): GroupView[] {
    return [...this.stored.values()].flatMap((group): GroupView[] => {
      const live = this.live.get(group.id);
      const base = { id: group.id, profile: "community" as const, createdAt: group.createdAt, lastMessageAt: this.lastMessageAt.get(group.id) ?? 0, ...peerMessageAt(this.lastPeerMessageAt, group.id), ...mentionAt(this.lastMentionAt, group.id), invited: [], memberLinks: {} };
      if (this.knocking(group, live)) {
        return [{ ...base, name: groupName(group.joining!.name) ?? live?.session.name ?? "", isAdmin: false, members: [], canSend: false,
          invitation: { linkId: group.joining!.linkId, contact: "", admin: group.joining!.inviter, members: 0, accepted: true, viaLink: true, stage: this.joinStage(group),
            ...(this.knockingWith.get(group.id) ? { waiting: this.knockingWith.get(group.id) } : {}) } }];
      }
      if (!live) return [];
      const s = live.session, edges = this.host.edges(group.id);
      const ready = (key: string) => { const id = edges.get(key); return !!id && this.host.linkReady(id, 2); };
      const hubs = freshHubs(this.hubs(live), this.now()).map(h => h.key);
      // A name outlives its member's place in the roster, as in a private group: what someone who left wrote is still theirs.
      const former = Object.entries(s.state.nicks).filter(([key]) => !rosterHas(s.roster, key));
      return [{ ...base, name: s.name, ...(former.length ? { formerNames: Object.fromEntries(former) } : {}), status: s.status, statusReason: s.state.statusReason, epoch: s.epoch, myKey: s.myKey, isAdmin: s.isAdmin,
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
    if (existing?.joining && existing.joining.host === link.host) return link.g;
    if (live) {
      const s = live.session;
      // What this device holds may be stale (it was removed while its app was closed): never taken for the answer.
      // It knocks with its own key, and the door says which it is: still in (the welcome names an admission it
      // holds, and nothing changes), or let in again. Alone in the group, there is nobody to ask.
      if (s.status === "active" && s.roster.length === 1) return link.g;
      if (s.status === "active") { await this.startJoining(link, s.state.seedB64, this.now(), true); return link.g; }
      // Removed (or its admission lost): let in again by whoever is at the door, with the same key; the history here stays.
      if (s.status === "removed" || s.status === "lost") { await this.startJoining(link, s.state.seedB64, this.now()); return link.g; }
    }
    if (existing) await this.forget(link.g);
    await this.startJoining(link, dialedKey(link), this.now());
    return link.g;
  }

  /** Knocking to get in: a joiner, or someone who was in (removed, or its admission lost) asking again. Not a member checking it still is. */
  private knocking(group: StoredGroup, live: Live | undefined): boolean {
    return !!group.joining && (!live || live.session.status !== "active");
  }

  /** `check`: a member, as far as this device knows, asking the door whether it still is (`joinByLink`). */
  private async startJoining(link: GroupEntryLink, seedB64: string, since: number, check = false): Promise<void> {
    this.lastKnock.delete(link.g); this.knocked.delete(link.g); this.knockAt.delete(link.g); this.knockingWith.delete(link.g);
    const before = this.stored.get(link.g)?.joining;
    const linkId = await this.host.openEntry(link, "guest", seedB64, link.host);
    if (before && before.linkId !== linkId) await this.host.closeEdge(before.linkId);
    const group: StoredGroup = this.stored.get(link.g) ?? { id: link.g, createdAt: since };
    group.joining = { g: link.g, host: link.host, seedB64, linkId, name: group.community?.name ?? "", inviter: "", pieces: [], since, ...(check && { check: true }) };
    this.stored.set(link.g, group);
    await this.store.putGroup(group);
    this.host.emit();
    traceJoin(link.g, "join.start");
    void this.knock(group, since).catch(() => {});
  }

  /** The check is over (answered, or nobody was at the door): the group stays as it is here. */
  private async endCheck(group: StoredGroup): Promise<void> {
    const joining = group.joining;
    if (!joining) return;
    delete group.joining;
    this.lastKnock.delete(group.id); this.knocked.delete(group.id); this.knockAt.delete(group.id);
    this.knockingWith.delete(group.id);
    await this.host.closeEdge(joining.linkId);
    await this.store.putGroup(group);
    this.host.emit();
  }

  async send(groupId: string, text: string, mentions: readonly GroupMention[] = [], reply?: WireReply, forwarded?: number, card?: StatusCard): Promise<{ error: string | null; messageId?: string; refused?: boolean }> {
    const live = this.live.get(groupId);
    if (!live) return { error: "You are not in this group yet", refused: true };
    // Not a member (removed, the history forked, an admission that lost): refused, not something to try again.
    if (!live.session.isMember) return { error: live.session.state.statusReason ?? "You are not in this group", refused: true };
    // Dated by the engine's clock, as the commits it signs and the session's own decisions are: a frame said again once
    // its author has caught up (`CommunitySession.reseal`) goes to the members let in before it, judged by the commits'
    // times against the frame's. Dated by the wall clock, a frame read as written before admissions it came after
    // whenever the two differ (on headless engines, minutes): the members let in meanwhile never got it (2026-10-03).
    const now = this.now();
    const result = card ? await live.session.sendText(text, this.host.myNick?.(), now, mentions, reply, forwarded, card) : await live.session.sendText(text, this.host.myNick?.(), now, mentions, reply, forwarded);
    return "error" in result ? { error: result.error } : { error: null, messageId: result.id };
  }

  /** An application frame to everyone in the group (WISP 903 · Group Community § Payments). */
  async sendApp(groupId: string, frame: Record<string, unknown>): Promise<void> {
    const live = this.live.get(groupId);
    if (!live) throw new Error("You are not in this group yet");
    const result = await live.session.sendApp(frame, this.host.myNick?.(), this.now());
    if ("error" in result) throw new Error(result.error);
  }

  /** An edit of my message, through the group like any frame (WISP 903 · Group Community § Edits). An error when it cannot go now. */
  async sendEdit(groupId: string, edit: GroupEdit): Promise<string | null> {
    const live = this.live.get(groupId);
    if (!live) return "You are not in this group yet";
    const result = await live.session.sendEdit({ id: edit.id, v: edit.e, ts: edit.ts, text: edit.m, mentions: edit.k, ...(edit.sc && { card: edit.sc }) }, this.host.myNick?.(), this.now());
    if ("error" in result) return result.error;
    // The edit rides in a frame of its own: what takes that frame (now, or in a catch-up later) takes the edit.
    const key = editKey(edit.id, edit.e);
    this.carriers.set(result.id, key);
    if (this.carriers.size > 512) this.carriers.delete(this.carriers.keys().next().value!);
    for (let i = 0; i < this.frames.count(groupId, result.id); i++) this.frames.add(groupId, key);
    return null;
  }

  /** A payload for one member only, sealed to them and carried by the group (hubs relay it, members keep it for them). */
  async sendPair(groupId: string, to: string, payload: Record<string, unknown>): Promise<void> {
    const live = this.live.get(groupId);
    if (!live) throw new Error("You are not in this group yet");
    const result = await live.session.sendPair(to, payload, this.host.myNick?.(), this.now());
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
  async rename(groupId: string, name: string): Promise<void> { await this.require(groupId).rename(name); }
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

  /**
   * A join through the link that no member answered yet, given up: listed as an invitation, it is declined as one.
   * A member trying to get back in (its session lost) leaves instead, which keeps nothing either.
   */
  async decline(groupId: string): Promise<void> {
    const group = this.stored.get(groupId), live = this.live.get(groupId);
    if (!group || !this.knocking(group, live)) throw new Error("No invitation to decline");
    if (live) throw new Error("You were in this group: leave it to stop trying to get back in");
    await this.forget(groupId);
  }

  async forget(groupId: string): Promise<void> {
    const live = this.live.get(groupId);
    if (live?.hub) await this.publishBeacon(groupId, live, this.now(), false).catch(() => {});
    this.live.delete(groupId);
    this.stored.delete(groupId);
    this.lastMessageAt.delete(groupId);
    this.lastPeerMessageAt.delete(groupId);
    this.lastMentionAt.delete(groupId);
    this.knockingWith.delete(groupId);
    for (const linkId of [...this.host.edges(groupId).values(), ...this.host.entries(groupId).values()]) await this.host.closeEdge(linkId);
    await this.store.deleteGroup(groupId);
    this.host.historyGone?.(groupId);
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
      if (group.joining && (this.knocking(group, live) || group.joining.check)) {
        const waited = now - group.joining.since, every = waited > this.timings.patienceMs ? this.timings.slowKnockMs : this.timings.knockMs;
        // A member checking it is still in does not ask for ever: nobody at the door says nothing either way.
        if (!this.knocking(group, live) && waited > CHECK_MS) await this.endCheck(group);
        // Knocking stops as soon as a member's side of the entry session is seen, before it is up: that one is answering.
        else if (!this.host.linkReady(group.joining.linkId, 2) && !this.host.linkSeen?.(group.joining.linkId)
          && now - (this.lastKnock.get(group.id) ?? 0) >= (this.knocked.has(group.id) ? every : Math.min(every, UNKNOCKED_RETRY_MS))) await this.knock(group, now).catch(() => {});
        if (!live) continue;
      }
      if (!live) continue;
      if (live.session.status === "lost" && !group.joining) {
        // My admission lost a race: I am nobody's hub and nobody's door any more; I knock again with
        // the same key, and whoever is there lets me in.
        if (live.hub) { live.hub = false; live.leaving = 0; await this.publishBeacon(group.id, live, now, false).catch(() => {}); }
        await this.closeEntries(group.id);
        await this.startJoining({ g: group.id, host: live.session.entryKey }, live.session.state.seedB64, now);
        continue;
      }
      if (live.session.status !== "active") {
        // Out (removed while a hub, say one that came back believing it was a member): no hub and no door any more.
        if (live.hub) { live.hub = false; await this.closeEntries(group.id); await this.publishBeacon(group.id, live, now, false).catch(() => {}); }
        live.farewells.clear();
        await this.reconcile(group.id, live, now);
        continue;
      }
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
    const alone = live.hub && !freshHubs(this.hubs(live), now).some(h => h.key !== me);
    // A read that failed is tried again in a moment, not at the next turn of the usual pace.
    const readDue = live.beaconFailedAt ? now - live.beaconFailedAt >= BEACON_RETRY_MS : now - live.lastBeaconRead >= (alone ? COMMUNITY_TOPOLOGY.beaconEveryMs : this.timings.beaconReadMs);
    if (readDue || live.lastBeaconRead === 0) await this.readBeacon(groupId, live, now);
    // Never read yet (the app just started, and the relays' budget or the network refused the read): who the hubs are
    // is unknown, which is not "there are none". Taken for none, this app became a hub at once and the door alone, and
    // answered the knocks the real door was answering: two hubs on one entry session, and nobody got in. The edges it
    // has stay; hubs, the door and the lobby wait for a reading.
    if (!live.beaconKnown) { await this.keepLooking(groupId, live, now); await this.reconcile(groupId, live, now); return; }
    const others = freshHubs(this.hubs(live), now).filter(h => h.key !== me);
    if (!live.hub) {
      // A newcomer first connects to the member who let it in (a hub): only then, or a while after, is it one more.
      const settled = () => now - live.joinedAt >= this.timings.newcomerMs || !freshHubs(this.hubs(live), now).some(h => h.key !== me);
      // Cut off by a hub that left (no edge up to anyone else): the hub that takes me in its place first, a while. A member
      // stepping up at once was a hub with no edge to the rest, which took half a minute and more to open one (the
      // "a hub that leaves" test failed half the time on that, 2026-10-03). One no hub takes (`forceHub`) carries itself.
      const cutOff = () => {
        const left = (key: string) => s.wasRemoved(key) || s.state.pendingLeaves.some(r => r.s === key);
        const off = !live.forceHub && (live.myHubs.some(left) || !!live.replacing?.size)
          && ![...this.host.edges(groupId)].some(([key, id]) => !left(key) && this.host.linkReady(id, 2));
        if (!off) { live.cutOffSince = undefined; return false; }
        live.cutOffSince ??= now;
        return now - live.cutOffSince < CUT_OFF_STEP_UP_MS;
      };
      // On an app with a budget of connections (a Mac), only with room for a member beside the other hubs.
      const want = () => settled() && !cutOff() && (shouldBeHub(me, this.hubs(live), now) || (!!live.forceHub && freshHubs(this.hubs(live), now).length < COMMUNITY_TOPOLOGY.maxHubs))
        && this.capacity(groupId, live, now) > 0;
      if (want()) {
        // With no hub at all there is nobody to agree with: at once (another member doing the same is one
        // more hub, which steps down when idle). Otherwise a random wait, so a crowd does not all step up.
        if (!live.hubCandidateAt) live.hubCandidateAt = now + (freshHubs(this.hubs(live), now).length ? Math.floor(this.random() * this.timings.hubJitterMs) : 0);
        if (now >= live.hubCandidateAt) {
          live.hubCandidateAt = 0;
          if (live.lastBeaconRead !== now) await this.readBeacon(groupId, live, now);
          if (want()) {
            live.forceHub = false; live.hub = true; live.hubSince = now; live.emptySince = now; live.leaving = 0;
            live.knocksScanned = false;
            // A write the relays' budget holds back is tried again in a moment (`BEACON_RETRY_MS`); meanwhile this hub
            // goes on with its tick: alone, it is the door before its entry is listed (`doorHubs`).
            await this.publishBeacon(groupId, live, now, true).catch(() => {});
            traceJoin(groupId, "hub.elected");
          }
        }
      } else live.hubCandidateAt = 0;
    }
    if (live.hub) {
      const load = this.hubLoad(groupId, live, now);
      if (load > 0) live.emptySince = now;
      // Stay listed; step down when idle and others can carry the group, in two steps (see `canStepDown`).
      const idle = now - live.emptySince > this.timings.idleHubMs && now - live.hubSince > this.timings.idleHubMs;
      if (live.leaving) {
        // Out of the beacon since `leaving`, still a hub. On the next reading: the hub I count on is still listed, so I
        // am a member now; it is not (it was stepping down too, counting on me), or someone asked for me meanwhile, so
        // I stay, listed again, and try later (not at the same moment as that hub again). No reading in a while (the
        // relays hold them back): I stay too, rather than be a hub nobody finds.
        const read = live.beaconAt > live.leaving, listed = live.beacon.some(h => h.key === me);
        if (read && idle && !listed && this.canStepDown(groupId, live, now)) {
          live.leaving = 0; live.hub = false;
          // A member of the hubs I counted on: the edges are up, no lobby needed.
          const edges = this.host.edges(groupId);
          live.myHubs = freshHubs(this.hubs(live), now).map(h => h.key).filter(key => { const id = edges.get(key); return key !== me && !!id && this.host.linkReady(id, 2); }).slice(0, COMMUNITY_TOPOLOGY.hubsPerMember);
          for (const key of live.myHubs) { live.hubsAvoided.delete(key); live.hubWaits.delete(key); live.hubsUp.add(key); }
          live.members.clear();
        } else if (read && idle && listed && this.canStepDown(groupId, live, now)) {
          // Another hub's write put me back (it had read the beacon before mine): out again, and one more reading.
          if (await this.publishBeacon(groupId, live, now, false).then(() => true, () => false)) live.leaving = now;
        } else if (read || now - live.leaving > COMMUNITY_TOPOLOGY.beaconEveryMs) {
          live.leaving = 0;
          live.stepDownAt = now + this.timings.idleHubMs + Math.floor(this.random() * this.timings.idleHubMs);
        }
      } else if (idle && now >= live.stepDownAt && this.canStepDown(groupId, live, now)) {
        // On a reading of this very moment. Held back by the relays (the reading, or the write), I am a hub as before,
        // listed as before, and try again in a while.
        live.stepDownAt = now + 3 * BEACON_RETRY_MS;
        if ((live.beaconAt === now || await this.readBeacon(groupId, live, now)) && this.canStepDown(groupId, live, now)
          && await this.publishBeacon(groupId, live, now, false).then(() => true, () => false)) {
          live.leaving = now;
          // No longer at the door: admissions in flight are closed, so they do not collide with the next door's.
          await this.closeEntries(groupId);
        }
      }
      if (!live.hub || live.leaving) {
        // Stepping down, or a member now: nothing to say in the beacon.
      } else if (now - live.lastBeaconTry < BEACON_RETRY_MS) {
        // A publish that just failed (the relays' budget, say) is tried again in a moment, not every tick.
      } else if (now - live.lastBeaconWrite >= COMMUNITY_TOPOLOGY.beaconEveryMs || !live.beacon.some(h => h.key === me)
        // A hub that is leaving (I hold its signed request, or its leave is committed) is written out at once: a member
        // with no edge up hears of the leave only from a reading of the beacon that no longer lists it. (Not one the
        // chain took out: one that lists itself, back after its removal, is told by the hubs that see its entry.)
        || live.beacon.some(h => h.key !== me && this.gone(live, h.key) && (s.state.pendingLeaves.some(r => r.s === h.key) || this.leftItself(live, h.key)))
        // A load that moved much (or filled up) is said at once, so members stop asking a full hub.
        || (now - live.lastBeaconWrite >= 5_000 && Math.abs(this.beaconLoad(groupId, live, now) - (live.beacon.find(h => h.key === me)?.load ?? load)) >= 8)) {
        // Held back, it does not hold the rest of the tick (knocks, entries, edges) with it.
        await this.publishBeacon(groupId, live, now, true).catch(() => {});
      }
    }
    // Someone the chain took out lists itself as a hub (it came back believing it is a member, and no hub took it): told.
    // (One that listed itself before it was taken out was there, and was sent the commit.) One that left by itself knows:
    // its entry from before it went is no reason to dial it, only one written well after its leave (an app that lost it).
    if (live.hub) for (const h of freshHubs(live.beacon, now)) {
      const out = s.outAt(h.key) ?? Infinity;
      if (this.leftItself(live, h.key) ? h.ts - FAREWELL_SKEW_MS > out : h.ts + FAREWELL_SKEW_MS > out) this.wantFarewell(groupId, live, h.key, now);
    }
    this.endFarewells(live, now);
    if (live.hub) {
      // Letting someone in: the budget goes to that session first, the lobby waits.
      const busy = this.admitting(groupId, live, now);
      // Another hub is leaving (its signed request came on our edge before it went): the members it carried are about
      // to ask the hubs left, so the lobby is looked at often a while, not every half minute.
      if (s.state.pendingLeaves.some(r => r.s !== me && this.recentHub(live, r.s))) live.lobbyBusyUntil = Math.max(live.lobbyBusyUntil, now + this.timings.lobbyBusyMs);
      // So is one whose edge to me was up and dropped (its app closed, or was killed and said nothing): its members ask
      // the hubs left once they give up on it. Read every half minute, my lobby kept them waiting that long more.
      if (this.hubDropped(groupId, live, others, now)) live.lobbyBusyUntil = Math.max(live.lobbyBusyUntil, now + this.timings.lobbyBusyMs);
      const lobbyEvery = now < live.lobbyBusyUntil && !busy ? this.timings.lobbyPollMs : this.timings.lobbyIdlePollMs;
      if (now - live.lastLobbyPoll >= lobbyEvery) { live.lastLobbyPoll = now; await this.pollLobby(groupId, live, now); }
      await this.answerKnocks(groupId, live, now, busy);
      await this.commitLeaves(live, others.map(h => h.key), now);
    } else {
      // A member: stick with hubs that are up and listed, fill up with the least loaded.
      const edges = this.host.edges(groupId);
      const fresh = new Set(others.map(h => h.key));
      for (const [key, until] of live.hubsAvoided) if (until <= now) live.hubsAvoided.delete(key);
      // A hub that left the group (its signed request came on its edge before it went, or the leave is committed) is
      // not an app restarting: another hub now, not after the wait below (a minute and more with no edge, 2026-10-01).
      // The hub taken in its place is expected at once: its side opens on reading my lobby, in seconds (see `lobbyBusyUntil`),
      // and is waited for as long as one that is back: the leaver's other members ask it too, and its relays' budget
      // may hold its reads back a while (all of them giving up after 20 s made each a hub, under the same budget).
      const gone = live.myHubs.filter(key => s.wasRemoved(key) || s.state.pendingLeaves.some(r => r.s === key));
      for (const key of gone) { live.hubsAvoided.set(key, now + HUB_GRACE_MS); live.hubWaits.delete(key); live.hubsUp.delete(key); }
      // A hub whose edge was up, given up on below (its app closed and did not come back: killed, or gone for good). Its
      // other members ask the hubs left too: the next hub's edge looks fast for that hub's side, as after a leave. At the
      // background pace it looked every half minute, and a killed hub's members waited that long more (2026-10-03).
      let lost = false;
      // A hub that has not taken me after a while is full, or gone: another one, or I become one. One whose edge was up
      // and dropped (its app closed, and usually starts again in seconds) gets the same while from the drop, and up to
      // three times that once it is back (a packet since): its edge stays open and looks for it, and comes up again in
      // the seconds its signaling takes on the relays. Dropped at once, the edge was opened again only when the hub was
      // picked again, a minute or more later (2026-09-29).
      for (const key of live.myHubs) {
        if (gone.includes(key)) continue;
        const id = edges.get(key);
        if (id && this.host.linkReady(id, 2)) { live.hubWaits.delete(key); live.hubsUp.add(key); live.replacing?.delete(key); continue; }
        const since = live.hubWaits.get(key) ?? now;
        live.hubWaits.set(key, since);
        const back = live.hubsUp.has(key) && !!id && !!this.host.linkBack?.(id);
        // A hub whose side of my edge is there took me (its packet is fresh, or a connection with it is under way): the
        // edge is being set up, and comes when its relays' budget lets its offer or answer out. It gets the longer wait
        // too. Given up after 20 s, a member went from hub to hub, each opening an edge for someone already gone: with
        // twelve people let in within a minute, some had no edge for two minutes and more (2026-10-01). Not a hub whose edge
        // was up and dropped: my side dials it again at once, and a connection under way from my side alone said "taking"
        // for an app that was killed, so its members waited a minute for it, not 20 s (CLI daemons, 2026-10-03). That one
        // is back when its side published since (`back`).
        const taking = !live.hubsUp.has(key) && !!id && !!this.host.linkSeen?.(id);
        // And one I never had an edge with, that said it is a hub lately, reads its lobby every half minute when nobody
        // asked there before: two waits to see my request, not one that ends before it looks.
        const listed = !live.hubsUp.has(key) && live.beacon.some(h => h.key === key && now - h.ts < COMMUNITY_TOPOLOGY.beaconEveryMs * 1.5);
        // Avoided twice as long as it was waited for: with two hubs out of reach, the first is still avoided when the
        // wait for the second ends, and this member then carries itself (`forceHub`).
        const wait = (back || taking || live.replacing?.has(key) ? 3 : listed ? 2 : 1) * this.timings.hubWaitMs;
        // One I never had an edge with that the beacon listed and lists no more (read just now): it left or stepped down,
        // and the hubs wrote it out. Not waited for: with no edge to it I do not hear its leave, and it never opens its
        // side (a newcomer let in by the admin waited for it 20 s after the admin had left, 2026-10-03). It is cut off as
        // after a leave: the hub taken in its place is waited for longer, and it does not step up as a hub meanwhile
        // (`CUT_OFF_STEP_UP_MS`; on CLI daemons it stepped up two seconds later, a hub with no edge to anyone).
        const dropped = !live.hubsUp.has(key) && live.beaconAt === now && live.seenHubs.has(key) && !live.beacon.some(h => h.key === key);
        if (now - since > wait || dropped) { if (live.hubsUp.has(key) || dropped) lost = true; live.hubsAvoided.set(key, now + 2 * wait); live.hubWaits.delete(key); live.hubsUp.delete(key); live.replacing?.delete(key); }
      }
      let kept = live.myHubs.filter(key => (fresh.has(key) || this.recentHub(live, key)) && !live.hubsAvoided.has(key));
      kept = kept.slice(0, COMMUNITY_TOPOLOGY.hubsPerMember);
      const picked = pickHubs(me, others, now, new Set(live.hubsAvoided.keys()));
      // With no edge up at all (cut off, or let in and the edge to the door never came up), the next hub's edge looks fast
      // for that hub's side, which opens when it reads my lobby. At the background pace it looked every half minute, and
      // found that side up to 30 s after it was there (a newcomer cut off by the admin's leave: 34 s, 2026-10-03).
      const bare = ![...edges.values()].some(id => this.host.linkReady(id, 2));
      for (const key of picked) if (kept.length < Math.max(1, picked.length) && !kept.includes(key)) {
        kept.push(key);
        if ((gone.length || lost || bare) && !edges.has(key)) live.expect.add(key);
        if (gone.length || lost) (live.replacing ??= new Set()).add(key);
      }
      live.myHubs = kept;
      // Every hub I know is full or will not take me: I carry myself, if the beacon has room.
      live.forceHub = !kept.length && others.length < COMMUNITY_TOPOLOGY.maxHubs;
      for (const hub of kept) {
        const id = edges.get(hub);
        if (id && this.host.linkReady(id, 2)) { live.lobbyChecks?.delete(hub); continue; }
        // My request may have been written over by another member's, written at the same moment: asked again now.
        const check = live.lobbyChecks?.get(hub);
        if (check && now >= check.at) {
          live.lobbyChecks!.delete(hub);
          if (await this.lobbyLost(groupId, live, hub, check.ts)) live.lobbyWrites.delete(hub);
        }
        // A request the relays held back (the budget, while a link of mine signals) goes again in a moment, not at the
        // next refresh: the hub cannot open an edge for a member it never saw ask (a member cut off by a hub that left
        // waited 20 s more for each refused write, CLI daemons on local relays, 2026-10-03).
        if (now - (live.lobbyWrites.get(hub) ?? 0) >= this.timings.lobbyWriteMs) {
          live.lobbyWrites.set(hub, now);
          await this.askHub(groupId, live, hub, now).catch(() => { live.lobbyWrites.set(hub, now - this.timings.lobbyWriteMs + BEACON_RETRY_MS); });
        }
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
      const ready = [...this.host.edges(groupId)].filter(([key, id]) => this.host.linkReady(id, 2) && !s.wasRemoved(key)).map(([key]) => key);
      for (const key of ready.slice(0, 3)) s.catchUp(key);
    }
    // Something I said with no edge up may be sealed under a commit I took for the newest: said again once caught up.
    await s.reseal().catch(() => {});
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

  /**
   * May this idle hub step down? When enough other hubs are listed and it has an edge up to one that is listed now
   * (a hub cut off from the others would only come back as one). It then steps down in two steps: it takes itself
   * out of the beacon, still a hub, and is a member only once a later reading still lists a hub it has an edge to.
   * Before, it was a member at once, and counted as hubs those it remembered from earlier readings. Hubs elected in
   * the same seconds (the members of a hub that left) were idle in the same second a minute later, and two of them
   * with an edge to each other only both stepped down, each counting on the other: each was the other's hub, neither
   * was one, and the two heard nobody else until the memory of them ran out, minutes later. And a hub whose write the
   * relays held back was no hub any more but stayed listed, so members went on asking it (2026-10-01).
   */
  private canStepDown(groupId: string, live: Live, now: number): boolean {
    const me = live.session.myKey, others = freshHubs(this.hubs(live), now).filter(h => h.key !== me);
    if (others.length < COMMUNITY_TOPOLOGY.minHubs) return false;
    const edges = this.host.edges(groupId);
    return others.some(h => { const id = edges.get(h.key); return !!id && this.host.linkReady(id, 2); });
  }

  private hubLoad(groupId: string, live: Live, now: number): number {
    const edges = this.host.edges(groupId);
    // Whoever has an edge up to me and is not listed as a hub counts on me as its hub: a hub that stepped down onto
    // me, whose edge came up as a hub's. Not counted, I looked idle and stepped down in turn, leaving it on a member.
    // And whoever is listed is a hub, not a member of mine (a member that became one). Only on a beacon read lately.
    if (now - live.beaconAt <= 2 * this.timings.beaconReadMs) {
      const hubs = new Set(freshHubs(this.hubs(live), now).map(h => h.key));
      for (const [key, id] of edges) if (!hubs.has(key) && !live.members.has(key) && this.host.linkReady(id, 2) && !this.gone(live, key)) live.members.set(key, now);
      for (const key of [...live.members.keys()]) if (hubs.has(key)) live.members.delete(key);
    }
    for (const [key, since] of live.members) {
      const id = edges.get(key);
      if (this.gone(live, key)) live.members.delete(key);
      else if (id && this.host.linkReady(id, 2)) live.members.set(key, now);
      else if (now - since > this.timings.memberGoneMs || live.session.wasRemoved(key)) live.members.delete(key);
    }
    this.shed(groupId, live, now);
    return live.members.size;
  }

  /**
   * Past its room (more hubs, another group or a 1:1 chat took some): the members whose edge is not up go first, and
   * those dropped ask another hub.
   */
  private shed(groupId: string, live: Live, now: number): void {
    const extra = live.members.size - this.capacity(groupId, live, now, false);
    if (extra <= 0) return;
    const edges = this.host.edges(groupId);
    const up = (key: string) => { const id = edges.get(key); return id && this.host.linkReady(id, 2) ? 1 : 0; };
    for (const key of [...live.members.keys()].sort((a, b) => up(a) - up(b) || (a < b ? 1 : -1)).slice(0, extra)) live.members.delete(key);
  }

  /**
   * The members this hub may keep edges with: `hubCapacity`, or on an app with a budget of connections (a Mac, WISP
   * 902 · Group Mesh § Hubs, Budget) what its other groups and 1:1 chats leave (`peerRoom`), less its edges to the
   * other hubs and, for taking someone new (`entries`), its entry sessions.
   */
  private capacity(groupId: string, live: Live, now: number, entries = true): number {
    const room = this.host.peerRoom?.(groupId);
    if (room === undefined) return COMMUNITY_TOPOLOGY.hubCapacity;
    const hubs = new Set(freshHubs(this.hubs(live), now).map(h => h.key));
    for (const key of this.host.edges(groupId).keys()) if (!live.members.has(key)) hubs.add(key);
    hubs.delete(live.session.myKey);
    const held = hubs.size + (entries ? this.host.entries(groupId).size : 0);
    return Math.max(0, Math.min(COMMUNITY_TOPOLOGY.hubCapacity, room - held));
  }

  /** The load the beacon says: a hub with no room left says it is full, as one at `hubCapacity` does. */
  private beaconLoad(groupId: string, live: Live, now: number): number {
    const n = live.members.size;
    return n >= this.capacity(groupId, live, now, false) ? Math.max(n, COMMUNITY_TOPOLOGY.hubCapacity) : n;
  }

  /** Reads the beacon; false when the reading did not happen (the relays held it back, or none answered). */
  private async readBeacon(groupId: string, live: Live, now: number): Promise<boolean> {
    live.lastBeaconRead = now;
    const keys = beaconKeys(live.session.state.rv, groupId);
    // A hub's own reading goes as its knock bell does: not held back while its new edges signal (`PkarrRequestOptions.door`).
    const records = await this.host.resolve(keys.identity.pubKeyZ32, true, live.hub).catch(() => undefined);
    // A read that failed says nothing: what the last one said stays (entries go stale by their own time). Alone in the
    // group, nobody else can be a hub, read or not. Nor does an app wait for ever for its first reading: after as long
    // as an entry stays fresh, whatever was there would be stale by now.
    if (records === undefined) {
      live.beaconFailedAt = now; live.beaconAskedAt ||= now;
      if (live.session.roster.length === 1 || now - live.beaconAskedAt >= COMMUNITY_TOPOLOGY.beaconFreshMs) live.beaconKnown = true;
      return false;
    }
    live.beaconFailedAt = 0; live.beaconKnown = true;
    // Hubs I do not know yet are members newer than my view of the roster: exactly whom I need to catch up.
    live.beacon = live.hubClocks.inMyTime(readBeacon(keys, records ?? []), now);
    live.head = readBeaconHead(keys, records ?? []);
    live.beaconAt = now;
    this.noteHubs(live, now);
    return true;
  }

  /**
   * The newest message frame I hold, for the beacon's head (WISP 903 § Head): what a member's other profile on the
   * same device compares with what it took, to show that something new was said while it was not running.
   */
  private newestFrame(live: Live): CommunityHead | null {
    let newest: CommunityHead | null = null;
    for (const f of live.session.state.store) if (!newest || f.ts > newest.ts) newest = { s: f.s, e: f.e, h: f.h, n: f.n, ts: f.ts };
    return newest;
  }

  private async publishBeacon(groupId: string, live: Live, now: number, listed: boolean): Promise<void> {
    live.lastBeaconTry = now;
    const keys = beaconKeys(live.session.state.rv, groupId);
    // Read this very tick already: what it said is what there is to merge with.
    let existing = live.beacon, head = live.head;
    if (live.lastBeaconRead !== now || live.beaconFailedAt === now) {
      // Read, merge, publish: without the read there is nothing to merge with, and publishing my entry alone would
      // erase every other hub's (each puts its own back only when it republishes, up to half a minute later).
      const read = await this.host.resolve(keys.identity.pubKeyZ32, true, live.hub).catch(() => undefined);
      if (read === undefined && live.session.roster.length > 1) throw new Error("The beacon could not be read; not published");
      const records = read ?? [];
      existing = live.hubClocks.inMyTime(readBeacon(keys, records), now); head = readBeaconHead(keys, records);
    }
    // Nobody drops a hub it does not know: a member behind on the roster would erase newer ones.
    const hubs = mergeBeacon(existing, live.session.myKey, listed ? { key: live.session.myKey, ts: now, load: this.beaconLoad(groupId, live, now), since: live.hubSince || now } : null, now, key => !this.gone(live, key));
    // Nor a newer head: several hubs write this record in turn.
    const newest = newerHead(head, this.newestFrame(live), now);
    await this.host.publish(keys.identity, beaconRecords(keys, live.hubClocks.asWritten(hubs), newest), true, live.hub);
    live.beacon = hubs; live.head = newest;
    this.noteHubs(live, now);
    live.lastBeaconWrite = now; live.lastBeaconRead = live.beaconAt = now; live.beaconFailedAt = 0; live.beaconKnown = true;
  }

  /**
   * The beacon's hubs, less those the chain took out: hubs are members. Someone removed while its app was closed lists
   * itself there when it comes back, believing it is a member, until it is told (`wantFarewell`).
   */
  private hubs(live: Live): Hub[] {
    // Asked many times a tick: worked out again only when the beacon, the chain or the leave requests moved.
    const top = live.session.top, leaves = live.session.state.pendingLeaves, memo = live.hubsMemo;
    if (memo && memo.beacon === live.beacon && memo.top === top && memo.leaves === leaves) return memo.hubs;
    const hubs = live.beacon.filter(h => !this.gone(live, h.key));
    live.hubsMemo = { beacon: live.beacon, top, leaves, hubs };
    return hubs;
  }

  /**
   * Out of the group, or leaving it: a hub whose signed leave request I hold is no hub, before its leave is committed
   * too. Its app said it goes and closed its edges. Counted as a hub, it was dialled again by the hubs left behind (an
   * edge whose app is gone looks fast for it, and so held their other requests to the share they get while a link
   * signals: their lobby went unread and their beacon entry unwritten for minutes), kept at the door, and written back
   * into the beacon (CLI daemons on local relays, 2026-10-03).
   */
  private gone(live: Live, key: string): boolean {
    return live.session.wasRemoved(key) || live.session.state.pendingLeaves.some(r => r.s === key);
  }

  /** Out of the group by its own leave (it signed the request), not removed: its app knows it went. */
  private leftItself(live: Live, key: string): boolean {
    const chain = live.session.state.chain;
    for (let i = chain.length - 1; i >= 0; i--) if ((chain[i].k === "leave" || chain[i].k === "remove") && chain[i].s === key) return chain[i].k === "leave";
    return false;
  }

  /** A frame goes on an edge to a member; to someone the chain took out, only the commit that took it out. */
  private mayHear(live: Live | undefined, key: string, frame: object): boolean {
    if (!live?.session.wasRemoved(key)) return true;
    const f = frame as { t?: unknown; commit?: { k?: unknown; s?: unknown } };
    return f.t === "group-commit" && (f.commit?.k === "remove" || f.commit?.k === "leave") && f.commit.s === key;
  }
  /** The edges of the group that may hear `frame`. */
  private hearers(groupId: string, frame: object): [string, string][] {
    const live = this.live.get(groupId);
    return [...this.host.edges(groupId)].filter(([key]) => this.mayHear(live, key, frame));
  }

  /** As a hub: someone the chain took out is asking (in my lobby, or listing itself as a hub). An edge to tell it, within bounds. */
  private wantFarewell(groupId: string, live: Live, key: string, now: number): void {
    if (key === live.session.myKey || live.farewells.has(key) || now < (live.farewellQuiet.get(key) ?? 0)) return;
    if (live.farewells.size >= FAREWELL_EDGES || this.capacity(groupId, live, now) <= 0) return;
    live.farewells.set(key, { since: now });
    if (!this.host.edges(groupId).has(key)) live.expect.add(key);
  }

  /** Farewell edges end: told a moment ago, never came, or back in the group; and a hub no more keeps none. */
  private endFarewells(live: Live, now: number): void {
    for (const [key, f] of live.farewells) {
      const back = !live.session.wasRemoved(key);
      if (!back && live.hub && (f.told ? now - f.told < FAREWELL_LINGER_MS : now - f.since < FAREWELL_WAIT_MS)) continue;
      live.farewells.delete(key);
      if (!back) live.farewellQuiet.set(key, now + (f.told ? FAREWELL_TOLD_MS : FAREWELL_RETRY_MS));
    }
    for (const [key, until] of live.farewellQuiet) if (until <= now) live.farewellQuiet.delete(key);
    for (const [key, at] of live.farewellSaid) if (now - at >= FAREWELL_SAY_MS) live.farewellSaid.delete(key);
  }

  /**
   * Someone the chain took out says where it is (`group-sync`): it is handed the commits up to the one that took it
   * out, and nothing else (`CommunitySession.farewell`). Nothing else it says is heard.
   */
  private sayFarewell(groupId: string, live: Live, key: string, sync: Record<string, unknown>): void {
    const now = this.now(), linkId = this.host.edges(groupId).get(key);
    if (!linkId || now - (live.farewellSaid.get(key) ?? -Infinity) < FAREWELL_SAY_MS) return;
    const frames = live.session.farewell(key, sync);
    if (!frames.length) return;
    live.farewellSaid.set(key, now);
    try { for (const frame of frames) this.host.sendOnLink(linkId, frame); } catch { return; /* down: it asks again */ }
    const waited = live.farewells.get(key);
    if (waited) waited.told = now;
    traceJoin(groupId, "farewell.sent");
  }

  private noteHubs(live: Live, now: number): void {
    for (const h of freshHubs(this.hubs(live), now)) live.seenHubs.set(h.key, now);
    for (const [key, at] of live.seenHubs) if (now - at > HUB_GRACE_MS) live.seenHubs.delete(key);
  }
  private recentHub(live: Live, key: string): boolean { return this.now() - (live.seenHubs.get(key) ?? -Infinity) <= HUB_GRACE_MS; }

  /** A member asks a hub for an edge: its key in the hub's lobby, and its side of the edge started. */
  private async askHub(groupId: string, live: Live, hub: string, now: number): Promise<void> {
    const keys = lobbyKeys(live.session.state.rv, groupId, hub);
    // Asking for an edge, as a knock asks to be let in: not held back while my links signal (`PkarrRequestOptions.door`).
    // A member whose hub's app was killed dials it again and looks fast for the next hub's side, both for a while: held
    // to that share, its request went out 40 s after it picked the next hub (CLI daemons, 2026-10-03).
    const existing = readLobby(keys, (await this.host.resolve(keys.identity.pubKeyZ32, true, true)) ?? []);
    // Dated by the hub's clock, where mine differs: the hub reads its lobby by its own, and so do the members that write there.
    const theirs = now - live.hubClocks.ahead(hub);
    await this.host.publish(keys.identity, lobbyRecords(keys, mergeLobby(existing, { key: live.session.myKey, ts: theirs }, theirs)), true, true);
    // The lobby keeps whole seconds: my request reads back as the second it was written in.
    (live.lobbyChecks ??= new Map()).set(hub, { at: now + LOBBY_CHECK_MS + Math.floor(this.random() * LOBBY_CHECK_JITTER_MS), ts: Math.floor(theirs / 1000) * 1000 });
    traceJoin(groupId, "lobby.written");
  }

  /**
   * My request is not in the hub's lobby any more, and the lobby has room for it: another member's write, made from a
   * reading from before mine, dropped it (`LOBBY_CHECK_MS`). A full lobby that pushed it out is left as it is: asking
   * again there would push out someone else. A read that fails says nothing, and the usual refresh asks again.
   */
  private async lobbyLost(groupId: string, live: Live, hub: string, ts: number): Promise<boolean> {
    const keys = lobbyKeys(live.session.state.rv, groupId, hub);
    const records = await this.host.resolve(keys.identity.pubKeyZ32, true, true).catch(() => undefined);
    if (records === undefined) return false;
    const entries = readLobby(keys, records ?? []);
    const lost = !entries.some(e => e.key === live.session.myKey && e.ts >= ts) && entries.length < COMMUNITY_TOPOLOGY.lobbyEntries;
    if (lost) traceJoin(groupId, "lobby.lost");
    return lost;
  }

  private async pollLobby(groupId: string, live: Live, now: number): Promise<void> {
    const keys = lobbyKeys(live.session.state.rv, groupId, live.session.myKey);
    const entries = readLobby(keys, (await this.host.resolve(keys.identity.pubKeyZ32, true, true).catch(() => null)) ?? []);
    for (const { key, ts } of entries) {
      // Anyone the chain did not take out: a member whose admission lost a race, or who is ahead of me on the
      // roster, needs the edge to find out. The session hands nothing to someone who is not a member.
      if (now - ts > COMMUNITY_TOPOLOGY.lobbyFreshMs || key === live.session.myKey) continue;
      // Someone the chain took out, asking as a member would: it does not know. Told, and nothing more (`wantFarewell`).
      if (live.session.wasRemoved(key)) { if (ts + FAREWELL_SKEW_MS > (live.session.outAt(key) ?? Infinity)) this.wantFarewell(groupId, live, key, now); continue; }
      // Someone is asking: not the moment to step down.
      live.emptySince = now;
      if (!live.members.has(key) && live.members.size >= this.capacity(groupId, live, now)) continue;
      if (!live.members.has(key)) {
        traceJoin(groupId, "lobby.seen", { age: now - ts });
        live.lobbyBusyUntil = now + this.timings.lobbyBusyMs;
        // Asked a moment ago: its side of the edge is looking for mine, so mine looks fast for it too.
        if (now - ts < LOBBY_EXPECT_MS && !this.host.edges(groupId).has(key)) live.expect.add(key);
      }
      live.members.set(key, Math.max(live.members.get(key) ?? 0, now));
    }
  }

  /** Every edge I want exists, and no other: hubs to hubs and to their members, members to their hubs. */
  private async reconcile(groupId: string, live: Live, now: number): Promise<void> {
    const s = live.session, existing = this.host.edges(groupId);
    const wanted = new Set<string>();
    if (s.status === "active") {
      if (live.hub) {
        this.shed(groupId, live, now);
        for (const h of freshHubs(this.hubs(live), now)) if (h.key !== s.myKey && !this.hubDead(groupId, live, h, now)) wanted.add(h.key);
        for (const key of live.members.keys()) wanted.add(key);
        for (const key of live.farewells.keys()) wanted.add(key);
      } else for (const key of live.myHubs) wanted.add(key);
      // An edge that is up stays while its other end still counts on it, or was a hub a moment ago:
      // one reading of the beacon that missed a hub must not cut the group in two.
      for (const [key, id] of existing) if (this.host.linkReady(id, 2) && (live.members.has(key) || this.recentHub(live, key)) && !s.wasRemoved(key)) wanted.add(key);
    }
    // Back after a restart: an edge of the last run stays a while, since its other end is likely looking for this app
    // (and, once up, carries the catch-up). Closed as the fresh topology's first pick did not name it, it was one about
    // to come up (2026-09-29).
    for (const [key, since] of live.restored) {
      if (!since) live.restored.set(key, now);
      if (!existing.has(key) || now - (since || now) >= RESTORED_EDGE_MS || s.wasRemoved(key)) live.restored.delete(key);
      else wanted.add(key);
    }
    for (const [key, id] of existing) if (!wanted.has(key)) await this.host.closeEdge(id);
    for (const key of wanted) if (!existing.has(key) && key !== s.myKey) {
      const expect = live.expect.delete(key);
      try { await this.host.openEdge(s.state, key, expect); if (expect) live.awaited.set(key, now); } catch { /* next tick */ }
    }
  }

  /** As a hub: did the edge to another hub that was up drop since the last tick? (And since when each is down.) */
  private hubDropped(groupId: string, live: Live, others: Hub[], now: number): boolean {
    const edges = this.host.edges(groupId), up = (live.hubPeersUp ??= new Set()), down = (live.hubPeersDown ??= new Map());
    let dropped = false;
    for (const key of new Set([...up, ...others.map(h => h.key)])) {
      const id = edges.get(key);
      if (id && this.host.linkReady(id, 2)) { up.add(key); down.delete(key); }
      else if (up.delete(key)) { dropped = true; down.set(key, now); }
    }
    for (const [key, since] of down) if (now - since > HUB_GRACE_MS) down.delete(key);
    return dropped;
  }

  /**
   * As a hub: another hub whose edge to me dropped `hubWaitMs` ago, that has not republished its beacon entry since and
   * has not shown itself back: its app was killed (or closed for good). Not dialled any more, as its members stop
   * dialling it after the same wait. My side of the edge dialled it again at once and looked fast for it while its entry
   * stayed fresh, up to 90 s: on relays that spent a third of this hub's requests while the edges its members needed
   * were signaling (CLI daemons, 2026-10-03). Dialled again once its entry moves.
   */
  private hubDead(groupId: string, live: Live, hub: Hub, now: number): boolean {
    const since = live.hubPeersDown?.get(hub.key);
    if (since === undefined || now - since <= this.timings.hubWaitMs || hub.ts > since) return false;
    const id = this.host.edges(groupId).get(hub.key);
    return !(id && this.host.linkBack?.(id));
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
    // No door duty on a device whose admin work is off (WISP 06 § Forced takeover): the other hubs answer in turn.
    if (!s.adminWork || !s.entryKey || !s.state.entry.seedB64 || s.roster.length >= COMMUNITY_LIMITS.members) return;
    const link = { g: groupId, host: s.entryKey };
    // The hubs that take turns at the door: listed lately and settled, the same set for every hub that
    // reads the beacon (a closed app stays listed until its entry goes stale; a new hub waits a minute). A hub
    // with no other in sight is the door at once, before its own entry is listed: a new group's first hub, whose
    // beacon write waited for the relays' budget while another group's link signaled, answered no knock for a minute.
    const hubs = doorHubs(this.hubs(live), now, s.myKey);
    if (!hubs.includes(s.myKey)) return;
    const door = [...hubs].sort()[0], doorSig = [...hubs].sort().join(",");
    // Just became the door (the one before went): whatever knocked meanwhile, in any record.
    if (live.doors !== doorSig) { if (door === s.myKey && live.doors) live.knocksScanned = false; live.doors = doorSig; }
    const records = this.knockRecordsToRead(live, door === s.myKey, busy, now);
    if (!records.length) return;
    let failed = 0;
    const read = await Promise.all(records.map(async n => {
      const record = knockRecord(link, n);
      return readKnocks(record, (await this.host.resolve(knockIdentity(record).pubKeyZ32, true, door === s.myKey && n === KNOCK_BELL).catch(() => { failed++; return null; })) ?? []);
    }));
    traceJoin(groupId, "knock.read", { records: records.length, knocks: read.flat().length, ...(failed ? { failed } : {}) });
    const bell = records.indexOf(KNOCK_BELL);
    if (bell >= 0 && read[bell].filter(k => now - k.ts < KNOCK_TTL_MS).length >= BELL_FULL) live.crowdUntil = now + CROWD_MS;
    // A joiner that moved from the bell to its own record is in both for a while: its newest knock counts.
    const newest = new Map<string, number>();
    for (const { key, ts } of read.flat()) newest.set(key, Math.max(ts, newest.get(key) ?? 0));
    const knocks = [...newest].map(([key, ts]) => ({ key, ts }));
    for (const { key, ts } of knocks) {
      // (My own knock: a member that opened the link again to check it is still in. Another hub answers it, not me.)
      if (now - ts > KNOCK_TTL_MS || this.refused.has(key) || live.pendingEntries.has(key) || key === link.host || key === s.myKey) continue;
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
      // A lone door has no turn to leave to another hub: it answers again as soon as its last attempt is over (a joiner
      // away when it answered, back after the attempt was given up, waited up to two minutes for the next turn).
      const waited = now - first, order = [door, ...rankHubs(key, hubs.filter(k => k !== door))];
      const turn = Math.floor(waited / KNOCK_SLOT_MS) % order.length, early = order.length === 1 || waited % KNOCK_SLOT_MS < KNOCK_SLOT_OPEN_MS;
      if (order[turn] !== s.myKey || !early || (waited >= KNOCK_SLOT_MS && !stillKnocking)) continue;
      if (live.pendingEntries.size >= MAX_PENDING_ENTRIES) break;
      // A hub with no room for one more member (its budget of connections) lets the next hub in turn answer.
      if (live.members.size >= this.capacity(groupId, live, now)) break;
      // Door duty only on the device a fresh turn read says is the active one (WISP 06 § When a device checks). A stale
      // read is read again in the background, and this knock waits for the next turn of the door: the tick never waits.
      if (this.host.adminTurn && !(await this.host.adminTurn(groupId, { wait: false }))) break;
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
   *
   * "The first" is the first of this run that the relays took (`knocked`), not the first tried: a knock the relays'
   * budget refused is tried again as one, every `UNKNOCKED_RETRY_MS`. Taken for a refresh, it went as a background
   * request, every `knockMs`, and background requests are held to a few a minute while a link of this app signals: its
   * own entry session, looking fast for the door's answer. A CLI that was the door of another community, its budget
   * spent, never knocked at all (groupCompat, with the budget scaled down to 12 requests a minute).
   */
  private async knock(group: StoredGroup, now = this.now()): Promise<void> {
    const joining = group.joining!;
    const first = !this.knocked.has(group.id);
    this.lastKnock.set(group.id, now);
    // The first knock of this run too: after a restart the entry session starts again at the background pace, and the
    // door's side, opened on this knock, waited up to half a minute for its answer.
    if (first || now - joining.since < this.timings.patienceMs) this.host.expectPeer?.(joining.linkId);
    const me = identityFromSeedB64(joining.seedB64).pubKeyZ32, link = { g: group.id, host: joining.host };
    const started = Date.now();
    const read = async (n: number) => { const record = knockRecord(link, n); return { record, knocks: readKnocks(record, (await this.host.resolve(knockIdentity(record).pubKeyZ32, !first)) ?? []) }; };
    let n = this.knockAt.get(group.id) ?? KNOCK_BELL, { record, knocks } = await read(n);
    if (n === KNOCK_BELL && !knocks.some(k => k.key === me) && knocks.filter(k => k.key !== me && now - k.ts < KNOCK_TTL_MS).length >= BELL_FULL) ({ record, knocks } = await read(n = ownKnockRecord(me)));
    await this.host.publish(knockIdentity(record), knockRecords(record, mergeKnocks(knocks, { key: me, ts: now }, now)), !first);
    this.knockAt.set(group.id, n);
    traceJoin(group.id, "knock.published", { ms: Date.now() - started, record: n });
    // Who else is knocking in my record (their knock refreshed lately, as a hub counts it): the joining card says so,
    // since a wait behind others is not a link that stopped working.
    const others = knocks.filter(k => k.key !== me && now - k.ts < 2 * this.timings.slowKnockMs).length;
    const moved = (this.knockingWith.get(group.id) ?? 0) !== others;
    this.knockingWith.set(group.id, others);
    if (!this.knocked.has(group.id) || moved) { this.knocked.add(group.id); this.host.emit(); }
  }

  /**
   * The entry sessions this device runs for joiners go (it is no door any more). Its own, when it is knocking at the
   * link itself, stays: a hub taken out of the group that opened the link again at once had that session closed by
   * its next tick (it stops being a hub and a door there), and knocked for good with nothing for a member to answer on.
   */
  private async closeEntries(groupId: string): Promise<void> {
    const live = this.live.get(groupId), mine = this.stored.get(groupId)?.joining?.linkId;
    live?.pendingEntries.clear();
    for (const linkId of this.host.entries(groupId).values()) if (linkId !== mine) await this.host.closeEdge(linkId);
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
        joining.name = groupName(frame.name) ?? joining.name;
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
        if (live.hub && (live.members.has(peer) || live.members.size < this.capacity(g, live, this.now()))) {
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
        const before = this.live.get(g)?.session, again = !!before;
        // A member that asked whether it still is one (`joinByLink`): the welcome names the admission it holds, so it
        // is, and what it has here stays. One that names another admission let it in again: taken, as a joiner's.
        if (before?.status === "active" && before.isMember) {
          const mine = (chain: readonly { k: string; s?: string; sig: string }[]) => [...chain].reverse().find(c => c.k === "add" && c.s === before.myKey)?.sig;
          if (mine(joined.state.chain) === mine(before.state.chain)) { await this.endCheck(group); return; }
          // Removed while away and let in again before anyone told it: its history says both.
          await this.event(g, "removed", "You were removed from this group", this.now(), joined.state.chain.length - 1);
        }
        const back = !!before && before.status !== "lost";
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
        // Its clock, from the commit that let me in: signed a moment ago by its clock, read now by mine. So its beacon
        // entry reads right from my first look, before it is seen to move; a welcome said again long after the commit
        // gives a wrong start, which the entry's next move puts right (`inMyTime`).
        const admission = [...joined.state.chain].reverse().find(c => c.k === "add" && c.s === live.session.myKey);
        if (admission?.by === joining.inviter) live.hubClocks.learn(joining.inviter, now - admission.ts, now);
        await this.store.putGroup(member);
        if (!again) await this.event(g, "joined", `You joined. ${GROUP_READ_NOTE_COMMUNITY}`, now, joined.state.chain.length - 1);
        else if (back) await this.event(g, "joined", "You joined again", now, joined.state.chain.length - 1);
        this.lastKnock.delete(g);
        this.knocked.delete(g);
        this.knockAt.delete(g);
        this.knockingWith.delete(g);
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
    // Someone the chain took out is not heard, nor relayed for: what they have to say ended with them. One that says
    // where it is does not know it is out (it was away): it is told so, with the commit that did it, and nothing more.
    if (live.session.wasRemoved(peerKey)) { if (f.t === "group-sync" && live.session.isMember) this.sayFarewell(groupId, live, peerKey, f); return; }
    // Addressed to someone else: a hub routes it, whoever it is for.
    if ((f.t === "group-secret" || f.t === "group-entry") && typeof f.to === "string" && f.to !== live.session.myKey) {
      if (!live.hub) return;
      const id = `${String(f.t)}:${f.to}:${String(f.h ?? f.x)}`;
      if (!this.remember(live, id)) return;
      if (live.session.wasRemoved(f.to)) return;
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
    for (const [key, id] of this.hearers(groupId, f)) if (key !== peerKey) this.sendTo(id, f);
  }

  private peerIsHub(live: Live, key: string): boolean {
    return this.recentHub(live, key) && !live.members.has(key) && !live.session.wasRemoved(key);
  }
  private remember(live: Live, id: string): boolean {
    if (live.relayed.has(id)) return false;
    live.relayed.add(id);
    if (live.relayed.size > RELAYED_KEPT) live.relayed.delete(live.relayed.values().next().value!);
    return true;
  }
  /** True when the edge took the frame. */
  private sendTo(linkId: string | undefined, frame: object): boolean {
    if (!linkId || !this.host.linkReady(linkId, 2)) return false;
    try { this.host.sendOnLink(linkId, frame); } catch { return false; /* down: the next sync carries it */ }
    this.noteTaken(frame);
    return true;
  }

  /** My frame went out on an edge (at first, or in a catch-up): the message it is, or the edit it carries, was taken. */
  private noteTaken(frame: object): void {
    const f = frame as Partial<CommunityMessageFrame>;
    const session = typeof f.g === "string" ? this.live.get(f.g)?.session : undefined;
    if (f.t !== "group-msg" || !session || f.s !== session.myKey) return;
    // A frame said again (I was behind when I said it) counts for the message it first was.
    const id = session.messageIdOf(f as CommunityMessageFrame);
    this.frames.add(f.g!, id);
    const edit = this.carriers.get(id);
    if (edit) this.frames.add(f.g!, edit);
  }

  /** How many edges took my frame `key` (a message id, or `editKey`). */
  taken(groupId: string, key: string): number { return this.frames.count(groupId, key); }

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
      broadcast: (frame: CommunityFrame) => this.hearers(id, frame).filter(([, linkId]) => this.sendTo(linkId, frame)).length,
      direct: (to, frame) => { if (this.mayHear(this.live.get(id), to, frame)) this.sendTo(this.host.edges(id).get(to), frame); },
      addressed: (to, frame) => {
        const edges = this.host.edges(id), live = this.live.get(id);
        const direct = edges.get(to);
        if (live?.session.wasRemoved(to)) return;
        if (direct && this.host.linkReady(direct, 2)) { this.sendTo(direct, frame); return; }
        // Through the hubs I am connected to (as a hub: the other hubs).
        const hubs = new Set(live ? [...live.seenHubs.keys()].filter(key => this.recentHub(live, key)) : []);
        for (const [key, linkId] of edges) if ((hubs.has(key) || live?.myHubs.includes(key)) && !live?.session.wasRemoved(key)) this.sendTo(linkId, frame);
      },
      message: async m => {
        // The sender picks the time: the store keeps it beside the row and places the row where it comes (`arrivalKey`),
        // so neither the history nor the list of groups follows a member's clock.
        const timestamp = m.timestamp;
        const mentioned = m.sender !== session.myKey && mentionsMember(m.mentions, session.myKey);
        const stored = await this.host.storeMessage({ linkId: MESSAGE_LINK(id), id: m.id, text: m.text, sender: m.sender === session.myKey ? "me" : "peer", member: m.sender, timestamp, via: "datalink",
          ...mentionFields(m.mentions, mentioned), ...(m.reply && { replyTo: groupReply(m.reply, session.myKey) }), ...(m.forwarded && { forwarded: m.forwarded }), ...(m.card && { card: m.card }) });
        const came = m.sender === session.myKey ? timestamp : cameAt(timestamp, stored, arrivalNow(this.now()));
        this.lastMessageAt.set(id, Math.max(this.lastMessageAt.get(id) ?? 0, came));
        if (mentioned) this.lastMentionAt.set(id, Math.max(this.lastMentionAt.get(id) ?? 0, came));
        if (m.sender !== session.myKey) this.lastPeerMessageAt.set(id, Math.max(this.lastPeerMessageAt.get(id) ?? 0, came));
        noteCame(this.stored.get(id), came, m.sender !== session.myKey, mentioned);
      },
      // Outside the session's queue, in order: what they carry (a payment) may send through the session again.
      app: m => this.deliver(id, () => this.host.communityApp?.(id, m.sender, m.frame)),
      pair: m => this.deliver(id, () => this.host.communityPair?.(id, m.sender, m.payload)),
      changed: () => { void this.membershipChanged(id); },
      metaChanged: (by, change, at) => {
        const name = by === session.myKey ? "You" : session.state.nicks[by] ?? `Member ${by.slice(0, 8)}`;
        // When the admin signed it, as a membership line keeps its commit's time (`membershipChanged`).
        const when = receivedTimestamp(at, this.now());
        void (async () => {
          for (const line of metaLines(name, change, session.name)) await this.event(id, line.event, line.text, when, session.epoch, by);
          this.host.emit();
        })();
      },
      clock: () => this.now(),
      seqFloor: () => this.host.seqFloor?.() ?? 0,
      adminWork: () => this.host.adminWork?.(id) ?? true,
      adminTurn: () => this.host.adminTurn?.(id) ?? Promise.resolve(true),
      relay: frame => { if (this.live.get(id)?.hub) for (const [, linkId] of this.hearers(id, frame)) this.sendTo(linkId, frame); },
    });
    this.live.set(id, { session, hub: false, hubSince: 0, beacon: [], hubClocks: new HubClocks(() => session.myKey, HUB_CLOCK_READ_GAP_MS), head: null, lastBeaconRead: 0, beaconKnown: false, beaconFailedAt: 0, beaconAt: 0, leaving: 0, stepDownAt: 0, lastBeaconWrite: 0, lastBeaconTry: 0, hubCandidateAt: 0, members: new Map(), emptySince: 0,
      lastLobbyPoll: 0, myHubs: [], lobbyWrites: new Map(), lastKnockPoll: 0, pendingEntries: new Map(), knocksSeen: new Map(),
      hubWaits: new Map(), hubsAvoided: new Map(), hubsUp: new Set(), lingering: new Map(), seenHubs: new Map(), restored: new Map(),
      farewells: new Map(), farewellQuiet: new Map(), farewellSaid: new Map(),
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
      // When the change was made (the newest commit's time), not when it got here: a member back after a while reads
      // the lines among the messages of their moment, not after everything it missed.
      const at = receivedTimestamp(top.ts, when);
      for (const [key] of after) if (!rosterHas(before, key) && key !== s.myKey) await this.event(groupId, "joined", `${name(key)} joined`, at, top.e, key);
      for (const [key] of before) if (!rosterHas(after, key)) await this.event(groupId, "gone", `${name(key)} is no longer a member`, at, top.e, key);
      if (top.k === "role" && before.find(([k]) => k === top.s)?.[1] !== "admin") await this.event(groupId, "admin", `${name(top.s!)} ${top.s === s.myKey ? "are" : "is"} now the admin`, at, top.e, top.s);
      if (top.k === "rotate") await this.event(groupId, "rotated", "Keys rotated: a fresh epoch", at, top.e);
    }
    this.host.emit();
  }

  /** A line in the group's history. Its id carries its time: two lines at the same moment get distinct ones (`eventTime`). */
  private async event(groupId: string, event: GroupEvent, text: string, timestamp: number, epoch: number, member?: string): Promise<void> {
    timestamp = eventTime(this.eventTimes, groupId, timestamp);
    await this.host.storeMessage({ linkId: MESSAGE_LINK(groupId), id: `event:${epoch}:${event}:${member ?? ""}:${timestamp}`, text, sender: "peer", event, member, timestamp, via: "datalink" });
  }
  private readonly eventTimes = new Map<string, Set<number>>();
}
