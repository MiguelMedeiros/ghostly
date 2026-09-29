import { boundedIdentityFetch } from "../proofs/verify";
import type { IdentityFetch } from "../proofs/contract";
import { ACTIVITY_READERS, readPostImage, type ActivityReader, type PublicGraph, type PublicPost } from "../profiles/activity";
import type { PublicGraphView, PublicPostImageView, PublicPostsView } from "../shared/types";
import type { ProfileSubject } from "./publicProfiles";

/** What the engine gives the posts-and-follows cache. */
export interface PublicActivityHost {
  /** Settings → Load public profiles (absent means on): it gates posts and follows too. */
  enabled(): boolean;
  online(): boolean;
  /** Every identity whose public data may be shown now (a current, verified proof). */
  eligible(): ProfileSubject[];
  nostrRelays(): readonly string[];
  /** The reader's own identities with a current proof. */
  own(): ProfileSubject[];
  /** What contacts shared that verifies now, with the chat it came in. */
  contacts(): (ProfileSubject & { linkId: string })[];
  /** The reader's own Nostr follow lists, when the Nostr social layer already read them. */
  ownNostrFollows?(): string[];
  /** The reader's own Nostr mute list says to hide this note. */
  nostrMuted?(note: { id: string; text: string; mentions: string[] }, author: string): boolean;
  /** Tests: the network and the clock. */
  fetch?: IdentityFetch;
  makeSocket?: (url: string) => WebSocket;
  avatarFetch?: typeof fetch;
  now?: () => number;
  readers?: Readonly<Record<string, ActivityReader>>;
}

/** Posts are asked again after ten minutes, follow lists after an hour; a failure no sooner than a minute later. */
export const POSTS_TTL_SECONDS = 10 * 60;
export const GRAPH_TTL_SECONDS = 60 * 60;
export const ACTIVITY_RETRY_SECONDS = 60;
/** At most this many identities' posts, follow lists and pictures are kept (the least recently used go first). */
export const MAX_ACTIVITY_ENTRIES = 24;
export const MAX_POSTS_KEPT = 50;
const MAX_IMAGES_KEPT = 16;
/** One ask, all its pages and hosts included. */
const ASK_TIMEOUT_MS = 20_000;

interface PostsEntry { posts: PublicPost[]; cursor?: string; hosts: string[]; fetchedAt: number; used: number }
interface GraphEntry extends PublicGraph { fetchedAt: number; used: number }
interface Failure { at: number; message: string }

const keyOf = (s: ProfileSubject) => `${s.provider}\n${s.subject}`;

/**
 * A contact's verified identity's recent posts and follows, engine side (PUBLIC-PROFILES.md, "Posts and follows"):
 * asked one identity at a time when the reader chooses its card, only for a current, verified proof, only with Load
 * public profiles on and the network on. Kept in memory only, for minutes, bounded; nothing is written to disk and
 * nothing about the reader is sent. Follow lists are read only when there is someone to compare them with, and only
 * the comparison leaves the engine.
 */
export class PublicActivity {
  private posts = new Map<string, PostsEntry>();
  private graphs = new Map<string, GraphEntry>();
  private images = new Map<string, { view: PublicPostImageView; used: number }>();
  private failures = new Map<string, Failure>();
  private inflight = new Map<string, Promise<unknown>>();
  private readonly fetch: IdentityFetch;

  constructor(private host: PublicActivityHost) {
    this.fetch = host.fetch ?? boundedIdentityFetch({ online: host.online });
  }

  private get now() { return Math.floor((this.host.now?.() ?? Date.now()) / 1000); }
  private get readers() { return this.host.readers ?? ACTIVITY_READERS; }
  private reader(s: ProfileSubject): ActivityReader | undefined {
    return Object.prototype.hasOwnProperty.call(this.readers, s.provider) ? this.readers[s.provider] : undefined;
  }
  private allowed(s: ProfileSubject): boolean {
    return this.host.enabled() && !!this.reader(s) && this.host.eligible().some(e => e.provider === s.provider && e.subject === s.subject);
  }
  private ctx(signal = AbortSignal.timeout(ASK_TIMEOUT_MS)) {
    return { fetch: this.fetch, signal, relays: this.host.nostrRelays(), makeSocket: this.host.makeSocket, avatarFetch: this.host.avatarFetch };
  }
  /** Shares one ask per key; a failure is kept to space out the next one. */
  private once<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const task = work().then(v => { this.failures.delete(key); return v; }, (e: unknown) => {
      this.failures.set(key, { at: this.now, message: e instanceof Error ? e.message : String(e) });
      throw e;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }
  private recentFailure(key: string): Failure | undefined {
    const f = this.failures.get(key);
    return f && this.now - f.at < ACTIVITY_RETRY_SECONDS ? f : undefined;
  }
  private trim<V extends { used: number }>(map: Map<string, V>, max: number): void {
    if (map.size <= max) return;
    const oldest = [...map.entries()].sort(([, a], [, b]) => a.used - b.used).slice(0, map.size - max);
    for (const [k] of oldest) map.delete(k);
  }

  // -- posts ----------------------------------------------------------------------------------------

  private postsView(s: ProfileSubject, e: PostsEntry): PublicPostsView {
    const muted = s.provider === "nostr" && this.host.nostrMuted
      ? (p: PublicPost) => this.host.nostrMuted!({ id: p.id, text: p.text, mentions: p.mentions ?? [] }, s.subject)
      : () => false;
    const shown = e.posts.filter(p => !muted(p));
    const view: PublicPostsView = {
      posts: shown.map(p => ({
        id: p.id, createdAt: p.createdAt, text: p.text,
        ...(p.url ? { url: p.url } : {}), ...(p.reply ? { reply: true } : {}),
        images: p.images.map(i => ({ ...(i.host ? { host: i.host } : {}), ...(i.alt ? { alt: i.alt } : {}) })),
      })),
      more: !!e.cursor && e.posts.length < MAX_POSTS_KEPT,
      hosts: e.hosts,
      fetchedAt: e.fetchedAt,
    };
    if (shown.length < e.posts.length) view.hidden = e.posts.length - shown.length;
    const profileUrl = this.reader(s)?.profileUrl(s.subject);
    if (profileUrl) view.profileUrl = profileUrl;
    return view;
  }

  /** The identity's recent posts: the kept page when fresh, else asked; `more` adds the next page. */
  async loadPosts(s: ProfileSubject & { more?: boolean; force?: boolean }): Promise<PublicPostsView | null> {
    if (!this.allowed(s)) return null;
    const key = keyOf(s);
    const kept = this.posts.get(key);
    if (kept) kept.used = Date.now();
    const fresh = kept && this.now - kept.fetchedAt < POSTS_TTL_SECONDS;
    if (!s.more && kept && (fresh && !s.force)) return this.postsView(s, kept);
    if (!this.host.online()) {
      if (kept) return this.postsView(s, kept);
      throw new Error("Offline: turn the network on first");
    }
    if (s.more && !kept?.cursor) return kept ? this.postsView(s, kept) : null;
    const failed = this.recentFailure(`posts\n${key}`);
    if (failed && !s.more) { if (kept) return this.postsView(s, kept); throw new Error(failed.message); }
    const reader = this.reader(s)!;
    await this.once(`posts\n${key}${s.more ? "\nmore" : ""}`, async () => {
      const page = await reader.posts(s.subject, this.ctx(), s.more ? kept?.cursor : undefined);
      // The proof may have gone, or the setting been turned off, while the host answered.
      if (!this.allowed(s)) return;
      const before = s.more ? this.posts.get(key)?.posts ?? [] : [];
      const seen = new Set(before.map(p => p.id));
      const posts = [...before, ...page.posts.filter(p => !seen.has(p.id) && seen.add(p.id))].slice(0, MAX_POSTS_KEPT);
      const hosts = [...new Set([...(s.more ? this.posts.get(key)?.hosts ?? [] : []), ...page.hosts])];
      this.posts.set(key, { posts, ...(page.cursor ? { cursor: page.cursor } : {}), hosts, fetchedAt: s.more && kept ? kept.fetchedAt : this.now, used: Date.now() });
      this.trim(this.posts, MAX_ACTIVITY_ENTRIES);
    });
    const e = this.posts.get(key);
    return e && this.allowed(s) ? this.postsView(s, e) : null;
  }

  // -- follows --------------------------------------------------------------------------------------

  /** The identities the reader knows on this network, apart from the one looked at. */
  private known(s: ProfileSubject) {
    const own = [...new Set(this.host.own().filter(o => o.provider === s.provider && o.subject !== s.subject).map(o => o.subject))];
    const sameLinks = new Set(this.host.contacts().filter(c => c.provider === s.provider && c.subject === s.subject).map(c => c.linkId));
    const contacts = this.host.contacts().filter(c => c.provider === s.provider && c.subject !== s.subject && !sameLinks.has(c.linkId) && !own.includes(c.subject));
    return { own, contacts };
  }

  private graphView(s: ProfileSubject, g: GraphEntry | undefined): PublicGraphView {
    const { own, contacts } = this.known(s);
    if (!g) return { compared: false, followsYou: false, youFollow: false, contacts: [], hosts: [], fetchedAt: 0 };
    const following = new Set(g.following), followers = new Set(g.followers ?? []);
    // Someone follows it when its followers list says so, or when their own list (read earlier, still kept) names it.
    const theirList = (subject: string) => this.graphs.get(keyOf({ provider: s.provider, subject }));
    const follows = (subject: string) => followers.has(subject) || !!theirList(subject)?.following.includes(s.subject);
    const ownNostr = s.provider === "nostr" ? this.host.ownNostrFollows?.() ?? [] : [];
    const byLink = new Map<string, { linkId: string; follows: boolean; followedBy: boolean }>();
    for (const c of contacts) {
      const f = following.has(c.subject), by = follows(c.subject);
      if (!f && !by) continue;
      const row = byLink.get(c.linkId) ?? { linkId: c.linkId, follows: false, followedBy: false };
      byLink.set(c.linkId, { linkId: c.linkId, follows: row.follows || f, followedBy: row.followedBy || by });
    }
    const view: PublicGraphView = {
      compared: true,
      followsYou: own.some(o => following.has(o)),
      youFollow: own.some(follows) || ownNostr.includes(s.subject),
      contacts: [...byLink.values()],
      hosts: g.hosts,
      fetchedAt: g.fetchedAt,
    };
    if (!g.followingComplete || g.followersComplete === false) view.partial = true;
    return view;
  }

  /**
   * Who the identity follows and who follows it, as far as it touches the reader's identities and contacts. Nothing
   * is asked when there is nobody to compare with.
   */
  async loadGraph(s: ProfileSubject & { force?: boolean }): Promise<PublicGraphView | null> {
    if (!this.allowed(s)) return null;
    const key = keyOf(s);
    const { own, contacts } = this.known(s);
    const kept = this.graphs.get(key);
    if (kept) kept.used = Date.now();
    if (own.length === 0 && contacts.length === 0 && !(s.provider === "nostr" && this.host.ownNostrFollows?.().length)) return this.graphView(s, undefined);
    if (kept && this.now - kept.fetchedAt < GRAPH_TTL_SECONDS && !s.force) return this.graphView(s, kept);
    if (!this.host.online()) {
      if (kept) return this.graphView(s, kept);
      throw new Error("Offline: turn the network on first");
    }
    const failed = this.recentFailure(`graph\n${key}`);
    if (failed) { if (kept) return this.graphView(s, kept); throw new Error(failed.message); }
    const reader = this.reader(s)!;
    await this.once(`graph\n${key}`, async () => {
      const g = await reader.graph(s.subject, this.ctx());
      if (!this.allowed(s)) return;
      this.graphs.set(key, { ...g, fetchedAt: this.now, used: Date.now() });
      this.trim(this.graphs, MAX_ACTIVITY_ENTRIES);
    });
    return this.allowed(s) ? this.graphView(s, this.graphs.get(key)) : null;
  }

  // -- pictures -------------------------------------------------------------------------------------

  /** One picture of a post already loaded, on the reader's tap; the source comes from the kept post, never the page. */
  async loadImage(s: ProfileSubject & { postId: string; index: number }): Promise<PublicPostImageView> {
    if (!this.allowed(s)) throw new Error("Public profiles are off, or this identity is no longer verified");
    const post = this.posts.get(keyOf(s))?.posts.find(p => p.id === s.postId);
    const image = Number.isSafeInteger(s.index) ? post?.images[s.index] : undefined;
    if (!image) throw new Error("That picture is no longer here: load the posts again");
    const key = `${keyOf(s)}\n${s.postId}\n${s.index}`;
    const kept = this.images.get(key);
    if (kept) { kept.used = Date.now(); return kept.view; }
    if (!this.host.online()) throw new Error("Offline: turn the network on first");
    return this.once(`image\n${key}`, async () => {
      const r = await readPostImage(image.source, this.ctx());
      const view: PublicPostImageView = { hosts: r.hosts, ...(r.avatar ? { src: r.avatar } : {}), ...(r.miss ? { miss: r.miss } : {}) };
      const size = r as { width?: number; height?: number };
      if (size.width && size.height) { view.width = size.width; view.height = size.height; }
      if (view.src && this.allowed(s)) { this.images.set(key, { view, used: Date.now() }); this.trim(this.images, MAX_IMAGES_KEPT); }
      return view;
    });
  }

  // -- housekeeping ---------------------------------------------------------------------------------

  /** Drops what belongs to identities that are no longer eligible (expired, removed, withdrawn, revoked). */
  prune(): void {
    const keep = new Set(this.host.eligible().map(keyOf));
    const owner = (k: string) => k.split("\n").slice(0, 2).join("\n");
    for (const map of [this.posts, this.graphs, this.images] as Map<string, unknown>[]) for (const k of [...map.keys()]) if (!keep.has(owner(k))) map.delete(k);
  }

  /** The setting was turned off, or the engine stops: nothing is kept. */
  clear(): void {
    this.posts.clear();
    this.graphs.clear();
    this.images.clear();
    this.failures.clear();
  }
}
