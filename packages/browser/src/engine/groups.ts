import {
  GroupSession, MAX_GROUP_CHAIN, GROUP_READ_NOTE, MEMBER_KEY, createIdentity, identityFromSeedB64, rosterHas,
  type GroupCommit, type GroupEdgeFrame, type GroupState, type Roster,
} from "@ghostly/core";
import type { GroupEvent, GroupView, StoredGroup, StoredMessage } from "../shared/types";
import { db } from "./db";

/** What the engine gives the groups: its links, its storage and its state emitter. */
export interface GroupsHost {
  /** Sends a frame on a paired link (a contact chat or an edge). Throws when it cannot. */
  sendOnLink(linkId: string, frame: object): void;
  /** The link is open and both sides announced groups. */
  linkReady(linkId: string): boolean;
  /** A name for a contact chat, for the invitation. */
  contactName(linkId: string): string | undefined;
  /** Member key → edge link id, for the edges of this group that exist. */
  edges(groupId: string): Map<string, string>;
  /** Creates and starts the edge of a group toward a member; resolves to its link id. */
  openEdge(state: GroupState, peerMemberKey: string): Promise<string>;
  closeEdge(linkId: string): Promise<void>;
  /** The nick the member at the other end of an edge announced. */
  edgeNick(linkId: string): string | undefined;
  storeMessage(message: StoredMessage): Promise<void>;
  emit(): void;
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

  constructor(private readonly host: GroupsHost, private readonly store: GroupStore = db) {}

  async load(): Promise<void> {
    for (const group of await this.store.getGroups()) {
      this.stored.set(group.id, group);
      if (group.state) this.attach(group.state);
      const history = await this.store.getMessages(MESSAGE_LINK(group.id)), last = history[history.length - 1];
      if (last) this.lastMessageAt.set(group.id, last.timestamp);
    }
    for (const id of this.sessions.keys()) this.reconcileEdges(id);
  }

  views(): GroupView[] {
    return [...this.stored.values()].map(group => {
      const session = this.sessions.get(group.id);
      const edges = this.host.edges(group.id);
      const contacts = group.contacts ?? {};
      const base = { id: group.id, createdAt: group.createdAt, lastMessageAt: this.lastMessageAt.get(group.id) ?? 0, invited: [...(this.invited.get(group.id) ?? [])],
        memberLinks: Object.fromEntries(Object.entries(contacts).map(([key, linkId]) => [linkId, key])) };
      if (!session) {
        const invitation = group.invitation!;
        return { ...base, name: invitation.name, isAdmin: false, members: [], canSend: false,
          invitation: { linkId: invitation.linkId, contact: this.host.contactName(invitation.linkId) ?? "", admin: invitation.admin, members: invitation.n, accepted: !!invitation.seedB64 } };
      }
      const nicks = session.state.nicks;
      return { ...base, name: session.name, status: session.status, statusReason: session.state.statusReason, epoch: session.epoch, myKey: session.myKey, isAdmin: session.isAdmin,
        canSend: session.status === "active" && session.readableEpochs.includes(session.epoch),
        members: session.roster.map(([key, role]) => {
          const edge = edges.get(key);
          return { key, role, me: key === session.myKey, nick: key === session.myKey ? undefined : (edge && this.host.edgeNick(edge)) || nicks[key],
            online: key === session.myKey || (!!edge && this.host.linkReady(edge)), missing: session.missing(key) };
        }) };
    }).sort((a, b) => Math.max(b.lastMessageAt, b.createdAt) - Math.max(a.lastMessageAt, a.createdAt));
  }

  messages(groupId: string): Promise<StoredMessage[]> { return this.store.getMessages(MESSAGE_LINK(groupId)); }

  // -- what the person does ------------------------------------------------

  async create(name: string): Promise<string> {
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
    const session = this.session(groupId);
    if (!session.isAdmin) throw new Error("Only the admin can invite");
    const group = this.stored.get(groupId)!;
    if (Object.values(group.contacts ?? {}).includes(linkId)) throw new Error("This contact is already a member");
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
    const session = this.sessions.get(groupId);
    if (!session) return { error: "You are not in this group yet" };
    const result = await session.sendText(text);
    return "error" in result ? { error: result.error } : { error: null };
  }

  async leave(groupId: string): Promise<void> {
    const session = this.session(groupId);
    const group = this.stored.get(groupId)!;
    const admin = session.admin;
    await session.leave();
    // The admin may be off; its contact chat, if that is how I got here, hears it too.
    const contact = admin && group.contacts?.[admin];
    if (contact) { try { this.host.sendOnLink(contact, { t: "group-leave", g: groupId }); } catch { /* the edge already carried it, or nobody is there */ } }
    await this.event(groupId, "left", "You left the group", Date.now(), session.epoch + 1);
  }

  async remove(groupId: string, key: string): Promise<void> {
    const session = this.session(groupId);
    await session.remove(key);
    const contact = this.stored.get(groupId)!.contacts?.[key];
    if (contact) { try { this.host.sendOnLink(contact, { t: "group-removed", g: groupId }); } catch { /* the commit went over the edge, if it was up */ } }
  }

  makeAdmin(groupId: string, key: string): Promise<void> { return this.session(groupId).transferAdmin(key); }
  rotate(groupId: string): Promise<void> { return this.session(groupId).rotate(); }

  async forget(groupId: string): Promise<void> {
    const session = this.sessions.get(groupId);
    if (session?.status === "active") { try { await this.leave(groupId); } catch { /* the admin cannot leave a group with members: forgetting it is still allowed */ } }
    this.sessions.delete(groupId);
    this.stored.delete(groupId);
    this.invited.delete(groupId);
    this.lastRoster.delete(groupId);
    for (const linkId of this.host.edges(groupId).values()) await this.host.closeEdge(linkId);
    await this.store.deleteGroup(groupId);
    this.host.emit();
  }

  // -- frames --------------------------------------------------------------

  /** A `group-*` frame on a contact chat: the admission exchange. */
  async handleContactFrame(linkId: string, frame: Record<string, unknown>): Promise<void> {
    const g = typeof frame.g === "string" ? frame.g : "";
    if (!/^[A-Za-z0-9_-]{22}$/.test(g)) return;
    switch (frame.t) {
      case "group-invite": {
        if (typeof frame.admin !== "string" || !MEMBER_KEY.test(frame.admin) || typeof frame.name !== "string") return;
        const existing = this.stored.get(g);
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
        // The contact's name on our chat is the best name for them until their edge says otherwise.
        await session.setNick(frame.key, this.host.contactName(linkId));
        const welcome = await session.admit(frame.key);
        group.contacts = { ...group.contacts, [frame.key]: linkId };
        await this.store.putGroup(group);
        this.invited.get(g)?.delete(linkId);
        for (const piece of welcome) this.host.sendOnLink(linkId, piece);
        this.host.emit();
        return;
      }
      case "group-decline":
        if (this.invited.get(g)?.delete(linkId)) this.host.emit();
        return;
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
        const member: StoredGroup = { id: g, createdAt: group.createdAt, state: joined.state, contacts: { [group.invitation.admin]: linkId } };
        this.stored.set(g, member);
        await this.store.putGroup(member);
        this.attach(joined.state);
        await this.sessions.get(g)!.setNick(group.invitation.admin, this.host.contactName(linkId));
        await this.event(g, "joined", `You joined. ${GROUP_READ_NOTE}`, Date.now(), joined.state.chain.length - 1);
        this.reconcileEdges(g);
        this.host.emit();
        return;
      }
      case "group-removed": {
        const session = this.sessions.get(g);
        const group = this.stored.get(g);
        if (!session || !group || session.status !== "active" || !session.admin || group.contacts?.[session.admin] !== linkId) return;
        await session.markRemoved();
        return;
      }
    }
  }

  /** A `group-*` frame on an edge: from the member the edge is pinned to. */
  async handleEdgeFrame(groupId: string, peerKey: string, frame: unknown): Promise<void> {
    await this.sessions.get(groupId)?.handle(peerKey, frame);
  }

  /** An edge came up with groups on both sides: both sides say where they are. */
  edgeReady(groupId: string, peerKey: string, linkId: string): void {
    const session = this.sessions.get(groupId);
    if (!session || session.status !== "active" || !rosterHas(session.roster, peerKey)) return;
    try { this.host.sendOnLink(linkId, session.syncFrame()); } catch { /* it closed again */ }
    this.host.emit();
  }

  edgeNick(groupId: string, peerKey: string, nick: string | undefined): void {
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

  /** Every other member has an edge, nobody else does; none once I am out. */
  private reconcileEdges(groupId: string): void {
    this.reconciling = this.reconciling.then(async () => {
      const session = this.sessions.get(groupId);
      const existing = this.host.edges(groupId);
      const wanted = session?.status === "active" ? new Set(session.others) : new Set<string>();
      for (const [key, linkId] of existing) if (!wanted.has(key)) await this.host.closeEdge(linkId);
      if (session) for (const key of wanted) if (!existing.has(key)) { try { await this.host.openEdge(session.state, key); } catch { /* tried again next time */ } }
      this.host.emit();
    }).catch(() => {});
  }

  /** `member`: whom it is about, so the apps can name them as they are known now, not as they were then. */
  private async event(groupId: string, event: GroupEvent, text: string, timestamp: number, epoch: number, member?: string): Promise<void> {
    await this.host.storeMessage({ linkId: MESSAGE_LINK(groupId), id: `event:${epoch}:${event}:${timestamp}`, text, sender: "peer", event, member, timestamp, via: "datalink" });
  }
}

