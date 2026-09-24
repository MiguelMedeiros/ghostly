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
interface Edge { g: string; me: string; peer: string; kind: "edge" | "host" | "guest"; announced: boolean }
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
  /** Cuts the network in parts: links (and Pkarr reads) only work within one part. */
  part: ((peer: Peer) => number) | null = null;
  private sameSide(a: Peer, b: Peer): boolean { return !this.part || this.part(a) === this.part(b); }
  /** Loses frames on the way (a test says which): the network is not perfect. */
  drop: ((from: Peer, to: Peer, frame: Record<string, unknown>) => boolean) | null = null;
  private pending: Promise<unknown>[] = [];

  constructor(private readonly timings: CommunityTimings = { ...COMMUNITY_TIMINGS, hubJitterMs: 0 }) {}

  /** `extra`: more of the host, for what a test runs on top of the groups (payments). */
  add(name: string, extra?: (peer: Peer) => Partial<GroupsHost>): Peer {
    const links = new Map<string, Edge>();
    const messages: StoredMessage[] = [];
    const peer: Peer = { name, groups: null as unknown as Groups, store: memoryStore(messages), messages, links, online: true, nick: name, sent: { frames: 0, bytes: 0 } };
    const host: GroupsHost = {
      sendOnLink: (linkId, frame) => {
        const edge = links.get(linkId), there = edge && this.counterpart(edge);
        if (!edge || !there || !peer.online || !there.peer.online || !this.sameSide(peer, there.peer)) throw new Error("link down");
        const data = JSON.stringify(frame);
        peer.sent.frames++; peer.sent.bytes += data.length;
        const copy = JSON.parse(data) as Record<string, unknown>;
        if (this.drop?.(peer, there.peer, copy)) return;
        this.pending.push(edge.kind === "edge" ? there.peer.groups.handleEdgeFrame(edge.g, edge.me, copy) : there.peer.groups.handleContactFrame(there.linkId, copy));
      },
      linkReady: linkId => { const edge = links.get(linkId), there = edge && this.counterpart(edge); return !!there && peer.online && there.peer.online && this.sameSide(peer, there.peer); },
      contactName: () => undefined,
      edges: g => new Map([...links].filter(([, e]) => e.g === g && e.kind === "edge").map(([id, e]) => [e.peer, id])),
      entries: g => new Map([...links].filter(([, e]) => e.g === g && e.kind !== "edge").map(([id, e]) => [e.peer, id])),
      openEdge: async (state, other) => {
        const me = identityFromSeedB64(state.seedB64).pubKeyZ32, id = `edge:${name}:${state.id}:${other}`;
        if (!links.has(id)) links.set(id, { g: state.id, me, peer: other, kind: "edge", announced: false });
        return id;
      },
      closeEdge: async linkId => { links.delete(linkId); },
      edgeNick: () => undefined,
      openEntry: async (link, role, seedB64, other) => {
        // As in the engine, one link per pair and role: opening it again returns the same one.
        const me = identityFromSeedB64(seedB64).pubKeyZ32, id = `entry:${name}:${link.g}:${other}:${role}`;
        if (!links.has(id)) links.set(id, { g: link.g, me, peer: other, kind: role, announced: false });
        return id;
      },
      publish: async (identity, records) => { this.pkarrOps++; if (peer.online) this.pkarr.set(identity.pubKeyZ32, structuredClone(records)); },
      resolve: async key => { this.pkarrOps++; return peer.online ? structuredClone(this.pkarr.get(key) ?? null) : null; },
      storeMessage: async message => { if (!messages.some(m => m.id === message.id)) messages.push(message); },
      emit: () => {},
      myNick: () => peer.nick,
      ...extra?.(peer),
    };
    peer.groups = new Groups(host, peer.store, undefined, this.timings);
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

  /** Links whose both ends exist come up: each side hears it, as a paired session announcing groups would. */
  private announce(): void {
    for (const peer of this.peers.values()) {
      if (!peer.online) { for (const edge of peer.links.values()) edge.announced = false; continue; }
      for (const [linkId, edge] of peer.links) {
        const there = this.counterpart(edge);
        const up = !!there && there.peer.online && this.sameSide(peer, there.peer);
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
