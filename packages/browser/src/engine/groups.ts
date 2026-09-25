import {
  GroupSession, MAX_GROUP_CHAIN, GROUP_READ_NOTE, KNOCK_TTL_MS, MEMBER_KEY, createIdentity, decodeGroupEntryLink, encodeGroupEntryLink, identityFromSeedB64,
  knockIdentity, knockRecords, mergeKnocks, readKnocks, rosterHas, verifyCommitSignature, decodeCommunityLink,
  type GhostRecord, type GroupCommit, type GroupEdgeFrame, type GroupEntryLink, type GroupState, type Identity, type Roster,
} from "@ghostly/core";
import type { GroupEvent, GroupJoinStage, GroupView, StoredGroup, StoredMessage } from "../shared/types";
import { db } from "./db";
import { traceJoin } from "./joinTrace";
import { COMMUNITY_TIMINGS, Communities, pictureText, type CommunityTimings } from "./community";

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
}

/** Where groups and their history are kept: the engine's database, or a test's memory. */
export interface GroupStore {
  getGroups(): Promise<StoredGroup[]>;
  putGroup(group: StoredGroup): Promise<void>;
  deleteGroup(groupId: string): Promise<void>;
  getMessages(linkId: string): Promise<StoredMessage[]>;
}

const MESSAGE_LINK = (groupId: string) => `group:${groupId}`;

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
const REFUSED_FOR_MS = 10 * 60_000;
/** The welcome is on its way when the admin sends it; the session stays up a little for it to arrive. */
const ENTRY_LINGER_MS = 20_000;
/** How long the tombstone of a group I left waits for the admin to hear it. */
const LEFT_KEPT_MS = 7 * 24 * 60 * 60_000;

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
  private reconciling = Promise.resolve();
  /** Admin side: joiners with an entry session open, per group: member key → since when. */
  private readonly pendingEntries = new Map<string, Map<string, number>>();
  /** Admin side: member keys whose entry did not finish, not answered again until then. */
  private readonly refused = new Map<string, number>();
  private readonly lastPoll = new Map<string, number>();
  /** Admin side: until when a group's link is looked at the warm pace. */
  private readonly warmUntil = new Map<string, number>();
  private readonly lastKnock = new Map<string, number>();
  /** Per group, members met over their admission a moment ago: their edge is opened expecting them. */
  private readonly justMet = new Map<string, Set<string>>();
  /** Joiner side: groups whose knock is published, for the stage the joiner is shown. */
  private readonly knocked = new Set<string>();
  private ticking = false;
  /** Community groups (`group-community/1`) live in their own engine; this class routes to it. */
  readonly communities: Communities;

  constructor(private readonly host: GroupsHost, private readonly store: GroupStore = db, private readonly timings: EntryTimings = ENTRY_TIMINGS, communityTimings: CommunityTimings = COMMUNITY_TIMINGS, random?: () => number) {
    this.communities = new Communities(host, store, communityTimings, random);
  }

  async load(): Promise<void> {
    const all = await this.store.getGroups();
    await this.communities.load(all.filter(g => g.community || g.joining));
    for (const group of all.filter(g => !g.community && !g.joining)) {
      this.stored.set(group.id, group);
      if (group.state) this.attach(group.state);
      const history = await this.store.getMessages(MESSAGE_LINK(group.id)), last = history[history.length - 1];
      if (last) this.lastMessageAt.set(group.id, last.timestamp);
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
      const base = { id: group.id, profile: "mesh" as const, createdAt: group.createdAt, lastMessageAt: this.lastMessageAt.get(group.id) ?? 0, invited: [...(this.invited.get(group.id) ?? [])],
        memberLinks: Object.fromEntries(contacts.map(([key, linkId]) => [linkId, key])) };
      if (!session) {
        const invitation = group.invitation!;
        return { ...base, name: invitation.name, isAdmin: false, members: [], canSend: false,
          invitation: { linkId: invitation.linkId, contact: this.host.contactName(invitation.linkId) ?? "", admin: invitation.admin, members: invitation.n, accepted: !!invitation.seedB64,
            ...(invitation.entry ? { viaLink: true, stage: this.joinStage(group) } : {}) } };
      }
      const nicks = session.state.nicks;
      const entry = session.isAdmin ? this.entryOf(group) : undefined;
      return { ...base, name: session.name, status: session.status, statusReason: session.state.statusReason, epoch: session.epoch, myKey: session.myKey, isAdmin: session.isAdmin,
        ...(entry ? { entryLink: encodeGroupEntryLink(entry.link) } : {}), ...(session.picture ? { picture: session.picture } : {}),
        canSend: session.status === "active" && session.readableEpochs.includes(session.epoch),
        members: session.roster.map(([key, role]) => {
          const edge = edges.get(key);
          return { key, role, me: key === session.myKey, nick: key === session.myKey ? undefined : (edge && this.host.edgeNick(edge)) || nicks[key],
            online: key === session.myKey || (!!edge && this.host.linkReady(edge)), missing: session.missing(key) };
        }) };
    }).sort((a, b) => Math.max(b.lastMessageAt, b.createdAt) - Math.max(a.lastMessageAt, a.createdAt));
  }

  messages(groupId: string): Promise<StoredMessage[]> { return this.store.getMessages(MESSAGE_LINK(groupId)); }

  private isCommunity(groupId: string): boolean { return this.communities.has(groupId); }
  /** A community group (`group-community/1`) rather than a private one. */
  isCommunityGroup(groupId: string): boolean { return this.isCommunity(groupId); }
  /** Through a community group: an application frame to everyone, or a payload sealed to one member. */
  sendCommunityApp(groupId: string, frame: Record<string, unknown>): Promise<void> { return this.communities.sendApp(groupId, frame); }
  sendCommunityPair(groupId: string, to: string, payload: Record<string, unknown>): Promise<void> { return this.communities.sendPair(groupId, to, payload); }
  /** Resolves once the community frames received so far were handed to the engine (tests). */
  communityIdle(): Promise<void> { return this.communities.idle(); }

  // -- what the person does ------------------------------------------------

  /** A new group: a community (the link is the way in, hundreds of members) or a private mesh of up to eight contacts. */
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
    if (session.roster.length + (this.invited.get(groupId)?.size ?? 0) >= 8) throw new Error("A group holds eight members at most");
    if (!this.host.linkReady(linkId)) throw new Error("Connect to this contact first. Their app needs groups (an updated Ghostly).");
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

  async send(groupId: string, text: string): Promise<{ error: string | null }> {
    if (this.isCommunity(groupId)) return this.communities.send(groupId, text);
    const session = this.sessions.get(groupId);
    if (!session) return { error: "You are not in this group yet" };
    const result = await session.sendText(text);
    return "error" in result ? { error: result.error } : { error: null };
  }

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
    // The history goes with the row; what stays is a tombstone the list does not show. Written
    // before anyone is told, so the admin's answer cannot arrive before it and be undone by it.
    group.left = { at: Date.now(), admin };
    delete group.entry;
    this.invited.delete(groupId);
    this.pendingEntries.delete(groupId);
    this.lastMessageAt.delete(groupId);
    await this.store.deleteGroup(groupId);
    await this.store.putGroup(group);
    for (const linkId of this.host.entries(groupId).values()) await this.host.closeEdge(linkId);
    this.host.emit();
    await session.leave();
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
  rotate(groupId: string): Promise<void> { return this.isCommunity(groupId) ? this.communities.rotate(groupId) : this.session(groupId).rotate(); }
  /** The admin sets or removes the group's picture; every member gets it over the edges (WISP 9xx § Metadata). */
  async setPicture(groupId: string, picture: string | null): Promise<void> {
    if (this.isCommunity(groupId)) return this.communities.setPicture(groupId, picture);
    await this.session(groupId).setPicture(picture);
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
          this.refused.set(key, now + REFUSED_FOR_MS);
          const linkId = this.host.entries(group.id).get(key);
          if (linkId) await this.host.closeEdge(linkId);
        }
        const every = now < (this.warmUntil.get(group.id) ?? 0) ? this.timings.warmPollMs : this.timings.pollMs;
        if (now - (this.lastPoll.get(group.id) ?? 0) >= every) { this.lastPoll.set(group.id, now); await this.answerKnocks(group, session, now).catch(() => {}); }
      }
      for (const [key, until] of this.refused) if (until <= now) this.refused.delete(key);
      await this.communities.tick(now);
    } finally { this.ticking = false; }
  }

  /** An entry session came up with groups on both sides: the admin's side invites over it. */
  entryReady(groupId: string, linkId: string, peer: string): void {
    if (this.isCommunity(groupId)) { this.communities.entryReady(groupId, linkId, peer); return; }
    const session = this.sessions.get(groupId);
    if (!session?.isAdmin || !this.pendingEntries.get(groupId)?.has(peer)) return;
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
      if ((pending?.size ?? 0) >= MAX_PENDING_ENTRIES || session.roster.length + contactsInvited + (pending?.size ?? 0) >= 8) break;
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
        if (entryPeer) {
          if (session.roster.length >= 8) return;
        } else {
          // The contact's name on our chat is the best name for them until their edge says otherwise.
          await session.setNick(frame.key, this.host.contactName(linkId));
        }
        this.meet(g, frame.key);
        const welcome = await session.admit(frame.key);
        if (!entryPeer) group.contacts = { ...group.contacts, [frame.key]: linkId };
        await this.store.putGroup(group);
        this.invited.get(g)?.delete(linkId);
        for (const piece of welcome) this.host.sendOnLink(linkId, piece);
        if (entryPeer) traceJoin(g, "welcome.sent");
        if (entryPeer) {
          this.pendingEntries.get(g)?.delete(entryPeer);
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
    await this.sessions.get(groupId)?.handle(peerKey, frame);
  }

  /** A validly signed commit, by the admin I told, that takes me out of the roster. */
  private removesMe(groupId: string, from: string, raw: unknown): boolean {
    const group = this.stored.get(groupId), session = this.sessions.get(groupId);
    if (!group?.left || !session || from !== group.left.admin || !raw || typeof raw !== "object" || (raw as { t?: unknown }).t !== "group-commit") return false;
    const commit = verifyCommitSignature((raw as { commit?: unknown }).commit);
    return !!commit && commit.g === groupId && commit.by === group.left.admin && !rosterHas(commit.m, session.myKey);
  }

  /** An edge came up with groups on both sides: both sides say where they are. */
  edgeReady(groupId: string, peerKey: string, linkId: string): void {
    if (this.isCommunity(groupId)) { this.communities.edgeReady(groupId, peerKey, linkId); return; }
    const left = this.stored.get(groupId)?.left;
    if (left) {
      // The admin was away when I left: now it hears it.
      if (peerKey === left.admin) { try { this.host.sendOnLink(linkId, { t: "group-leave", g: groupId }); } catch { /* next time it opens */ } }
      return;
    }
    const session = this.sessions.get(groupId);
    if (!session || session.status !== "active" || !rosterHas(session.roster, peerKey)) return;
    try { this.host.sendOnLink(linkId, session.syncFrame()); } catch { /* it closed again */ }
    this.host.emit();
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
        try { this.host.sendOnLink(edge, frame); } catch { /* down: the sync on reopening carries it */ }
      },
      message: async m => {
        await this.host.storeMessage({ linkId: MESSAGE_LINK(state.id), id: m.id, text: m.text, sender: m.sender === session.myKey ? "me" : "peer", member: m.sender, timestamp: m.timestamp, via: "datalink" });
        this.lastMessageAt.set(state.id, Math.max(this.lastMessageAt.get(state.id) ?? 0, m.timestamp));
      },
      changed: () => { void this.membershipChanged(state.id); },
      metaChanged: (by, picture) => { void this.pictureChanged(state.id, session, by, picture); },
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
      for (const [key] of before) if (!rosterHas(after, key)) await this.event(groupId, "gone", `${name(key)} is no longer a member`, when, top.e, key);
      if (top.k === "role") await this.event(groupId, "admin", `${name(top.s!)} ${top.s === session.myKey ? "are" : "is"} now the admin`, when, top.e, top.s);
      if (top.k === "rotate") await this.event(groupId, "rotated", "Keys rotated: a fresh epoch", when, top.e);
    }
    this.reconcileEdges(groupId);
    this.host.emit();
  }

  private async pictureChanged(groupId: string, session: GroupSession, by: string, picture: string | undefined): Promise<void> {
    const name = by === session.myKey ? "You" : session.state.nicks[by] ?? `Member ${by.slice(0, 8)}`;
    await this.event(groupId, "picture", pictureText(name, !!picture), Date.now(), session.epoch, by);
    this.host.emit();
  }

  /** Every other member has an edge, nobody else does; none once I am out. */
  private reconcileEdges(groupId: string): void {
    this.reconciling = this.reconciling.then(async () => {
      const session = this.sessions.get(groupId);
      const existing = this.host.edges(groupId);
      const left = this.stored.get(groupId)?.left;
      const wanted = session?.status === "active" ? new Set(session.others) : left ? new Set([left.admin]) : new Set<string>();
      for (const [key, linkId] of existing) if (!wanted.has(key)) await this.host.closeEdge(linkId);
      const met = this.justMet.get(groupId);
      if (session) for (const key of wanted) if (!existing.has(key)) {
        const expect = !!met?.delete(key);
        try { await this.host.openEdge(session.state, key, expect); } catch { /* tried again next time */ }
      }
      this.host.emit();
    }).catch(() => {});
  }

  /** The admin and the member it admits were both here a moment ago: the edge between them is expected at once. */
  private meet(groupId: string, key: string): void {
    let set = this.justMet.get(groupId);
    if (!set) this.justMet.set(groupId, (set = new Set()));
    set.add(key);
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

