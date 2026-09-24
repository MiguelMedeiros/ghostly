import { identityFromSeedB64, type GhostRecord } from "@ghostly/core";
import { Groups, type GroupStore, type GroupsHost } from "../src/engine/groups";
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
  /** An edge opened expecting the other side at once. */
  expected?: boolean;
}

/**
 * What the in-memory network costs, when a test wants it to (the load and unit tests keep it free):
 * each app's Pkarr budget, and a link that comes up only after both sides polled each other's
 * record a few times (offer, answer), at the pace a `LinkSession` polls on relays: fast while it
 * expects the peer (after opening an entry session or an expected edge, or on finding a fresh
 * packet of the other side), at the background pace otherwise, rarely once up. A poll the budget
 * refuses does not happen.
 */
export interface NetworkModel {
  /** Pkarr requests per app and minute: a resolve costs 1, a publish 2 (it goes to both relays); background ones only up to `backgroundPerMinute`. */
  budgetPerMinute: number;
  backgroundPerMinute: number;
  /** Polls each side needs, once both sides exist, before the link is up. */
  signalPolls: number;
  fastPollMs: number;
  backgroundPollMs: number;
  connectedPollMs: number;
  /** How long a side polls fast after `expectPeer`. */
  expectMs: number;
}
/** The web app on public relays: 30 requests a minute to each of two (20 for background ones), `RELAY_POLL_INTERVALS`, `EXPECT_PEER_MS`. */
export const RELAY_NETWORK: NetworkModel = { budgetPerMinute: 60, backgroundPerMinute: 40, signalPolls: 2, fastPollMs: 2_000, backgroundPollMs: 30_000, connectedPollMs: 60_000, expectMs: 30_000 };
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
  private sameSide(a: Peer, b: Peer): boolean { return !this.part || this.part(a) === this.part(b); }
  /** Loses frames on the way (a test says which): the network is not perfect. */
  drop: ((from: Peer, to: Peer, frame: Record<string, unknown>) => boolean) | null = null;
  private pending: Promise<unknown>[] = [];

  constructor(private readonly timings: CommunityTimings = { ...COMMUNITY_TIMINGS, hubJitterMs: 0 }, readonly network: NetworkModel | null = null, private readonly random: () => number = Math.random) {}

  /** One Pkarr request of `cost`, if the app's budget allows it (always, without a `NetworkModel`). */
  private spend(peer: Peer, cost: number, background = false): boolean {
    if (!this.network) return true;
    peer.spent = peer.spent.filter(at => this.now - at < 60_000);
    peer.spentBackground = peer.spentBackground.filter(at => this.now - at < 60_000);
    if (peer.spent.length + cost > this.network.budgetPerMinute || (background && peer.spentBackground.length + cost > this.network.backgroundPerMinute)) { peer.refused++; return false; }
    for (let i = 0; i < cost; i++) { peer.spent.push(this.now); if (background) peer.spentBackground.push(this.now); }
    return true;
  }
  private opened(g: string, me: string, other: string, kind: Edge["kind"], expect: boolean): Edge {
    return { g, me, peer: other, kind, announced: false, openedAt: this.now, fastUntil: expect ? this.now + (this.network?.expectMs ?? 0) : 0, lastPoll: -Infinity, polls: 0 };
  }

  /** `extra`: more of the host, for what a test runs on top of the groups (payments). */
  add(name: string, extra?: (peer: Peer) => Partial<GroupsHost>): Peer {
    const links = new Map<string, Edge>();
    const messages: StoredMessage[] = [];
    const peer: Peer = { name, groups: null as unknown as Groups, store: memoryStore(messages), messages, links, online: true, nick: name, sent: { frames: 0, bytes: 0 }, spent: [], spentBackground: [], refused: 0 };
    const host: GroupsHost = {
      sendOnLink: (linkId, frame) => {
        const edge = links.get(linkId), there = edge && this.counterpart(edge);
        if (!edge || !there || !this.up(peer, edge, there.peer)) throw new Error("link down");
        const data = JSON.stringify(frame);
        peer.sent.frames++; peer.sent.bytes += data.length;
        const copy = JSON.parse(data) as Record<string, unknown>;
        if (this.drop?.(peer, there.peer, copy)) return;
        this.pending.push(edge.kind === "edge" ? there.peer.groups.handleEdgeFrame(edge.g, edge.me, copy) : there.peer.groups.handleContactFrame(there.linkId, copy));
      },
      linkReady: linkId => { const edge = links.get(linkId), there = edge && this.counterpart(edge); return !!there && this.up(peer, edge, there.peer); },
      linkSeen: linkId => { const edge = links.get(linkId); return !!edge && !!this.counterpart(edge) && (!this.network || edge.polls > 0); },
      contactName: () => undefined,
      edges: g => new Map([...links].filter(([, e]) => e.g === g && e.kind === "edge").map(([id, e]) => [e.peer, id])),
      entries: g => new Map([...links].filter(([, e]) => e.g === g && e.kind !== "edge").map(([id, e]) => [e.peer, id])),
      openEdge: async (state, other, expect) => {
        const me = identityFromSeedB64(state.seedB64).pubKeyZ32, id = `edge:${name}:${state.id}:${other}`;
        if (!links.has(id)) links.set(id, { ...this.opened(state.id, me, other, "edge", !!expect), expected: !!expect });
        return id;
      },
      closeEdge: async linkId => { links.delete(linkId); },
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
        if (!this.spend(peer, 2, background)) throw new Error("Discovery request budget reached; retry shortly");
        if (peer.online) this.pkarr.set(identity.pubKeyZ32, structuredClone(records));
      },
      resolve: async (key, background) => {
        this.pkarrOps++;
        this.onPkarr?.(peer, "resolve", key, !!background);
        if (!this.spend(peer, 1, background)) throw new Error("No Pkarr relay reachable");
        return peer.online ? structuredClone(this.pkarr.get(key) ?? null) : null;
      },
      storeMessage: async message => { if (!messages.some(m => m.id === message.id)) messages.push(message); },
      emit: () => {},
      myNick: () => peer.nick,
      ...extra?.(peer),
    };
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
        const there = this.counterpart(edge);
        if (!there || !there.peer.online || !this.sameSide(peer, there.peer)) { if (edge.upAt === undefined) edge.polls = 0; else if (!there) { edge.upAt = undefined; edge.polls = 0; } continue; }
        const every = edge.upAt !== undefined ? net.connectedPollMs : this.now < edge.fastUntil ? net.fastPollMs : net.backgroundPollMs;
        if (this.now - edge.lastPoll < every) continue;
        edge.lastPoll = this.now;
        if (!this.spend(peer, 1) || edge.upAt !== undefined) continue;
        const theirs = there.peer.links.get(there.linkId)!;
        if (edge.polls === 0 && this.now - theirs.openedAt < net.expectMs) edge.fastUntil = Math.max(edge.fastUntil, this.now + net.expectMs);
        // Seeing the other side's offer is also what answering it needs: a publish.
        if (edge.polls === 0 && !this.spend(peer, 2)) continue;
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
