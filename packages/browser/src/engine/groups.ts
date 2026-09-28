import {
  GroupSession, GROUP_EDIT_FRAME, GROUP_REACTION_FRAME, GROUP_REACTED_FRAME, GROUP_TYPING_FRAME, readReaction, groupMessageId, MAX_GROUP_CHAIN, GROUP_MEMBER_CAP, LEGACY_GROUP_MEMBERS, GROUP_VERSION_LARGE, GROUP_VERSION_HUBS, GROUP_READ_NOTE, KNOCK_TTL_MS, MEMBER_KEY, createIdentity, decodeGroupEntryLink, encodeGroupEntryLink, identityFromSeedB64,
  knockIdentity, knockRecords, mentionsMember, receivedTimestamp, mergeKnocks, readKnocks, rosterHas, verifyCommitSignature, decodeCommunityLink,
  type GhostRecord, type PollIntervals, type GroupEdit, type GroupIncomingEdit, type GroupMention, type WireReply, type WireReaction, type GroupCommit, type GroupEdgeFrame, type GroupEntryLink, type GroupMetaChange, type GroupState, type Identity, type Roster, type TypingActivity,
} from "@ghostly/core";
import type { GroupEvent, GroupJoinStage, GroupView, StoredGroup, StoredMessage } from "../shared/types";
import { groupReply } from "../shared/replies";
import { db } from "./db";
import { traceJoin } from "./joinTrace";
import { COMMUNITY_TIMINGS, Communities, metaLines, type CommunityTimings } from "./community";
import { MESH_HUB_TIMINGS, MeshHubs, type MeshHubTimings } from "./meshHubs";
import { GroupTypings } from "./groupTyping";

/** What the engine gives the groups: its links, its storage and its state emitter. */
export interface GroupsHost {
  /** Sends a frame on a paired link (a contact chat or an edge). Throws when it cannot. */
  sendOnLink(linkId: string, frame: object): void;
  /** The link is open and both sides announced groups (`version` 2: community groups too). */
  linkReady(linkId: string, version?: number): boolean;
  /** A name for a contact chat, for the invitation. */
  contactName(linkId: string): string | undefined;
  /** Member key → edge link id, for the edges of this group that exist. */
  edges(groupId: string): Map<string, string>;
  /**
   * Creates and starts the edge of a group toward a member; resolves to its link id. `expectPeer`:
   * the member is online this very moment (we just met over the admission), so it looks fast for it.
   */
  openEdge(state: { id: string; seedB64: string }, peerMemberKey: string, expectPeer?: boolean): Promise<string>;
  closeEdge(linkId: string): Promise<void>;
  /** The nick the member at the other end of an edge announced. */
  edgeNick(linkId: string): string | undefined;
  /**
   * Creates and starts an entry session of a group's link (`group-entry/1`): on the admin's side
   * (`host`) from the entry key toward a joiner's member key, on the joiner's (`guest`) the reverse.
   */
  openEntry(link: GroupEntryLink, role: "host" | "guest", mySeedB64: string, peer: string): Promise<string>;
  /** Entry sessions of this group that exist: peer key → link id. */
  entries(groupId: string): Map<string, string>;
  /**
   * The admission over this entry session is done (the welcome went): it closes as soon as its data
   * link does (the joiner closes its side on the welcome), rather than dialing the joiner again.
   */
  entryDone?(linkId: string): void;
  /** The other end of this link is here (its packet is fresh), or a connection with it is under way. */
  linkSeen?(linkId: string): boolean;
  /**
   * Pkarr, for the knocks under a link's knock identity (and a community's beacon and lobbies).
   * `background`: a periodic look that can wait, spending only part of the relays' budget.
   */
  publish(identity: Identity, records: GhostRecord[], background?: boolean): Promise<void>;
  resolve(pubKeyZ32: string, background?: boolean): Promise<GhostRecord[] | null>;
  /** The other end of this link is due any moment: look fast for it a while (`LinkSession.expectPeer`). */
  expectPeer?(linkId: string): void;
  storeMessage(message: StoredMessage): Promise<void>;
  emit(): void;
  /** My name, for community groups, where it travels (encrypted) with my messages. */
  myNick?(): string | undefined;
  /** An application frame a member of a community sent the group (a note about a payment, a request to everyone). */
  communityApp?(groupId: string, sender: string, frame: Record<string, unknown>): Promise<void> | void;
  /** A payload a member of a community sealed to me (a payment between the two of us). */
  communityPair?(groupId: string, sender: string, payload: Record<string, unknown>): Promise<void> | void;
  /** An edit a member of a private group made of its message, authenticated as theirs (WISP 9xx § Edits). */
  groupEdit?(groupId: string, edit: GroupIncomingEdit): Promise<void> | void;
  /** A private group's edge to `peerKey` came up and both sides said where they are: what is said again on it goes now. */
  edgeUp?(groupId: string, peerKey: string): void;
  /** A member's reaction in a private group: over its own edge, or signed and passed on by a hub. */
  groupReaction?(groupId: string, member: string, reaction: WireReaction): Promise<void> | void;
  /**
   * This app stays online (the Desktop app, the CLI): in a private group past 16 members it offers to be a hub
   * (WISP 9xx · Group Mesh § Hubs). A browser tab does not, unless the admin pins it.
   */
  staysOnline?(): boolean;
  /** False: this app takes no part in hubs and keeps every private group a full mesh (tests of older apps). */
  meshHubs?(): boolean;
  /**
   * The WebRTC connections this app may still open for `groupId`: its budget (`NodeOptions.peerBudget`) less what the
   * links of every other group hold. Undefined when the app has no budget (WISP 9xx · Group Mesh § Hubs, Budget).
   */
  peerRoom?(groupId: string): number | undefined;
}

/** The key an edit of message `id` goes by in `FramesTaken`. */
export const editKey = (id: string, e: number) => `${id}#e${e}`;

/**
 * Which of my frames an edge took (handed to an open session), per group: what `ghostly group send --wait sent` waits
 * for. A message by its id, an edit by `editKey`. A group has no receipts: this is as far as the author can see.
 */
export class FramesTaken {
  private readonly counts = new Map<string, number>();
  add(groupId: string, key: string): void {
    const at = `${groupId}\n${key}`;
    this.counts.set(at, (this.counts.get(at) ?? 0) + 1);
    if (this.counts.size > 2048) this.counts.delete(this.counts.keys().next().value!);
  }
  count(groupId: string, key: string): number { return this.counts.get(`${groupId}\n${key}`) ?? 0; }
}

/** Where groups and their history are kept: the engine's database, or a test's memory. */
export interface GroupStore {
  getGroups(): Promise<StoredGroup[]>;
  putGroup(group: StoredGroup): Promise<void>;
  deleteGroup(groupId: string): Promise<void>;
  getMessages(linkId: string): Promise<StoredMessage[]>;
}

const MESSAGE_LINK = (groupId: string) => `group:${groupId}`;

/** A group message's mentions as the history keeps them, and whether they name me (`mentioned`). */
export const mentionFields = (mentions: GroupMention[] | undefined, mentioned: boolean): Pick<StoredMessage, "mentions" | "mentioned"> =>
  ({ ...(mentions?.length ? { mentions } : {}), ...(mentioned ? { mentioned: true as const } : {}) });
/** The view's `lastMentionAt`, when there is one. */
export const mentionAt = (map: Map<string, number>, groupId: string): { lastMentionAt?: number } => {
  const at = map.get(groupId);
  return at ? { lastMentionAt: at } : {};
};

/**
 * How often a group's link is looked at (`warmPollMs` for `warmMs` after it was handed out or someone
 * knocked: people open a link in the minutes after it is shared, and in bursts), and a joiner knocks;
 * `slowKnockMs` once it has waited `patienceMs`.
 */
export interface EntryTimings { pollMs: number; warmPollMs: number; warmMs: number; knockMs: number; slowKnockMs: number; patienceMs: number }
const ENTRY_TIMINGS: EntryTimings = { pollMs: 5_000, warmPollMs: 2_000, warmMs: 10 * 60_000, knockMs: 5_000, slowKnockMs: 20_000, patienceMs: 2 * 60_000 };
/** Entry sessions the admin runs at once; a joiner who does not finish in time is not answered again for a while. */
const MAX_PENDING_ENTRIES = 4;
const ENTRY_TIMEOUT_MS = 3 * 60_000;
/** A joiner refused (its app cannot follow the group) is not answered again for this long. */
const REFUSED_FOR_MS = 10 * 60_000;
/**
 * A joiner whose entry session timed out (the relays failing, its app closed a moment) is answered again after this,
 * doubling with each timeout in a row up to `REFUSED_FOR_MS`: a slow network is no refusal.
 */
const ENTRY_RETRY_MS = 30_000;
/** The welcome is on its way when the admin sends it; the session stays up a little for it to arrive. */
const ENTRY_LINGER_MS = 20_000;
/** Taken out of a group, my edges stay this long: as a hub, the commit that removed me is passed on over them. */
const REMOVED_LINGER_MS = 15_000;
/** How long the tombstone of a group I left waits for the admin to hear it. */
const LEFT_KEPT_MS = 7 * 24 * 60 * 60_000;
/**
 * While a member is unreachable, how often a mesh member asks one member it is connected to (in turn) for what that
 * one received and it did not: messages sent where the two of them were cut apart (WISP 9xx § Catch-up).
 */
export const MESH_GOSSIP_MS = 60_000;
/** How often the edges a mesh roster asks for are checked against the ones that exist (one that failed to open is tried again). */
const RECONCILE_MS = 30_000;
/** A member back after this long unreachable is announced to the others (`group-here`), unless someone already did. */
const HERE_AFTER_MS = 60_000;
/** A `group-here` about the same member makes its edge look fast at most this often. */
const EXPECT_AGAIN_MS = 30_000;
/**
 * Hints acted on per group and minute, whoever they name: fast looks spend the relays' budget every chat of the app
 * shares, so a member saying everyone is back every 30 s cannot keep all of my edges polling fast.
 */
const HERE_PER_MINUTE = 4;

/**
 * How much slower a mesh member looks at its edges' Pkarr records than a chat would, for a group of `members`: one
 * edge per other member, and each app has about 30 requests a minute per relay (20 for background looks). Up to
 * eight members, as a chat. Past that, a connected edge (its data link carries everything; Pkarr only notices a
 * re-offer) slows in proportion, and an edge to someone away (read to notice them come back) by the square root:
 * at 32 members, every four minutes and every minute, so 31 edges cost about 8 reads a minute when everyone is here
 * and 32 when nobody is. Whoever reaches a member coming back first tells the others (`group-here`), who then look
 * fast for it (WISP 9xx § Cost per member).
 */
export function meshEdgeScale(members: number, connected = true): number {
  const ratio = Math.max(1, (members - 1) / LEGACY_GROUP_MEMBERS);
  return connected ? ratio : Math.sqrt(ratio);
}
/** A mesh edge's poll pace, read live: it follows the group's size as members come and go. */
export function meshEdgeIntervals(base: PollIntervals, members: () => number): PollIntervals {
  return {
    active: base.active, idle: base.idle, fast: base.fast,
    get background() { return Math.round(base.background * meshEdgeScale(members(), false)); },
    get connected() { return Math.round(base.connected * meshEdgeScale(members())); },
  };
}

/**
 * Every private group this peer is in, or was invited to: their sessions
 * (`GroupSession` in core), the pairwise edges that carry them, and the
 * admission exchange that runs on contact chats. Edges are ordinary paired
 * links the engine starts like any other, marked with the group and member
 * they belong to; this class decides which must exist.
 */
export class Groups {
  private readonly stored = new Map<string, StoredGroup>();
  private readonly sessions = new Map<string, GroupSession>();
  /** Contacts (chat ids) I invited to each group, until they answer or the app restarts. */
  private readonly invited = new Map<string, Set<string>>();
  private readonly lastRoster = new Map<string, Roster>();
  private readonly lastMessageAt = new Map<string, number>();
  /** The latest message that names me, per group (the chat list's "@" while it is unread). */
  private readonly lastMentionAt = new Map<string, number>();
  private reconciling = Promise.resolve();
  /** Admin side: joiners with an entry session open, per group: member key → since when. */
  private readonly pendingEntries = new Map<string, Map<string, number>>();
  /** Admin side: member keys whose entry did not finish, not answered again until then. */
  private readonly refused = new Map<string, number>();
  /** Admin side: entry sessions of a member key that timed out in a row, and when the last did. */
  private readonly entryTimeouts = new Map<string, { count: number; at: number }>();
  private readonly lastPoll = new Map<string, number>();
  /** Admin side: until when a group's link is looked at the warm pace. */
  private readonly warmUntil = new Map<string, number>();
  private readonly lastKnock = new Map<string, number>();
  /** Per group, members met over their admission a moment ago: their edge is opened expecting them. */
  private readonly justMet = new Map<string, Set<string>>();
  /** Joiner side: groups whose knock is published, for the stage the joiner is shown. */
  private readonly knocked = new Set<string>();
  /**
   * Per mesh group, the member each unreachable member's messages were asked of (in a sync): asked of one member at a
   * time, not of everyone whose edge opens, so a member coming back is not sent the same messages by every other.
   */
  private readonly relayAsked = new Map<string, Map<string, { via: string; at: number }>>();
  private readonly lastGossip = new Map<string, number>();
  /** Per mesh group: member key → since when its edge to me is down, and when someone last told me it is here. */
  private readonly downSince = new Map<string, Map<string, number>>();
  private readonly hereHeard = new Map<string, Map<string, number>>();
  /** Per mesh group, when the last `group-here` hints were acted on (at most `HERE_PER_MINUTE` a minute). */
  private readonly hereActed = new Map<string, number[]>();
  private gossipTurn = 0;
  /** The clock of the last tick (the engine's, or a simulation's); the wall clock before the first. */
  private tickNow = 0;
  private now(): number { return this.tickNow || Date.now(); }
  private lastReconcile = 0;
  private ticking = false;
  /** Community groups (`group-community/1`) live in their own engine; this class routes to it. */
  readonly communities: Communities;
  /** My messages and edits an edge of a private group took. */
  private readonly frames = new FramesTaken();
  /** Hubs of the private groups past 16 members (WISP 9xx · Group Mesh § Hubs). */
  private readonly hubs: MeshHubs;
  /** Groups whose edges are being reconciled because their hubs changed: one at a time. */
  private readonly hubReconcile = new Set<string>();
  /** Groups a commit took me out of, and when: their edges close `REMOVED_LINGER_MS` later. */
  private readonly removedAt = new Map<string, number>();
  /** Who is typing in each private group, and this side's word there (WISP 9xx · Group Mesh § Typing). */
  private readonly typings: GroupTypings;

  constructor(private readonly host: GroupsHost, private readonly store: GroupStore = db, private readonly timings: EntryTimings = ENTRY_TIMINGS, communityTimings: CommunityTimings = COMMUNITY_TIMINGS, random?: () => number, hubTimings: MeshHubTimings = MESH_HUB_TIMINGS) {
    this.communities = new Communities(host, store, communityTimings, random);
    this.hubs = new MeshHubs(host, { stored: id => this.stored.get(id), save: group => { if (this.stored.get(group.id) === group) void this.store.putGroup(group).catch(() => {}); } }, hubTimings);
    this.typings = new GroupTypings(host);
  }

  async load(): Promise<void> {
    const all = await this.store.getGroups();
    await this.communities.load(all.filter(g => g.community || g.joining));
    for (const group of all.filter(g => !g.community && !g.joining)) {
      this.stored.set(group.id, group);
      if (group.state) this.attach(group.state);
      const history = await this.store.getMessages(MESSAGE_LINK(group.id)), last = history[history.length - 1];
      if (last) this.lastMessageAt.set(group.id, last.timestamp);
      const mention = [...history].reverse().find(m => m.mentioned);
      if (mention) this.lastMentionAt.set(group.id, mention.timestamp);
    }
    for (const id of this.sessions.keys()) this.reconcileEdges(id);
    // An admission in flight did not survive the restart: its joiner knocks again. A joiner keeps its side.
    for (const group of this.stored.values()) for (const [, linkId] of this.host.entries(group.id)) {
      if (!group.invitation?.entry || group.invitation.linkId !== linkId) await this.host.closeEdge(linkId);
    }
  }

  views(): GroupView[] {
    return [...this.meshViews(), ...this.communities.views()].sort((a, b) => Math.max(b.lastMessageAt, b.createdAt) - Math.max(a.lastMessageAt, a.createdAt));
  }

  private meshViews(): GroupView[] {
    return [...this.stored.values()].filter(group => !group.left && (group.invitation || this.sessions.has(group.id))).map(group => {
      const session = this.sessions.get(group.id);
      const edges = this.host.edges(group.id);
      // A chat stays in `contacts` after its member is removed or leaves (the removal notice goes over it): only a member still in the roster counts.
      const contacts = Object.entries(group.contacts ?? {}).filter(([key]) => !session || rosterHas(session.roster, key));
      const base = { id: group.id, profile: "mesh" as const, createdAt: group.createdAt, lastMessageAt: this.lastMessageAt.get(group.id) ?? 0, ...mentionAt(this.lastMentionAt, group.id), invited: [...(this.invited.get(group.id) ?? [])],
        memberLinks: Object.fromEntries(contacts.map(([key, linkId]) => [linkId, key])) };
      if (!session) {
        const invitation = group.invitation!;
        return { ...base, name: invitation.name, isAdmin: false, members: [], canSend: false,
          invitation: { linkId: invitation.linkId, contact: this.host.contactName(invitation.linkId) ?? "", admin: invitation.admin, members: invitation.n, accepted: !!invitation.seedB64,
            ...(invitation.entry ? { viaLink: true, stage: this.joinStage(group) } : {}) } };
      }
      const nicks = session.state.nicks;
      const entry = session.isAdmin ? this.entryOf(group) : undefined;
      const now = this.now(), onHubs = this.hubs.active(group.id, session, now);
      const hubKeys = new Set(onHubs ? this.hubs.hubs(group.id, session, now) : []), policy = session.hubPolicy;
      if (onHubs && this.hubs.isHub(group.id)) hubKeys.add(session.myKey);
      const typing = this.typings.view(session);
      return { ...base, name: session.name, status: session.status, statusReason: session.state.statusReason, epoch: session.epoch, myKey: session.myKey, isAdmin: session.isAdmin,
        ...(entry ? { entryLink: encodeGroupEntryLink(entry.link) } : {}), ...(session.picture ? { picture: session.picture } : {}),
        canSend: session.status === "active" && session.readableEpochs.includes(session.epoch),
        ...(onHubs ? { hubs: { hub: this.hubs.isHub(group.id) } } : {}), ...(typing ? { typing } : {}),
        members: session.roster.map(([key, role]) => {
          const edge = edges.get(key);
          const direct = key === session.myKey || (!!edge && this.host.linkReady(edge)), viaHub = !direct && onHubs && this.hubs.viaHub(group.id, session, key, now);
          const hubRole = policy.pin.includes(key) ? "pin" as const : policy.no.includes(key) ? "exclude" as const : undefined;
          return { key, role, me: key === session.myKey, nick: key === session.myKey ? undefined : (edge && this.host.edgeNick(edge)) || nicks[key],
            online: direct || viaHub, ...(viaHub ? { viaHub } : {}), ...(hubKeys.has(key) ? { hub: true } : {}), ...(hubRole ? { hubRole } : {}), missing: session.missing(key) };
        }) };
    }).sort((a, b) => Math.max(b.lastMessageAt, b.createdAt) - Math.max(a.lastMessageAt, a.createdAt));
  }

  messages(groupId: string): Promise<StoredMessage[]> { return this.store.getMessages(MESSAGE_LINK(groupId)); }

  private isCommunity(groupId: string): boolean { return this.communities.has(groupId); }
  /**
   * What paces a private group's edges (`meshEdgeIntervals`), as a roster of that many members would: the roster in a
   * full mesh, the edges this member keeps (and one) with hubs. 0 for no group.
   */
  meshSize(groupId: string): number {
    const session = this.sessions.get(groupId);
    return session ? this.hubs.edgeLoad(groupId, session) : 0;
  }
  /** Whether a member of a private group is reachable now: its edge is up, or a hub whose edge is up reaches it. */
  reachable(groupId: string, key: string): boolean {
    const session = this.sessions.get(groupId);
    if (!session || this.isCommunity(groupId)) return false;
    const edge = this.host.edges(groupId).get(key), now = this.now();
    return (!!edge && this.host.linkReady(edge)) || (this.hubs.active(groupId, session, now) && this.hubs.viaHub(groupId, session, key, now));
  }
  /** A community group (`group-community/1`) rather than a private one. */
  isCommunityGroup(groupId: string): boolean { return this.isCommunity(groupId); }
  /** Through a community group: an application frame to everyone, or a payload sealed to one member. */
  sendCommunityApp(groupId: string, frame: Record<string, unknown>): Promise<void> { return this.communities.sendApp(groupId, frame); }
  sendCommunityPair(groupId: string, to: string, payload: Record<string, unknown>): Promise<void> { return this.communities.sendPair(groupId, to, payload); }

  /**
   * How many edges took my message `messageId` (or its edit number `edit`) so far: in a private group, members' edges;
   * in a community, the edges to my hubs, which pass it on. 0 while none did.
   */
  taken(groupId: string, messageId: string, edit?: number): number {
    const key = edit ? editKey(messageId, edit) : messageId;
    return this.isCommunity(groupId) ? this.communities.taken(groupId, key) : this.frames.count(groupId, key);
  }

  /**
   * Says an edit of my message to the group (WISP 9xx § Edits): over the edges of a private group (to member `to`
   * alone, when given), through a community like any frame. An error when it cannot go now.
   */
  async sendEdit(groupId: string, edit: GroupEdit, to?: string): Promise<string | null> {
    if (this.isCommunity(groupId)) return this.communities.sendEdit(groupId, edit);
    const session = this.sessions.get(groupId);
    if (!session) return "You are not in this group";
    const result = await session.sendEdit(edit.id, { v: edit.e, ts: edit.ts, text: edit.m, mentions: edit.k }, to);
    return "error" in result ? result.error : null;
  }
  /** Resolves once the community frames received so far were handed to the engine (tests). */
  communityIdle(): Promise<void> { return this.communities.idle(); }

  // -- what the person does ------------------------------------------------

  /** A new group: a community (the link is the way in, hundreds of members) or a private mesh of up to 32 contacts. */
  async create(name: string, profile: "community" | "mesh" = "community"): Promise<string> {
    if (profile === "community") return this.communities.create(name);
    const state = GroupSession.create(name);
    const group: StoredGroup = { id: state.id, createdAt: state.createdAt, state, contacts: {} };
    await this.store.putGroup(group);
    this.stored.set(group.id, group);
    this.attach(state);
    await this.event(group.id, "created", `Group created. ${GROUP_READ_NOTE}`, state.createdAt, 0);
    this.host.emit();
    return group.id;
  }

  async invite(groupId: string, linkId: string): Promise<void> {
    if (this.isCommunity(groupId)) throw new Error("Share the group's link with them: anyone who opens it joins");
    const session = this.session(groupId);
    if (!session.isAdmin) throw new Error("Only the admin can invite");
    const group = this.stored.get(groupId)!;
    if (Object.entries(group.contacts ?? {}).some(([key, id]) => id === linkId && rosterHas(session.roster, key))) throw new Error("This contact is already a member");
    if (session.roster.length + (this.invited.get(groupId)?.size ?? 0) >= GROUP_MEMBER_CAP.max) throw new Error(`A group holds ${GROUP_MEMBER_CAP.max} members at most`);
    if (!this.host.linkReady(linkId)) throw new Error("Connect to this contact first. Their app needs groups (an updated Ghostly).");
    const blocked = this.growthBlocked(group, session, session.roster.length + (this.invited.get(groupId)?.size ?? 0) + 1, linkId);
    if (blocked) throw new Error(blocked);
    this.host.sendOnLink(linkId, session.inviteFrame());
    let set = this.invited.get(groupId);
    if (!set) this.invited.set(groupId, (set = new Set()));
    set.add(linkId);
    this.host.emit();
  }

  async accept(groupId: string): Promise<void> {
    const group = this.stored.get(groupId);
    if (!group?.invitation) throw new Error("No invitation to accept");
    if (!this.host.linkReady(group.invitation.linkId)) throw new Error("The contact who invited you is not connected. Try again when they are.");
    const seedB64 = group.invitation.seedB64 ?? createIdentity().seedB64;
    group.invitation = { ...group.invitation, seedB64, pieces: [] };
    await this.store.putGroup(group);
    this.host.sendOnLink(group.invitation.linkId, { t: "group-accept", g: groupId, key: identityFromSeedB64(seedB64).pubKeyZ32 });
    this.host.emit();
  }

  async decline(groupId: string): Promise<void> {
    const group = this.stored.get(groupId);
    if (!group?.invitation) throw new Error("No invitation to decline");
    try { this.host.sendOnLink(group.invitation.linkId, { t: "group-decline", g: groupId }); } catch { /* they will notice when nobody accepts */ }
    await this.forget(groupId);
  }

  /**
   * Sends a text; `messageId` is the id it is kept under here (what history, replies and reactions name). `forwarded`:
   * the hop count of a forwarded text (WISP 9xx § Forwards).
   */
  async send(groupId: string, text: string, mentions: readonly GroupMention[] = [], reply?: WireReply, forwarded?: number): Promise<{ error: string | null; messageId?: string }> {
    if (this.isCommunity(groupId)) return this.communities.send(groupId, text, mentions, reply, forwarded);
    const session = this.sessions.get(groupId);
    if (!session) return { error: "You are not in this group yet" };
    const result = await session.sendText(text, Date.now(), mentions, reply, forwarded);
    // Sent: whatever this side was typing is done (the members clear it on the message too).
    this.typings.say(session, false);
    return "error" in result ? { error: result.error } : { error: null, messageId: result.id };
  }

  /**
   * This side is typing in a private group (with what it is doing), or stopped (WISP 9xx · Group Mesh § Typing).
   * Nothing for a community: it does not carry typing yet.
   */
  setTyping(groupId: string, typing: boolean, activity?: TypingActivity): void {
    const session = this.isCommunity(groupId) ? undefined : this.sessions.get(groupId);
    if (session) this.typings.say(session, typing, activity);
  }

  /** Every group: a `stop` where a `start` stands (the setting was turned off). */
  stopTyping(): void { for (const session of this.sessions.values()) this.typings.say(session, false); }

  /**
   * The member a leaving admin hands the role to: the first other member whose edge is up, so the
   * role commit reaches someone who can then remove me. None when nobody else is reachable.
   */
  successor(groupId: string): string | undefined {
    if (this.isCommunity(groupId)) return this.communities.successor(groupId);
    const session = this.sessions.get(groupId);
    if (!session) return undefined;
    const edges = this.host.edges(groupId);
    return session.others.find(key => { const edge = edges.get(key); return !!edge && this.host.linkReady(edge); });
  }

  /**
   * Leaves, and the group is gone from this device at once: its row, its history and every edge
   * but the one to the admin, which stays until the admin's commit removing me comes back (or a
   * week passes), so a leave said while the admin was away still reaches it. An admin with other
   * members hands the role to one who is online first; alone, the group simply goes.
   */
  async leave(groupId: string): Promise<void> {
    if (this.isCommunity(groupId)) return this.communities.leave(groupId);
    const session = this.session(groupId);
    const group = this.stored.get(groupId)!;
    if (session.status !== "active") return this.forget(groupId);
    if (session.others.length === 0) { await session.leave(); return this.forget(groupId); }
    if (session.isAdmin) {
      const next = this.successor(groupId);
      if (!next) throw new Error("You are the admin and nobody else in the group is online to take over. Try again when a member is, or make someone the admin first.");
      await session.transferAdmin(next);
    }
    const admin = session.admin!;
    // With hubs, my leave is signed so that they carry it to an admin I have no edge with; the tombstone keeps the
    // edges to them and says it again whenever one opens.
    const onHubs = this.hubs.active(groupId, session, this.now());
    const hubs = onHubs ? [...this.host.edges(groupId).keys()].filter(key => key !== admin && this.hubs.hubs(groupId, session, this.now()).includes(key)) : [];
    const bye = onHubs ? session.byeFrame() : undefined;
    // The history goes with the row; what stays is a tombstone the list does not show. Written
    // before anyone is told, so the admin's answer cannot arrive before it and be undone by it.
    group.left = { at: Date.now(), admin, ...(hubs.length ? { hubs } : {}), ...(bye ? { bye } : {}) };
    delete group.entry;
    this.invited.delete(groupId);
    this.pendingEntries.delete(groupId);
    this.lastMessageAt.delete(groupId);
    this.lastMentionAt.delete(groupId);
    await this.store.deleteGroup(groupId);
    await this.store.putGroup(group);
    for (const linkId of this.host.entries(groupId).values()) await this.host.closeEdge(linkId);
    this.host.emit();
    await session.leave();
    if (bye) for (const key of hubs) { const edge = this.host.edges(groupId).get(key); if (edge && this.host.linkReady(edge)) { try { this.host.sendOnLink(edge, bye); } catch { /* when it opens again */ } } }
    // The admin may be off; its contact chat, if that is how I got here, hears it too.
    const contact = group.contacts?.[admin];
    if (contact) { try { this.host.sendOnLink(contact, { t: "group-leave", g: groupId }); } catch { /* the edge already carried it, or nobody is there */ } }
    this.reconcileEdges(groupId);
    this.host.emit();
  }

  /** The admin heard me: the tombstone of a group I left can go. */
  private async leaveConfirmed(groupId: string): Promise<void> {
    if (!this.stored.get(groupId)?.left) return;
    await this.forget(groupId);
  }

  async remove(groupId: string, key: string): Promise<void> {
    if (this.isCommunity(groupId)) return this.communities.remove(groupId, key);
    const session = this.session(groupId);
    await session.remove(key);
    const contact = this.stored.get(groupId)!.contacts?.[key];
    if (contact) { try { this.host.sendOnLink(contact, { t: "group-removed", g: groupId }); } catch { /* the commit went over the edge, if it was up */ } }
  }

  makeAdmin(groupId: string, key: string): Promise<void> { return this.isCommunity(groupId) ? this.communities.makeAdmin(groupId, key) : this.session(groupId).transferAdmin(key); }
  /**
   * The admin pins a member of a private group as a hub, excludes one from being a hub, or leaves it to the member's
   * app (`null`): said in the group's metadata, which every member keeps (WISP 9xx · Group Mesh § Hubs).
   */
  async setHub(groupId: string, key: string, role: "pin" | "exclude" | null): Promise<void> {
    if (this.isCommunity(groupId)) throw new Error("A community group chooses its hubs by itself");
    await this.session(groupId).setHub(key, role);
    this.host.emit();
  }
  rotate(groupId: string): Promise<void> { return this.isCommunity(groupId) ? this.communities.rotate(groupId) : this.session(groupId).rotate(); }
  /** The admin sets or removes the group's picture; every member gets it over the edges (WISP 9xx § Metadata). */
  async setPicture(groupId: string, picture: string | null): Promise<void> {
    if (this.isCommunity(groupId)) return this.communities.setPicture(groupId, picture);
    await this.session(groupId).setPicture(picture);
  }
  /** The admin renames the group; every member gets the name over the edges, beside the picture (WISP 9xx § Metadata). */
  async rename(groupId: string, name: string): Promise<void> {
    if (this.isCommunity(groupId)) return this.communities.rename(groupId, name);
    await this.session(groupId).rename(name);
  }

  async forget(groupId: string): Promise<void> {
    if (this.isCommunity(groupId)) return this.communities.forget(groupId);
    const session = this.sessions.get(groupId);
    if (session?.status === "active") { try { await this.leave(groupId); } catch { /* the admin cannot leave a group with members: forgetting it is still allowed */ } }
    this.sessions.delete(groupId);
    this.stored.delete(groupId);
    this.invited.delete(groupId);
    this.lastRoster.delete(groupId);
    this.pendingEntries.delete(groupId);
    this.knocked.delete(groupId);
    this.justMet.delete(groupId);
    this.relayAsked.delete(groupId);
    this.hubs.forget(groupId);
    this.removedAt.delete(groupId);
    this.lastGossip.delete(groupId);
    this.typings.forget(groupId);
    this.downSince.delete(groupId);
    this.hereHeard.delete(groupId);
    this.hereActed.delete(groupId);
    for (const linkId of [...this.host.edges(groupId).values(), ...this.host.entries(groupId).values()]) await this.host.closeEdge(linkId);
    await this.store.deleteGroup(groupId);
    this.host.emit();
  }

  // -- the group's link (group-entry/1) -------------------------------------

  /** Turns the link on, or replaces it (`reset`): a new entry key, so the old link reaches nobody. */
  async enableLink(groupId: string, reset = false): Promise<string> {
    if (this.isCommunity(groupId)) {
      const current = this.communities.entryLink(groupId);
      const link = current && !reset ? current : await this.communities.replaceLink(groupId);
      // Asked for the link: it is being handed out, and whoever gets it opens it soon.
      this.communities.linkShown(groupId);
      return link;
    }
    const session = this.session(groupId);
    if (!session.isAdmin) throw new Error("Only the admin can share a link to the group");
    const group = this.stored.get(groupId)!;
    if (!group.entry || reset) {
      await this.closeEntries(groupId);
      group.entry = { seedB64: createIdentity().seedB64, createdAt: Date.now() };
      await this.store.putGroup(group);
      this.lastPoll.delete(groupId);
    }
    // Asked for the link: it is being handed out, and whoever gets it opens it soon.
    this.warmUntil.set(groupId, Date.now() + this.timings.warmMs);
    this.host.emit();
    return encodeGroupEntryLink(this.entryOf(group)!.link);
  }

  async disableLink(groupId: string): Promise<void> {
    if (this.isCommunity(groupId)) { await this.communities.replaceLink(groupId, true); return; }
    const group = this.stored.get(groupId);
    if (!group?.entry) return;
    delete group.entry;
    await this.store.putGroup(group);
    await this.closeEntries(groupId);
    this.host.emit();
  }

  /**
   * Joins through a group's link: a fresh member key, an entry session toward the link's entry
   * key, and knocks until the admin's app answers on it. Nothing is asked of the person again:
   * opening the link was the consent, and the welcome must come from the key the link named.
   */
  async joinByLink(code: string): Promise<string> {
    if (decodeCommunityLink(code)) {
      const g = decodeCommunityLink(code)!.g;
      if (this.stored.has(g)) await this.forget(g);
      return this.communities.joinByLink(code);
    }
    const link = decodeGroupEntryLink(code);
    if (!link) throw new Error("This is not a link to a group");
    if (this.isCommunity(link.g)) throw new Error("This group is joined with its current link");
    const existing = this.stored.get(link.g);
    if (existing?.state?.status === "active" || existing?.invitation?.entry === link.host) return link.g;
    if (existing?.invitation?.seedB64 && !existing.invitation.entry) throw new Error("You are already joining this group");
    // Out of it (left, removed), invited without answering, or an older link of it: this one replaces that.
    if (existing) await this.forget(link.g);
    const seedB64 = createIdentity().seedB64;
    const linkId = await this.host.openEntry(link, "guest", seedB64, link.host);
    const group: StoredGroup = { id: link.g, createdAt: Date.now(), invitation: { name: "", admin: "", linkId, e: 0, n: 0, seedB64, pieces: [], entry: link.host } };
    this.stored.set(link.g, group);
    await this.store.putGroup(group);
    this.host.emit();
    traceJoin(link.g, "join.start");
    void this.knock(group).catch(() => {});
    return link.g;
  }

  /** Runs the links' timers: admins read knocks, joiners knock. The engine calls it every second or so while online. */
  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const group of [...this.stored.values()]) {
        if (group.left) {
          if (now - group.left.at > LEFT_KEPT_MS) await this.forget(group.id);
          continue;
        }
        if (group.invitation?.entry && !group.state) {
          const waited = now - group.createdAt, every = waited > this.timings.patienceMs ? this.timings.slowKnockMs : this.timings.knockMs;
          // Once the admin's app is on the entry session, knocking only spends the relays' budget its signaling needs.
          const answered = this.host.linkReady(group.invitation.linkId) || !!this.host.linkSeen?.(group.invitation.linkId);
          if (!answered && now - (this.lastKnock.get(group.id) ?? 0) >= every) await this.knock(group, now).catch(() => {});
          continue;
        }
        const session = this.sessions.get(group.id);
        if (!group.entry || !session) continue;
        if (!session.isAdmin) { await this.disableLink(group.id); continue; }
        const pending = this.pendingEntries.get(group.id);
        for (const [key, since] of pending ?? []) if (now - since > ENTRY_TIMEOUT_MS) {
          pending!.delete(key);
          const timeouts = (this.entryTimeouts.get(key)?.count ?? 0) + 1;
          this.entryTimeouts.set(key, { count: timeouts, at: now });
          this.refused.set(key, now + Math.min(ENTRY_RETRY_MS * 2 ** (timeouts - 1), REFUSED_FOR_MS));
          const linkId = this.host.entries(group.id).get(key);
          if (linkId) await this.host.closeEdge(linkId);
        }
        const every = now < (this.warmUntil.get(group.id) ?? 0) ? this.timings.warmPollMs : this.timings.pollMs;
        // With every entry session taken, or no room, a knock read now could open nothing: its requests go to the edges.
        const busy = (pending?.size ?? 0) >= MAX_PENDING_ENTRIES || session.roster.length + (pending?.size ?? 0) >= GROUP_MEMBER_CAP.max;
        if (!busy && now - (this.lastPoll.get(group.id) ?? 0) >= every) { this.lastPoll.set(group.id, now); await this.answerKnocks(group, session, now).catch(() => {}); }
      }
      for (const [key, until] of this.refused) if (until <= now) this.refused.delete(key);
      for (const [key, { at }] of this.entryTimeouts) if (now - at > 60 * 60_000) this.entryTimeouts.delete(key);
      this.meshTick(now);
      await this.communities.tick(now);
      await this.hubsTick(now);
    } finally { this.ticking = false; }
  }

  /**
   * Private groups past 16 members: their hubs (WISP 9xx · Group Mesh § Hubs), then their edges, when what the hubs
   * ask for is not what exists (a hub came or went, I became one, a member asked me).
   */
  private async hubsTick(now: number): Promise<void> {
    for (const [groupId, at] of this.removedAt) if (now - at >= REMOVED_LINGER_MS) { this.removedAt.delete(groupId); this.reconcileEdges(groupId); }
    for (const [groupId, session] of this.sessions) {
      const group = this.stored.get(groupId);
      if (!group || group.left || session.status !== "active" || !this.hubs.large(session)) continue;
      await this.hubs.tick(groupId, session, group, now).catch(() => false);
      if (this.hubReconcile.has(groupId)) continue;
      const wanted = this.hubs.edgesWanted(groupId, session, group, now);
      const edges = this.host.edges(groupId);
      if ([...wanted].some(key => !edges.has(key)) || [...edges.keys()].some(key => !wanted.has(key))) {
        this.hubReconcile.add(groupId);
        this.reconcileEdges(groupId, () => this.hubReconcile.delete(groupId));
      }
    }
  }

  /** An entry session came up with groups on both sides: the admin's side invites over it. */
  entryReady(groupId: string, linkId: string, peer: string): void {
    if (this.isCommunity(groupId)) { this.communities.entryReady(groupId, linkId, peer); return; }
    const session = this.sessions.get(groupId), group = this.stored.get(groupId);
    if (!session?.isAdmin || !group || !this.pendingEntries.get(groupId)?.has(peer)) return;
    // An app that takes only eight cannot follow a larger roster: it is not let in past eight (and not answered for a while).
    if (this.growthBlocked(group, session, session.roster.length + 1, linkId)) {
      this.pendingEntries.get(groupId)?.delete(peer);
      this.refused.set(peer, Date.now() + REFUSED_FOR_MS);
      void this.host.closeEdge(linkId);
      return;
    }
    try { this.host.sendOnLink(linkId, session.inviteFrame()); } catch { return; }
    traceJoin(groupId, "invite.sent");
    let set = this.invited.get(groupId);
    if (!set) this.invited.set(groupId, (set = new Set()));
    set.add(linkId);
  }

  private joinStage(group: StoredGroup): GroupJoinStage {
    const invitation = group.invitation!;
    if (invitation.admin) return "admitted";
    if (this.host.linkReady(invitation.linkId) || this.host.linkSeen?.(invitation.linkId)) return "answered";
    return this.knocked.has(group.id) ? "knocked" : "knocking";
  }

  private entryOf(group: StoredGroup): { link: GroupEntryLink; seedB64: string } | undefined {
    return group.entry ? { link: { g: group.id, host: identityFromSeedB64(group.entry.seedB64).pubKeyZ32 }, seedB64: group.entry.seedB64 } : undefined;
  }

  private async closeEntries(groupId: string): Promise<void> {
    this.pendingEntries.delete(groupId);
    const invited = this.invited.get(groupId);
    for (const linkId of this.host.entries(groupId).values()) { invited?.delete(linkId); await this.host.closeEdge(linkId); }
  }

  private async knock(group: StoredGroup, now = Date.now()): Promise<void> {
    const invitation = group.invitation!;
    this.lastKnock.set(group.id, now);
    const link = { g: group.id, host: invitation.entry! }, identity = knockIdentity(link);
    const started = Date.now();
    const existing = readKnocks(link, (await this.host.resolve(identity.pubKeyZ32)) ?? []);
    traceJoin(group.id, "knock.read", { ms: Date.now() - started, others: existing.length });
    await this.host.publish(identity, knockRecords(link, mergeKnocks(existing, { key: identityFromSeedB64(invitation.seedB64!).pubKeyZ32, ts: now }, now)));
    traceJoin(group.id, "knock.published", { ms: Date.now() - started });
    if (!this.knocked.has(group.id)) { this.knocked.add(group.id); this.host.emit(); }
  }

  private async answerKnocks(group: StoredGroup, session: GroupSession, now: number): Promise<void> {
    const entry = this.entryOf(group)!;
    const started = Date.now();
    const knocks = readKnocks(entry.link, (await this.host.resolve(knockIdentity(entry.link).pubKeyZ32)) ?? []);
    traceJoin(group.id, "knocks.read", { ms: Date.now() - started, knocks: knocks.length });
    let pending = this.pendingEntries.get(group.id);
    for (const { key, ts } of knocks) {
      if (now - ts > KNOCK_TTL_MS || rosterHas(session.roster, key) || this.refused.has(key) || pending?.has(key) || key === entry.link.host) continue;
      const entryIds = new Set(this.host.entries(group.id).values());
      const contactsInvited = [...this.invited.get(group.id) ?? []].filter(id => !entryIds.has(id)).length;
      const size = session.roster.length + contactsInvited + (pending?.size ?? 0);
      // Full, or past eight while a member's app takes only eight (the newcomer's own app is checked on its entry session).
      if ((pending?.size ?? 0) >= MAX_PENDING_ENTRIES || size >= GROUP_MEMBER_CAP.max || this.growthBlocked(group, session, size + 1)) break;
      if (!pending) this.pendingEntries.set(group.id, (pending = new Map()));
      pending.set(key, now);
      this.warmUntil.set(group.id, now + this.timings.warmMs);
      traceJoin(group.id, "knock.seen", { age: Date.now() - ts });
      try { await this.host.openEntry(entry.link, "host", entry.seedB64, key); } catch { pending.delete(key); }
    }
  }

  /** The admin's entry session this link is, and whom it is pinned to. */
  private hostEntry(groupId: string, linkId: string): string | undefined {
    for (const [peer, id] of this.host.entries(groupId)) if (id === linkId && this.pendingEntries.get(groupId)?.has(peer)) return peer;
    return undefined;
  }

  // -- frames --------------------------------------------------------------

  /** A `group-*` frame on a contact chat: the admission exchange. */
  async handleContactFrame(linkId: string, frame: Record<string, unknown>): Promise<void> {
    const g = typeof frame.g === "string" ? frame.g : "";
    if (!/^[A-Za-z0-9_-]{22}$/.test(g)) return;
    // Community admission runs on entry sessions only; a mesh app never sees these (it announces 1 only).
    if (this.isCommunity(g) || frame.v === 2) { if (this.isCommunity(g)) await this.communities.handleEntryFrame(linkId, frame); return; }
    switch (frame.t) {
      case "group-invite": {
        if (typeof frame.admin !== "string" || !MEMBER_KEY.test(frame.admin) || typeof frame.name !== "string") return;
        const existing = this.stored.get(g);
        // Through the group's link: the entry session is pinned to the key the link named, so this is its admin. Accepted at once.
        if (existing?.invitation?.entry && !existing.state) {
          if (existing.invitation.linkId !== linkId) return;
          existing.invitation = { ...existing.invitation, name: frame.name.slice(0, 48), admin: frame.admin, pieces: [],
            e: Number.isSafeInteger(frame.e) ? frame.e as number : 0, n: Number.isSafeInteger(frame.n) ? frame.n as number : 1 };
          await this.store.putGroup(existing);
          traceJoin(g, "invite.received");
          this.host.sendOnLink(linkId, { t: "group-accept", g, key: identityFromSeedB64(existing.invitation.seedB64!).pubKeyZ32 });
          this.host.emit();
          return;
        }
        if (existing?.state && existing.state.status === "active") return;
        if (existing?.invitation?.seedB64) return; // already accepting one
        if ([...this.stored.values()].filter(x => x.invitation).length >= 32) return;
        const invitation: StoredGroup = { id: g, createdAt: Date.now(), invitation: { name: frame.name.slice(0, 48), admin: frame.admin, linkId,
          e: Number.isSafeInteger(frame.e) ? frame.e as number : 0, n: Number.isSafeInteger(frame.n) ? frame.n as number : 1, pieces: [] } };
        if (existing) { this.sessions.delete(g); for (const edge of this.host.edges(g).values()) await this.host.closeEdge(edge); }
        this.stored.set(g, invitation);
        await this.store.putGroup(invitation);
        this.host.emit();
        return;
      }
      case "group-accept": {
        const session = this.sessions.get(g);
        if (!session?.isAdmin || !this.invited.get(g)?.has(linkId) || typeof frame.key !== "string" || !MEMBER_KEY.test(frame.key)) return;
        const group = this.stored.get(g)!;
        // Through the link, the member key must be the one the entry session is pinned to: the one that knocked.
        const entryPeer = this.hostEntry(g, linkId);
        if ([...this.host.entries(g).values()].includes(linkId) && entryPeer !== frame.key) return;
        if (session.roster.length >= GROUP_MEMBER_CAP.max || this.growthBlocked(group, session, session.roster.length + 1, linkId)) return;
        if (!entryPeer) {
          // The contact's name on our chat is the best name for them until their edge says otherwise.
          await session.setNick(frame.key, this.host.contactName(linkId));
        }
        this.meet(g, frame.key);
        if (this.host.linkReady(linkId, GROUP_VERSION_LARGE)) this.markLarge(group, frame.key);
        const welcome = await session.admit(frame.key);
        if (!entryPeer) group.contacts = { ...group.contacts, [frame.key]: linkId };
        await this.store.putGroup(group);
        this.invited.get(g)?.delete(linkId);
        for (const piece of welcome) this.host.sendOnLink(linkId, piece);
        if (entryPeer) traceJoin(g, "welcome.sent");
        if (entryPeer) {
          this.entryTimeouts.delete(entryPeer);
          this.pendingEntries.get(g)?.delete(entryPeer);
          this.host.entryDone?.(linkId);
          setTimeout(() => { if (this.host.entries(g).get(entryPeer) === linkId) void this.host.closeEdge(linkId); }, ENTRY_LINGER_MS);
        }
        this.host.emit();
        return;
      }
      case "group-decline": {
        const entryPeer = this.hostEntry(g, linkId);
        if (entryPeer) { this.pendingEntries.get(g)?.delete(entryPeer); await this.host.closeEdge(linkId); }
        if (this.invited.get(g)?.delete(linkId)) this.host.emit();
        return;
      }
      case "group-chain": {
        const group = this.stored.get(g);
        if (!group?.invitation?.seedB64 || group.invitation.linkId !== linkId || !Array.isArray(frame.commits)) return;
        if (group.invitation.pieces.reduce((n, p) => n + p.commits.length, 0) + frame.commits.length > MAX_GROUP_CHAIN) return;
        group.invitation.pieces.push({ t: "group-chain", g, commits: frame.commits as GroupCommit[] });
        return;
      }
      case "group-welcome": {
        const group = this.stored.get(g);
        if (!group?.invitation?.seedB64 || group.invitation.linkId !== linkId) return;
        const joined = GroupSession.join({ name: group.invitation.name, admin: group.invitation.admin }, group.invitation.pieces, frame, group.invitation.seedB64);
        if ("error" in joined) { group.invitation.pieces = []; return; }
        const viaLink = !!group.invitation.entry;
        this.meet(g, group.invitation.admin);
        // An entry session is not a contact chat: once in, the edges carry everything.
        const member: StoredGroup = { id: g, createdAt: group.createdAt, state: joined.state, contacts: viaLink ? {} : { [group.invitation.admin]: linkId } };
        // Attached before anything awaits: the list must never see a member row without its session.
        this.stored.set(g, member);
        this.attach(joined.state);
        await this.store.putGroup(member);
        if (!viaLink) await this.sessions.get(g)!.setNick(group.invitation.admin, this.host.contactName(linkId));
        await this.event(g, "joined", `You joined. ${GROUP_READ_NOTE}`, Date.now(), joined.state.chain.length - 1);
        if (viaLink) traceJoin(g, "welcome.received");
        if (viaLink) { this.lastKnock.delete(g); this.knocked.delete(g); await this.host.closeEdge(linkId); }
        this.reconcileEdges(g);
        this.host.emit();
        return;
      }
      case "group-removed": {
        const session = this.sessions.get(g);
        const group = this.stored.get(g);
        if (group?.left && group.contacts?.[group.left.admin] === linkId) { await this.leaveConfirmed(g); return; }
        if (!session || !group || session.status !== "active" || !session.admin || group.contacts?.[session.admin] !== linkId) return;
        await session.markRemoved();
        return;
      }
      case "group-leave": {
        // A member I invited from my contacts leaves, and says so on our chat too: its edge may be down.
        const session = this.sessions.get(g);
        const group = this.stored.get(g);
        const member = Object.entries(group?.contacts ?? {}).find(([, id]) => id === linkId)?.[0];
        if (!session?.isAdmin || !member || member === session.myKey) return;
        // Its edge may have carried the same leave a moment ago: removed once is enough.
        if (rosterHas(session.roster, member)) await session.remove(member).catch(() => {});
        try { this.host.sendOnLink(linkId, { t: "group-removed", g }); } catch { /* the commit reaches it on the edge */ }
        return;
      }
    }
  }

  /** A `group-*` frame on an edge: from the member the edge is pinned to. */
  async handleEdgeFrame(groupId: string, peerKey: string, frame: unknown): Promise<void> {
    if (this.isCommunity(groupId)) return this.communities.handleEdgeFrame(groupId, peerKey, frame);
    const left = this.stored.get(groupId)?.left;
    if (left) {
      // Only one thing matters to a group I left: the admin's commit that removes me.
      if (this.removesMe(groupId, peerKey, frame)) await this.leaveConfirmed(groupId);
      return;
    }
    const session = this.sessions.get(groupId);
    if (session?.status === "active" && frame && typeof frame === "object" && (frame as { t?: unknown }).t === "group-here") { this.heardHere(groupId, session, peerKey, frame as Record<string, unknown>); return; }
    if (session?.status === "active" && frame && typeof frame === "object" && (frame as { t?: unknown }).t === "group-reach") {
      const group = this.stored.get(groupId);
      if (group && this.hubs.enabled && this.hubs.reached(groupId, session, group, peerKey, frame as Record<string, unknown>, this.now())) await this.store.putGroup(group);
      this.host.emit();
      return;
    }
    if (!session) return;
    const t = frame && typeof frame === "object" ? (frame as { t?: unknown }).t : undefined;
    if (t === GROUP_REACTION_FRAME || t === GROUP_REACTED_FRAME) { await this.reaction(groupId, session, peerKey, frame as Record<string, unknown>); return; }
    if (t === GROUP_TYPING_FRAME) { this.typings.heard(session, peerKey, frame); return; }
    const taken = await session.handle(peerKey, frame);
    // As a hub, what was new here goes on to the other edges (WISP 9xx · Group Mesh § Hubs).
    if (taken.length) this.hubs.passOn(groupId, session, peerKey, taken);
  }

  /**
   * A reaction: from the member whose edge it came on (`group-react`), or signed by a member and passed on by a hub
   * (`group-reacted`). As a hub, a signed one goes on to the other edges (WISP 9xx · Group Mesh § Hubs).
   */
  private async reaction(groupId: string, session: GroupSession, from: string, raw: Record<string, unknown>): Promise<void> {
    if (session.status !== "active" || raw.g !== groupId) return;
    let member: string, reaction: WireReaction;
    if (raw.t === GROUP_REACTION_FRAME) {
      const direct = readReaction(raw);
      if (!direct || !rosterHas(session.roster, from) || from === session.myKey) return;
      member = from; reaction = direct;
      const signed = session.signedReaction(raw);
      if (signed?.member === from) this.hubs.passReaction(groupId, session, from, signed.frame);
    } else {
      const signed = session.signedReaction(raw);
      if (!signed || !this.hubs.enabled) return;
      member = signed.member; reaction = signed.reaction;
      this.hubs.passReaction(groupId, session, from, signed.frame);
    }
    await this.host.groupReaction?.(groupId, member, reaction);
  }

  /** My signature on a reaction of mine in a private group, for hubs to pass it on; nothing for a community. */
  signReaction(groupId: string, reaction: WireReaction): { k: string; sig: string } | Record<string, never> {
    const session = this.sessions.get(groupId);
    return session?.status === "active" && this.hubs.enabled ? session.signReaction(reaction) : {};
  }

  /** A validly signed commit, by the admin I told, that takes me out of the roster. */
  private removesMe(groupId: string, from: string, raw: unknown): boolean {
    const group = this.stored.get(groupId), session = this.sessions.get(groupId);
    // The admin's signature is what counts: with hubs, its commit comes through one of them.
    if (!group?.left || !session || (from !== group.left.admin && !group.left.hubs?.includes(from)) || !raw || typeof raw !== "object" || (raw as { t?: unknown }).t !== "group-commit") return false;
    const commit = verifyCommitSignature((raw as { commit?: unknown }).commit);
    return !!commit && commit.g === groupId && commit.by === group.left.admin && !rosterHas(commit.m, session.myKey);
  }

  /** An edge came up with groups on both sides: both sides say where they are. */
  edgeReady(groupId: string, peerKey: string, linkId: string): void {
    if (this.isCommunity(groupId)) { this.communities.edgeReady(groupId, peerKey, linkId); return; }
    const left = this.stored.get(groupId)?.left;
    if (left) {
      // The admin was away when I left: now it hears it (and a hub carries it, signed, to an admin I have no edge with).
      if (peerKey === left.admin) { try { this.host.sendOnLink(linkId, { t: "group-leave", g: groupId }); } catch { /* next time it opens */ } }
      else if (left.bye && left.hubs?.includes(peerKey)) { try { this.host.sendOnLink(linkId, left.bye); } catch { /* next time it opens */ } }
      return;
    }
    const session = this.sessions.get(groupId), group = this.stored.get(groupId);
    if (!session || !group || session.status !== "active" || !rosterHas(session.roster, peerKey)) return;
    const large = this.host.linkReady(linkId, GROUP_VERSION_LARGE) && this.markLarge(group, peerKey);
    // Whether its app takes part in hubs: one that does not keeps edges with the hubs (WISP 9xx · Group Mesh § Hubs).
    const legacy = this.hubs.enabled && this.hubs.edgeReady(groupId, session, group, peerKey, this.host.linkReady(linkId, GROUP_VERSION_HUBS), this.now());
    if (large || legacy) void this.store.putGroup(group).catch(() => {});
    try { this.host.sendOnLink(linkId, session.syncFrame(this.askOf(groupId, session, peerKey))); } catch { return; /* it closed again */ }
    this.announceHere(groupId, session, peerKey);
    this.host.edgeUp?.(groupId, peerKey);
    this.host.emit();
  }

  /** Records that a member's app takes rosters past eight; true when that is news (the caller saves). */
  private markLarge(group: StoredGroup, key: string): boolean {
    if (group.large?.includes(key)) return false;
    group.large = [...(group.large ?? []), key];
    return true;
  }

  /**
   * Why the group cannot have `size` members yet, or null. Past eight, every other member's app must have said it
   * takes a larger roster (an older one refuses the commit as malformed and stops following the group), and so must
   * the newcomer's, on `linkId`.
   */
  private growthBlocked(group: StoredGroup, session: GroupSession, size: number, linkId?: string): string | null {
    if (size > GROUP_MEMBER_CAP.max) return `A group holds ${GROUP_MEMBER_CAP.max} members at most`;
    // While hubs carry the group, a newcomer must take part: an app without hubs would wait on edges nobody opens.
    if (linkId && this.hubs.active(group.id, session, this.now()) && !this.host.linkReady(linkId, GROUP_VERSION_HUBS)) return "This group runs through hubs, which their app does not take part in: they need an updated Ghostly first.";
    if (size <= LEGACY_GROUP_MEMBERS) return null;
    if (linkId && !this.host.linkReady(linkId, GROUP_VERSION_LARGE)) return `Their app takes groups of ${LEGACY_GROUP_MEMBERS} at most: they need an updated Ghostly first.`;
    const large = new Set(group.large ?? []);
    const behind = session.others.filter(key => !large.has(key));
    if (!behind.length) return null;
    const names = behind.slice(0, 3).map(key => session.state.nicks[key] ?? `Member ${key.slice(0, 8)}`).join(", ");
    return `A group grows past ${LEGACY_GROUP_MEMBERS} only when everyone is on an updated Ghostly. Not seen updated yet: ${names}${behind.length > 3 ? ` and ${behind.length - 3} more` : ""}.`;
  }

  /**
   * Since when each member's edge has been down, counted only from an edge that was up (a member I have not reached
   * since I started is not someone who went away), for `group-here`.
   */
  private noteDown(groupId: string, session: GroupSession, away: string[], now: number): void {
    let down = this.downSince.get(groupId);
    if (!down) this.downSince.set(groupId, (down = new Map()));
    for (const key of session.others) {
      if (!away.includes(key)) down.set(key, 0);
      else if (down.get(key) === 0) down.set(key, now);
    }
  }

  /**
   * A member whose edge just opened again after a while away: the others are told (`group-here`), so they look fast
   * for it instead of at the slow pace of a large group's edges. Whoever reaches it first says so; one told a moment
   * ago stays quiet. Older apps drop the frame.
   */
  private announceHere(groupId: string, session: GroupSession, key: string): void {
    const now = this.now(), down = this.downSince.get(groupId);
    const since = down?.get(key);
    down?.set(key, 0);
    if (!since || now - since < HERE_AFTER_MS || now - (this.hereHeard.get(groupId)?.get(key) ?? -Infinity) < HERE_AFTER_MS) return;
    const edges = this.host.edges(groupId);
    for (const other of session.others) {
      const edge = edges.get(other);
      if (other === key || !edge || !this.host.linkReady(edge)) continue;
      try { this.host.sendOnLink(edge, { t: "group-here", g: groupId, k: key }); } catch { /* closing */ }
    }
  }

  /** Told that a member is back: my edge to it looks fast a while, unless it is up already. */
  private heardHere(groupId: string, session: GroupSession, from: string, frame: Record<string, unknown>): void {
    const key = frame.k;
    if (typeof key !== "string" || key === session.myKey || key === from || !rosterHas(session.roster, key) || !rosterHas(session.roster, from)) return;
    let heard = this.hereHeard.get(groupId);
    if (!heard) this.hereHeard.set(groupId, (heard = new Map()));
    const now = this.now();
    if (now - (heard.get(key) ?? -Infinity) < EXPECT_AGAIN_MS) return;
    heard.set(key, now);
    const edge = this.host.edges(groupId).get(key);
    if (!edge || this.host.linkReady(edge)) return;
    const acted = (this.hereActed.get(groupId) ?? []).filter(at => now - at < 60_000);
    if (acted.length >= HERE_PER_MINUTE) return;
    this.hereActed.set(groupId, [...acted, now]);
    this.host.expectPeer?.(edge);
  }

  /** Members whose edges to me are down. */
  private unreachable(groupId: string, session: GroupSession): string[] {
    const edges = this.host.edges(groupId);
    return session.others.filter(key => { const edge = edges.get(key); return !edge || !this.host.linkReady(edge); });
  }

  /**
   * The unreachable members whose messages `via` should hand on to me: each is asked of one connected member at a
   * time, so a member whose edges open one after another is not sent the same messages by each of them.
   */
  private askOf(groupId: string, session: GroupSession, via: string): string[] {
    let asked = this.relayAsked.get(groupId);
    if (!asked) this.relayAsked.set(groupId, (asked = new Map()));
    const edges = this.host.edges(groupId), now = this.now();
    const up = (key: string) => { const edge = edges.get(key); return !!edge && this.host.linkReady(edge); };
    const out: string[] = [];
    for (const key of this.unreachable(groupId, session)) {
      if (key === via) continue;
      // Asked lately of a member still connected (this one included): its answer is on the way.
      const prior = asked.get(key);
      if (prior && up(prior.via) && now - prior.at < MESH_GOSSIP_MS) continue;
      asked.set(key, { via, at: now });
      out.push(key);
    }
    // What this sync asks for is the gossip turn's job too: the next one waits.
    if (out.length) this.lastGossip.set(groupId, now);
    return out;
  }

  /**
   * While some member is unreachable, one connected member (in turn) is asked, once a `MESH_GOSSIP_MS`, for what it
   * has from the unreachable ones: a message sent while the author could reach it and not me gets here within that,
   * without either edge opening again. Edges the roster asks for and that do not exist are opened again.
   */
  private meshTick(now: number): void {
    this.tickNow = now;
    const reconcile = now - this.lastReconcile >= RECONCILE_MS;
    if (reconcile) this.lastReconcile = now;
    for (const [groupId, session] of this.sessions) {
      if (session.status !== "active" || this.stored.get(groupId)?.left) continue;
      if (reconcile) {
        const edges = this.host.edges(groupId);
        // A large group's edges follow its hubs, every tick (`hubsTick`).
        if (!this.hubs.large(session) && session.others.some(key => !edges.has(key))) this.reconcileEdges(groupId);
      }
      const away = this.unreachable(groupId, session);
      this.noteDown(groupId, session, away, now);
      if (now - (this.lastGossip.get(groupId) ?? -Infinity) < MESH_GOSSIP_MS) continue;
      const edges = this.host.edges(groupId);
      const connected = session.others.filter(key => !away.includes(key));
      if (!away.length || !connected.length) continue;
      this.lastGossip.set(groupId, now);
      const via = connected[this.gossipTurn++ % connected.length];
      const asked = this.relayAsked.get(groupId) ?? new Map<string, { via: string; at: number }>();
      this.relayAsked.set(groupId, asked);
      for (const key of away) asked.set(key, { via, at: now });
      try { this.host.sendOnLink(edges.get(via)!, session.syncFrame(away)); } catch { /* it closed: the next turn asks another */ }
    }
  }

  edgeNick(groupId: string, peerKey: string, nick: string | undefined): void {
    if (this.isCommunity(groupId)) { this.communities.edgeNick(groupId, peerKey, nick); return; }
    void this.sessions.get(groupId)?.setNick(peerKey, nick);
  }

  // -- internals -----------------------------------------------------------

  private session(groupId: string): GroupSession {
    const session = this.sessions.get(groupId);
    if (!session) throw new Error("Group not found");
    return session;
  }

  private attach(state: GroupState): void {
    const session: GroupSession = new GroupSession(state, {
      save: async next => {
        const group = this.stored.get(state.id);
        if (!group) return;
        group.state = next;
        await this.store.putGroup(group);
      },
      send: (to, frame: GroupEdgeFrame) => {
        const edge = this.host.edges(state.id).get(to);
        if (!edge) return;
        try { this.host.sendOnLink(edge, frame); } catch { return; /* down: the sync on reopening carries it */ }
        // Mine, taken by an edge (the first time, or again in a catch-up): what `--wait sent` waits for.
        if ((frame.t === "group-msg" || frame.t === GROUP_EDIT_FRAME) && frame.s === session.myKey) {
          const id = groupMessageId(frame.s, frame.e, frame.n);
          this.frames.add(state.id, frame.t === GROUP_EDIT_FRAME ? editKey(id, frame.v) : id);
        }
      },
      message: async m => {
        // The sender picks the time: one far ahead would pin the group to the top of the list.
        const timestamp = receivedTimestamp(m.timestamp);
        const mentioned = m.sender !== session.myKey && mentionsMember(m.mentions, session.myKey);
        if (mentioned) this.lastMentionAt.set(state.id, Math.max(this.lastMentionAt.get(state.id) ?? 0, timestamp));
        await this.host.storeMessage({ linkId: MESSAGE_LINK(state.id), id: m.id, text: m.text, sender: m.sender === session.myKey ? "me" : "peer", member: m.sender, timestamp, via: "datalink",
          ...mentionFields(m.mentions, mentioned), ...(m.reply && { replyTo: groupReply(m.reply, session.myKey) }), ...(m.forwarded && { forwarded: m.forwarded }) });
        this.lastMessageAt.set(state.id, Math.max(this.lastMessageAt.get(state.id) ?? 0, timestamp));
        // What the member was typing arrived: it is not typing any more.
        this.typings.messageFrom(state.id, m.sender);
      },
      edit: e => this.host.groupEdit?.(state.id, e),
      changed: () => {
        // Taken out as a hub: my edges stay a moment, for my last act, passing on the commit that says so (WISP 9xx § Hubs).
        if (session.status === "removed" && this.hubs.isHub(state.id) && !this.removedAt.has(state.id)) this.removedAt.set(state.id, this.now());
        void this.membershipChanged(state.id);
      },
      metaChanged: (by, change) => { void this.metaChanged(state.id, session, by, change); },
    });
    this.sessions.set(state.id, session);
    this.lastRoster.set(state.id, session.roster);
  }

  private async membershipChanged(groupId: string): Promise<void> {
    const session = this.sessions.get(groupId);
    if (!session) return;
    const before = this.lastRoster.get(groupId) ?? [], after = session.roster, top = session.top;
    this.lastRoster.set(groupId, after);
    const name = (key: string) => key === session.myKey ? "You" : session.state.nicks[key] ?? `Member ${key.slice(0, 8)}`;
    const when = Date.now();
    if (session.status === "removed") await this.event(groupId, "removed", session.state.statusReason ?? "You were removed from this group", when, session.epoch);
    else if (session.status === "forked") await this.event(groupId, "forked", session.state.statusReason ?? "The membership history forked", when, session.epoch);
    else if (session.status === "active") {
      for (const [key] of after) if (!rosterHas(before, key) && key !== session.myKey) await this.event(groupId, "joined", `${name(key)} joined`, when, top.e, key);
      const gone = before.filter(([key]) => !rosterHas(after, key)).map(([key]) => key);
      this.hubs.removed(groupId, gone, this.now());
      for (const key of gone) await this.event(groupId, "gone", `${name(key)} is no longer a member`, when, top.e, key);
      if (top.k === "role") await this.event(groupId, "admin", `${name(top.s!)} ${top.s === session.myKey ? "are" : "is"} now the admin`, when, top.e, top.s);
      if (top.k === "rotate") await this.event(groupId, "rotated", "Keys rotated: a fresh epoch", when, top.e);
    }
    this.reconcileEdges(groupId);
    this.host.emit();
  }

  private async metaChanged(groupId: string, session: GroupSession, by: string, change: GroupMetaChange): Promise<void> {
    const name = by === session.myKey ? "You" : session.state.nicks[by] ?? `Member ${by.slice(0, 8)}`;
    for (const line of metaLines(name, change, session.name)) await this.event(groupId, line.event, line.text, Date.now(), session.epoch, by);
    this.host.emit();
  }

  /**
   * Every other member has an edge, nobody else does; none once I am out. With hubs, only the edges they ask for
   * (`MeshHubs.wanted`); after I left, the edges to the admin and to the hubs that carry my leave.
   */
  private reconcileEdges(groupId: string, done?: () => void): void {
    this.reconciling = this.reconciling.then(async () => {
      const session = this.sessions.get(groupId), group = this.stored.get(groupId);
      const existing = this.host.edges(groupId);
      const left = group?.left;
      const removed = this.removedAt.get(groupId);
      const wanted = session?.status === "active" && group ? this.hubs.edgesWanted(groupId, session, group, this.now())
        : left ? new Set([left.admin, ...left.hubs ?? []])
        : removed !== undefined && this.now() - removed < REMOVED_LINGER_MS ? new Set(existing.keys()) : new Set<string>();
      for (const [key, linkId] of existing) if (!wanted.has(key)) await this.host.closeEdge(linkId);
      const met = this.justMet.get(groupId);
      if (session) for (const key of wanted) if (!existing.has(key)) {
        const expect = !!met?.delete(key) || this.hubs.takeExpect(groupId, key);
        try { await this.host.openEdge(session.state, key, expect); } catch { /* tried again next time */ }
      }
      this.host.emit();
    }).catch(() => {}).finally(() => done?.());
  }

  /** The admin and the member it admits were both here a moment ago: the edge between them is expected at once, and kept a while with hubs. */
  private meet(groupId: string, key: string): void {
    let set = this.justMet.get(groupId);
    if (!set) this.justMet.set(groupId, (set = new Set()));
    set.add(key);
    this.hubs.met(groupId, key, this.now());
  }

  /** `member`: whom it is about, so the apps can name them as they are known now, not as they were then. */
  /** A line in the group's history; lines at the same time (two members gone in one change) get distinct ones, see `Communities.event`. */
  private async event(groupId: string, event: GroupEvent, text: string, timestamp: number, epoch: number, member?: string): Promise<void> {
    const last = this.lastEventAt.get(groupId) ?? 0;
    if (timestamp <= last) timestamp = last + 1;
    this.lastEventAt.set(groupId, Math.max(last, timestamp));
    await this.host.storeMessage({ linkId: MESSAGE_LINK(groupId), id: `event:${epoch}:${event}:${timestamp}`, text, sender: "peer", event, member, timestamp, via: "datalink" });
  }
  private readonly lastEventAt = new Map<string, number>();
}

