import { identityFromSeedB64, type GhostRecord } from "@ghostly/core";
import { Groups, meshEdgeScale, type GroupStore, type GroupsHost } from "../src/engine/groups";
import { COMMUNITY_TIMINGS, type CommunityTimings } from "../src/engine/community";
import type { StoredGroup, StoredMessage } from "../src/shared/types";

/**
 * Headless peers running the real group engine (`Groups` → `Communities` → `CommunitySession`),
 * with no UI and no WebRTC: Pkarr is a shared map, and an edge or entry session is up when both
 * ends have opened it and both peers are online. Frames are delivered asynchronously, cloned, and
 * counted. The unit tests and the load test (`npm run test:group-load`) share it.
 */
interface Edge {
  g: string; me: string; peer: string; kind: "edge" | "host" | "guest"; announced: boolean;
  /** With a `NetworkModel`: when this side opened it, polls fast until, last polled, polls that found the other side, up since. */
  openedAt: number; fastUntil: number; lastPoll: number; polls: number; upAt?: number; wasUp?: boolean;
  /** An edge opened expecting the other side at once; its presence published (the first thing a link does). */
  expected?: boolean;
  published?: boolean;
  /** It saw the other side, and its offer or answer went out (a write the budget may hold back a while). */
  sawPeer?: boolean;
  signaled?: boolean;
  /** The admission over this entry session is done (`entryDone`): it closes once the other side has. */
  done?: boolean;
}

/**
 * What the in-memory network costs, when a test wants it to (the load and unit tests keep it free):
 * each app's Pkarr budget, and a link that comes up only after both sides polled each other's
 * record a few times (offer, answer), at the pace a `LinkSession` polls on relays: fast while it
 * expects the peer (after opening an entry session or an expected edge, or on finding a fresh
 * packet of the other side), at the background pace otherwise, rarely once up. What each side
 * publishes is charged as a link does: its presence, its offer or answer, the signal cleared once
 * connected. A poll or a publish the budget refuses does not happen.
 */
export interface NetworkModel {
  /** Pkarr requests per app and minute: a resolve costs 1, a publish 2 (it goes to both relays); background ones only up to `backgroundPerMinute`. */
  budgetPerMinute: number;
  backgroundPerMinute: number;
  /** After a link's write the budget refused, reads (and background writes) wait this long, so the write goes first (`WRITE_FIRST_MS`). */
  writeFirstMs: number;
  /** Polls each side needs, once both sides exist, before the link is up. */
  signalPolls: number;
  fastPollMs: number;
  backgroundPollMs: number;
  connectedPollMs: number;
  /** How long a side polls fast after `expectPeer`. */
  expectMs: number;
}
/** The web app on public relays: 30 requests a minute to each of two (20 for background ones, a refused link write first), `RELAY_POLL_INTERVALS`, `EXPECT_PEER_MS`. */
export const RELAY_NETWORK: NetworkModel = { budgetPerMinute: 60, backgroundPerMinute: 40, writeFirstMs: 5_000, signalPolls: 2, fastPollMs: 2_000, backgroundPollMs: 30_000, connectedPollMs: 60_000, expectMs: 30_000 };
export interface Peer {
  name: string;
  groups: Groups;
  store: GroupStore;
  messages: StoredMessage[];
  links: Map<string, Edge>;
  online: boolean;
  nick: string;
  /** Frames and bytes this peer sent. */
  sent: { frames: number; bytes: number };
  /** Pkarr requests (with a `NetworkModel`): when each was made (the background ones also on their own), and how many the budget refused. */
  spent: number[];
  spentBackground: number[];
  refused: number;
  /** When a link write of this app was last refused, while it waits for the budget. */
  writeWaiting?: number;
  /** An app from before hubs (`paired-groups` 3): it keeps every private group a full mesh and does not announce version 4. */
  legacy?: boolean;
  /** An app that stays online (Desktop, CLI): a hub of private groups past 16 members. */
  staysOnline?: boolean;
  /**
   * Its Pkarr requests are counted, never refused: the Desktop app and the CLI read the Mainline DHT, not the relays,
   * so the relays' budget does not hold them back.
   */
  unmetered?: boolean;
  /** The most connections its groups hold (a Mac's `peerBudget`), and how many groups not in this world hold now. */
  peerBudget?: number;
  heldElsewhere?: number;
  /** What its engine runs on: kept for `restart`, which starts a new engine on it. */
  host: GroupsHost;
}

function memoryStore(messages: StoredMessage[]): GroupStore {
  const groups = new Map<string, StoredGroup>();
  return {
    getGroups: async () => [...groups.values()].map(g => structuredClone(g)),
    putGroup: async g => { groups.set(g.id, structuredClone(g)); },
    deleteGroup: async id => { groups.delete(id); for (let i = messages.length - 1; i >= 0; i--) if (messages[i].linkId === `group:${id}`) messages.splice(i, 1); },
    getMessages: async linkId => messages.filter(m => m.linkId === linkId).sort((a, b) => a.timestamp - b.timestamp),
  };
}

export class CommunityWorld {
  readonly peers = new Map<string, Peer>();
  readonly pkarr = new Map<string, GhostRecord[]>();
  now = Date.now();
  pkarrOps = 0;
  /** Sees every Pkarr request an app makes (tests counting what a door reads). */
  onPkarr: ((peer: Peer, op: "resolve" | "publish", key: string, background: boolean) => void) | null = null;
  /** Cuts the network in parts: links (and Pkarr reads) only work within one part. */
  part: ((peer: Peer) => number) | null = null;
  /** Cuts two peers apart (their link and their reads of each other), whatever `part` says. */
  cut: ((a: Peer, b: Peer) => boolean) | null = null;
  private sameSide(a: Peer, b: Peer): boolean { return (!this.part || this.part(a) === this.part(b)) && !this.cut?.(a, b); }
  /** Fails an app's Pkarr reads (a test says whose, and of which key): the relays' budget, or the network. */
  failRead: ((peer: Peer, key: string) => boolean) | null = null;
  /** Loses frames on the way (a test says which): the network is not perfect. */
  drop: ((from: Peer, to: Peer, frame: Record<string, unknown>) => boolean) | null = null;
  private pending: Promise<unknown>[] = [];

  constructor(private readonly timings: CommunityTimings = { ...COMMUNITY_TIMINGS, hubJitterMs: 0 }, readonly network: NetworkModel | null = null, private readonly random: () => number = Math.random) {}

  /** One Pkarr request of `cost`, if the app's budget allows it (always, without a `NetworkModel`). */
  /** Sees every request the network model charges (or refuses), with what it was for. */
  onSpend: ((peer: Peer, what: string, cost: number, ok: boolean) => void) | null = null;
  private spend(peer: Peer, cost: number, background = false, write = false, what = "request"): boolean {
    if (!this.network) return true;
    const ok = this.charge(peer, cost, background, write);
    this.onSpend?.(peer, what, cost, ok);
    return ok;
  }
  private charge(peer: Peer, cost: number, background: boolean, write: boolean): boolean {
    if (!this.network) return true;
    peer.spent = peer.spent.filter(at => this.now - at < 60_000);
    peer.spentBackground = peer.spentBackground.filter(at => this.now - at < 60_000);
    const linkWrite = write && !background;
    if (peer.unmetered) { for (let i = 0; i < cost; i++) peer.spent.push(this.now); return true; }
    if ((!linkWrite && this.now - (peer.writeWaiting ?? -Infinity) < this.network.writeFirstMs) || peer.spent.length + cost > this.network.budgetPerMinute || (background && peer.spentBackground.length + cost > this.network.backgroundPerMinute)) { peer.refused++; if (linkWrite) peer.writeWaiting = this.now; return false; }
    if (linkWrite) peer.writeWaiting = undefined;
    for (let i = 0; i < cost; i++) { peer.spent.push(this.now); if (background) peer.spentBackground.push(this.now); }
    return true;
  }
  private opened(g: string, me: string, other: string, kind: Edge["kind"], expect: boolean): Edge {
    return { g, me, peer: other, kind, announced: false, openedAt: this.now, fastUntil: expect ? this.now + (this.network?.expectMs ?? 0) : 0, lastPoll: -Infinity, polls: 0 };
  }

  /**
   * `extra`: more of the host, for what a test runs on top of the groups (payments). `app`: an app that stays online
   * (a hub of large private groups), or one from before hubs.
   */
  add(name: string, extra?: (peer: Peer) => Partial<GroupsHost>, app: { staysOnline?: boolean; legacy?: boolean; unmetered?: boolean; peerBudget?: number; heldElsewhere?: number } = {}): Peer {
    const links = new Map<string, Edge>();
    const messages: StoredMessage[] = [];
    const peer: Peer = { name, groups: null as unknown as Groups, store: memoryStore(messages), messages, links, online: true, nick: name, sent: { frames: 0, bytes: 0 }, spent: [], spentBackground: [], refused: 0, host: null as unknown as GroupsHost, ...app };
    const host: GroupsHost = {
      sendOnLink: (linkId, frame) => {
        const edge = links.get(linkId), there = edge && this.counterpart(edge);
        if (!edge || !there || !this.up(peer, edge, there.peer)) throw new Error("link down");
        const data = JSON.stringify(frame);
        peer.sent.frames++; peer.sent.bytes += data.length;
        const copy = JSON.parse(data) as Record<string, unknown>;
        // An app from before hubs drops the frames it does not know (its session has no case for them).
        if (there.peer.legacy && (copy.t === "group-bye" || copy.t === "group-reach" || copy.t === "group-reacted")) return;
        if (this.drop?.(peer, there.peer, copy)) return;
        this.pending.push(edge.kind === "edge" ? there.peer.groups.handleEdgeFrame(edge.g, edge.me, copy) : there.peer.groups.handleContactFrame(there.linkId, copy));
      },
      // Version 4 (hubs) only between two apps that announce it.
      linkReady: (linkId, version = 1) => { const edge = links.get(linkId), there = edge && this.counterpart(edge); return !!there && this.up(peer, edge, there.peer) && (version < 4 || (!peer.legacy && !there.peer.legacy)); },
      linkSeen: linkId => { const edge = links.get(linkId); return !!edge && !!this.counterpart(edge) && (!this.network || edge.polls > 0); },
      // Its other end's app runs again (a restart): its link published, whether or not it is up yet.
      linkBack: linkId => { const edge = links.get(linkId), there = edge && this.counterpart(edge); return !!there && there.peer.online; },
      contactName: () => undefined,
      edges: g => new Map([...links].filter(([, e]) => e.g === g && e.kind === "edge").map(([id, e]) => [e.peer, id])),
      entries: g => new Map([...links].filter(([, e]) => e.g === g && e.kind !== "edge").map(([id, e]) => [e.peer, id])),
      openEdge: async (state, other, expect) => {
        const me = identityFromSeedB64(state.seedB64).pubKeyZ32, id = `edge:${name}:${state.id}:${other}`;
        if (!links.has(id)) links.set(id, { ...this.opened(state.id, me, other, "edge", !!expect), expected: !!expect });
        return id;
      },
      closeEdge: async linkId => { links.delete(linkId); },
      // As the engine does: an entry session whose admission is done closes when the joiner's side goes (its data
      // link drops), not on the engine's 20 s timer, which runs on the wall clock and never fires in simulated time.
      entryDone: linkId => { const edge = links.get(linkId); if (edge) edge.done = true; },
      expectPeer: linkId => { const edge = links.get(linkId); if (edge) edge.fastUntil = Math.max(edge.fastUntil, this.now + (this.network?.expectMs ?? 0)); },
      edgeNick: () => undefined,
      openEntry: async (link, role, seedB64, other) => {
        // As in the engine, one link per pair and role: opening it again returns the same one.
        const me = identityFromSeedB64(seedB64).pubKeyZ32, id = `entry:${name}:${link.g}:${other}:${role}`;
        // The other side is due any moment: an entry session looks fast (`openEntry` calls `expectPeer`).
        if (!links.has(id)) links.set(id, this.opened(link.g, me, other, role, true));
        return id;
      },
      publish: async (identity, records, background) => {
        this.pkarrOps++;
        this.onPkarr?.(peer, "publish", identity.pubKeyZ32, !!background);
        if (!this.spend(peer, 2, background, true, `publish${background ? " bg" : ""}`)) throw new Error("Discovery request budget reached; retry shortly");
        if (peer.online) this.pkarr.set(identity.pubKeyZ32, structuredClone(records));
      },
      resolve: async (key, background) => {
        this.pkarrOps++;
        this.onPkarr?.(peer, "resolve", key, !!background);
        if (this.failRead?.(peer, key)) throw new Error("No Pkarr relay reachable");
        if (!this.spend(peer, 1, background, false, `resolve${background ? " bg" : ""}`)) throw new Error("No Pkarr relay reachable");
        return peer.online ? structuredClone(this.pkarr.get(key) ?? null) : null;
      },
      storeMessage: async message => { if (messages.some(m => m.id === message.id)) return false; messages.push(message); return true; },
      emit: () => {},
      myNick: () => peer.nick,
      staysOnline: () => !!peer.staysOnline,
      meshHubs: () => !peer.legacy,
      // As the engine counts: the links of every other group, and what groups outside this world hold.
      peerRoom: g => peer.peerBudget === undefined ? undefined : peer.peerBudget - (peer.heldElsewhere ?? 0) - [...links.values()].filter(e => e.g !== g).length,
      ...extra?.(peer),
    };
    peer.host = host;
    peer.groups = new Groups(host, peer.store, undefined, this.timings, this.random);
    // On the world's clock from the start: what it does before its first tick (a knock) is timed like the rest.
    void peer.groups.tick(this.now);
    this.peers.set(name, peer);
    return peer;
  }

  /**
   * The other end of a link: same group, keys swapped, and the matching kind. Two peers running the
   * same end (two hubs answering one joiner with the link's entry key) collide on the same rendezvous
   * identity, as they would on Pkarr: then nobody gets through.
   */
  private counterpart(edge: Edge): { peer: Peer; linkId: string } | undefined {
    const want = edge.kind === "edge" ? "edge" : edge.kind === "host" ? "guest" : "host";
    const found: { peer: Peer; linkId: string }[] = [];
    for (const peer of this.peers.values()) for (const [linkId, e] of peer.links) {
      if (e.kind === want && e.g === edge.g && e.me === edge.peer && e.peer === edge.me) found.push({ peer, linkId });
    }
    const same = [...this.peers.values()].flatMap(peer => [...peer.links.values()].filter(e => e.kind === edge.kind && e.g === edge.g && e.me === edge.me && e.peer === edge.peer));
    return found.length === 1 && same.length === 1 ? found[0] : undefined;
  }

  /** Both ends online and reachable, and (with a `NetworkModel`) signaling done on both sides. */
  private up(peer: Peer, edge: Edge, there: Peer): boolean {
    if (!peer.online || !there.online || !this.sameSide(peer, there)) return false;
    if (!this.network) return true;
    if (edge.upAt !== undefined) return true;
    const other = this.counterpart(edge);
    if (!other) return false;
    const theirs = there.links.get(other.linkId)!;
    if (edge.polls < this.network.signalPolls || theirs.polls < this.network.signalPolls) return false;
    edge.upAt = theirs.upAt = this.now;
    edge.wasUp = theirs.wasUp = true;
    // Connected: each side clears its signal from its packet (a publish, best effort).
    this.spend(peer, 2); this.spend(there, 2);
    return true;
  }

  /**
   * Each side of a link that is not up polls the other's record at the pace a `LinkSession` would:
   * polls that find the other side count toward signaling; finding a fresh one (opened in the last
   * `expectMs`) makes it look fast, as `GhostLink` does on a fresh packet. Links that are up poll
   * rarely, and every poll spends the app's budget.
   */
  private signal(): void {
    const net = this.network;
    if (!net) return;
    for (const peer of this.peers.values()) {
      if (!peer.online) continue;
      for (const edge of peer.links.values()) {
        // Its presence first (a publish, retried until the budget lets it through), then polls, found or not.
        if (!edge.published) edge.published = this.spend(peer, 2, false, true, `${edge.kind} presence`);
        // Its offer or answer, once it saw the other side: retried on its own until the budget lets it through, as
        // a `LinkSession` retries a publish, while the polls go on.
        if (edge.sawPeer && !edge.signaled) edge.signaled = this.spend(peer, 2, false, true, `${edge.kind} signal`);
        const there = this.counterpart(edge);
        // The other side closed, or its app did (its data link dropped): signaling starts over.
        if (edge.upAt !== undefined && (!there || !there.peer.online || !this.sameSide(peer, there.peer))) { edge.upAt = undefined; edge.polls = 0; edge.sawPeer = edge.signaled = false; }
        // A private group's edges look more slowly as it grows (`meshEdgeIntervals`).
        const mesh = edge.kind === "edge" && !peer.groups.isCommunityGroup(edge.g), size = mesh ? peer.groups.meshSize(edge.g) : 0;
        const every = edge.upAt !== undefined ? net.connectedPollMs * (mesh ? meshEdgeScale(size) : 1)
          : this.now < edge.fastUntil ? net.fastPollMs : net.backgroundPollMs * (mesh ? meshEdgeScale(size, false) : 1);
        if (this.now - edge.lastPoll < every) continue;
        edge.lastPoll = this.now;
        if (!this.spend(peer, 1, false, false, `${edge.kind} poll${edge.upAt !== undefined ? " up" : this.now < edge.fastUntil ? " fast" : ""}`) || edge.upAt !== undefined) continue;
        const theirs = there && there.peer.online && this.sameSide(peer, there.peer) ? there.peer.links.get(there.linkId)! : undefined;
        if (!theirs?.published) { edge.polls = 0; edge.sawPeer = edge.signaled = false; continue; }
        if (edge.polls === 0 && this.now - theirs.openedAt < net.expectMs) edge.fastUntil = Math.max(edge.fastUntil, this.now + net.expectMs);
        // Seeing the other side is what dialing or answering it needs: a publish of the offer or answer.
        if (!edge.sawPeer) { edge.sawPeer = true; edge.signaled = this.spend(peer, 2, false, true, `${edge.kind} signal`); }
        if (!edge.signaled) continue;
        edge.polls++;
      }
    }
  }

  /** Links whose both ends exist come up: each side hears it, as a paired session announcing groups would. */
  private announce(): void {
    for (const peer of this.peers.values()) {
      if (!peer.online) { for (const edge of peer.links.values()) edge.announced = false; continue; }
      for (const [linkId, edge] of peer.links) {
        const there = this.counterpart(edge);
        if (edge.done && !there) { peer.links.delete(linkId); continue; }
        const up = !!there && this.up(peer, edge, there.peer);
        if (up && !edge.announced) {
          edge.announced = true;
          if (edge.kind === "edge") peer.groups.edgeReady(edge.g, edge.peer, linkId);
          else if (edge.kind === "host") peer.groups.entryReady(edge.g, linkId, edge.peer);
        } else if (!up) edge.announced = false;
      }
    }
  }

  async settle(): Promise<void> {
    for (let i = 0; i < 500; i++) {
      this.announce();
      const batch = this.pending.splice(0);
      if (!batch.length) {
        // What the engines handed on (payments) may send more.
        await Promise.all([...this.peers.values()].map(p => p.groups.communityIdle()));
        if (!this.pending.length) break;
        continue;
      }
      await Promise.allSettled(batch);
    }
  }

  /** A peer's app opens again after it was closed: its links start over (fresh presence), as an app's do on start. */
  reopen(peer: Peer): void {
    peer.online = true;
    for (const edge of peer.links.values()) Object.assign(edge, { openedAt: this.now, fastUntil: 0, lastPoll: -Infinity, polls: 0, published: false, sawPeer: false, signaled: false, upAt: undefined });
  }

  /**
   * A peer's app starts again: a new engine on what it stored (its groups, messages and links), as an app's after a
   * quit, with nothing of the last run's memory; its links start over as `reopen` says.
   */
  async restart(peer: Peer): Promise<void> {
    peer.groups = new Groups(peer.host, peer.store, undefined, this.timings, this.random);
    await peer.groups.load();
    this.reopen(peer);
  }

  /** Time passes: every online peer runs its timers once per `stepMs`. */
  async run(ms: number, stepMs = 1000): Promise<void> {
    for (let t = 0; t < ms; t += stepMs) {
      this.now += stepMs;
      for (const peer of this.peers.values()) if (peer.online) await peer.groups.tick(this.now);
      this.signal();
      await this.settle();
    }
  }

  /** Runs until `done()` or `limitMs` of simulated time; returns the simulated time it took. */
  async until(done: () => boolean, limitMs: number, stepMs = 1000, what?: () => string): Promise<number> {
    const start = this.now;
    while (!done()) {
      if (this.now - start > limitMs) throw new Error(`Not done after ${limitMs / 1000}s of simulated time${what ? `: ${what()}` : ""}`);
      await this.run(stepMs, stepMs);
    }
    return this.now - start;
  }

  texts(peer: Peer, groupId: string): string[] { return peer.messages.filter(m => m.linkId === `group:${groupId}` && !m.event).map(m => m.text); }
  view(peer: Peer, groupId: string) { return peer.groups.views().find(v => v.id === groupId); }
  member(peer: Peer, groupId: string): boolean { return this.view(peer, groupId)?.status === "active"; }
}
