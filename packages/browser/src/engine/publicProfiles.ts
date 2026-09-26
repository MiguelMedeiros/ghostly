import { STORES, store, transact, wrap } from "../shared/idb";
import { boundedIdentityFetch } from "../proofs/verify";
import type { IdentityFetch } from "../proofs/contract";
import { PUBLIC_PROFILE_READERS, type PublicProfileData, type PublicProfileReader } from "../profiles/readers";
import type { PublicProfileView } from "../shared/types";

/** An identity with a current, verified proof: the person's own, or one a contact shared and this app verified. */
export interface ProfileSubject { provider: string; subject: string }

/** What the engine gives the public-profile cache. */
export interface PublicProfileHost {
  /** Settings → Load public profiles (absent means on). */
  enabled(): boolean;
  online(): boolean;
  emit(): void;
  /** Every identity whose profile may be shown now; anything else is never asked for, and dropped from the cache. */
  eligible(): ProfileSubject[];
  /** The Nostr relays in the person's settings. */
  nostrRelays(): readonly string[];
  /** Tests: the network and the clock. */
  fetch?: IdentityFetch;
  makeSocket?: (url: string) => WebSocket;
  avatarFetch?: typeof fetch;
  now?: () => number;
  readers?: Readonly<Record<string, PublicProfileReader>>;
}

/** As stored: the last good answer (or that there was none) and when the host was last asked. */
interface StoredProfile extends PublicProfileData {
  provider: string;
  subject: string;
  /** Seconds: when this answer came. */
  fetchedAt: number;
  /** Seconds: when the host was last asked, successfully or not. */
  checkedAt: number;
}

const KEY = "publicProfiles";
/** A profile found is asked again after a day; a miss or a failure no sooner than five minutes later. */
export const PROFILE_REFRESH_SECONDS = 24 * 60 * 60;
export const PROFILE_RETRY_SECONDS = 5 * 60;
/** At most this many profiles are kept (the least recently checked go first). */
export const MAX_CACHED_PROFILES = 64;
/** Unused entries are dropped this often, so an expired proof's profile does not wait for the next change. */
const PRUNE_MS = 10 * 60_000;

const keyOf = (s: ProfileSubject) => `${s.provider}\n${s.subject}`;

/**
 * The public profiles of verified identities, engine side: asked for one identity at a time, when its card is on
 * screen (the UI's `loadPublicProfile`), only for an identity with a current verified proof and only with the
 * setting on and the network on. Kept in IndexedDB for offline use, asked again after a day (misses after five
 * minutes), and dropped once the proof expires, is removed, withdrawn or revoked, or the setting is turned off.
 */
export class PublicProfiles {
  private cache: Record<string, StoredProfile> = {};
  private inflight = new Map<string, Promise<void>>();
  private errors = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Before the chats are loaded every contact's identity would look ineligible: nothing is pruned until then. */
  private started = false;
  private readonly fetch: IdentityFetch;

  constructor(private host: PublicProfileHost) {
    this.fetch = host.fetch ?? boundedIdentityFetch({ online: host.online });
  }

  private get now() { return Math.floor((this.host.now?.() ?? Date.now()) / 1000); }
  private get readers() { return this.host.readers ?? PUBLIC_PROFILE_READERS; }

  async load(): Promise<void> {
    const settings = await store(STORES.settings, "readonly");
    const saved = await wrap<Record<string, StoredProfile> | undefined>(settings.get(KEY));
    this.cache = saved && typeof saved === "object" ? saved : {};
  }
  /** Starts the periodic clean-up; call once the chats are loaded, so `eligible` sees them. */
  start(): void {
    this.started = true;
    void this.prune().catch(() => {});
    this.timer ??= setInterval(() => { void this.prune().catch(() => {}); }, PRUNE_MS);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  private async save(): Promise<void> {
    await transact([STORES.settings], stores => { stores[STORES.settings].put(this.cache, KEY); });
  }

  private isEligible(s: ProfileSubject): boolean {
    return this.host.eligible().some(e => e.provider === s.provider && e.subject === s.subject);
  }

  /** What a card shows for this identity; undefined with the setting off, for a provider without profiles, or never asked. */
  view(s: ProfileSubject): PublicProfileView | undefined {
    if (!this.host.enabled() || !this.readers[s.provider]) return undefined;
    const key = keyOf(s);
    const c = this.cache[key];
    const loading = this.inflight.has(key);
    const error = this.errors.get(key);
    if (!c && !loading && !error) return undefined;
    const view: PublicProfileView = { found: c?.found ?? false, hosts: c?.hosts ?? [], fetchedAt: c?.fetchedAt ?? 0 };
    if (c) for (const k of ["name", "handle", "about", "avatar", "followers", "following"] as const) if (c[k] !== undefined) (view as unknown as Record<string, unknown>)[k] = c[k];
    if (loading) view.loading = true;
    if (error) view.error = error;
    return view;
  }

  /**
   * Asks the identity's network for its profile, unless the copy kept is recent enough (`force` still waits out the
   * five-minute minimum). Quietly does nothing for an identity that is not eligible, with the setting off or offline.
   */
  async request(s: ProfileSubject & { force?: boolean }): Promise<void> {
    const reader = this.readers[s.provider];
    if (!reader || !this.host.enabled() || !this.host.online() || !this.isEligible(s)) return;
    const key = keyOf(s);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const c = this.cache[key];
    const age = c ? this.now - c.checkedAt : Infinity;
    const fresh = c && this.now - c.fetchedAt < PROFILE_REFRESH_SECONDS && c.found && !this.errors.has(key);
    if (age < PROFILE_RETRY_SECONDS || (fresh && !s.force)) return;
    const task = this.ask(s, reader).finally(() => { this.inflight.delete(key); this.host.emit(); });
    this.inflight.set(key, task);
    this.host.emit();
    return task;
  }

  private async ask(s: ProfileSubject, reader: PublicProfileReader): Promise<void> {
    const key = keyOf(s);
    const checkedAt = this.now;
    try {
      const data = await reader.read(s.subject, {
        fetch: this.fetch, signal: AbortSignal.timeout(20_000), relays: this.host.nostrRelays(),
        makeSocket: this.host.makeSocket, avatarFetch: this.host.avatarFetch,
      });
      // The proof may have gone, or the setting been turned off, while the host answered.
      if (!this.host.enabled() || !this.isEligible(s)) return;
      this.errors.delete(key);
      this.cache[key] = { ...data, provider: s.provider, subject: s.subject, fetchedAt: checkedAt, checkedAt };
    } catch (e) {
      if (!this.host.enabled() || !this.isEligible(s)) return;
      this.errors.set(key, e instanceof Error ? e.message : String(e));
      // A good copy stays; the failed attempt only counts toward the retry wait.
      const old = this.cache[key];
      this.cache[key] = old ? { ...old, checkedAt } : { found: false, hosts: [], provider: s.provider, subject: s.subject, fetchedAt: 0, checkedAt };
    }
    this.trim();
    await this.save();
  }

  private trim(): void {
    const entries = Object.entries(this.cache);
    if (entries.length <= MAX_CACHED_PROFILES) return;
    entries.sort(([, a], [, b]) => b.checkedAt - a.checkedAt);
    this.cache = Object.fromEntries(entries.slice(0, MAX_CACHED_PROFILES));
  }

  /** Drops every profile whose identity is no longer eligible (expired, removed, withdrawn, revoked). */
  async prune(): Promise<void> {
    if (!this.started) return;
    const keep = new Set(this.host.eligible().map(keyOf));
    const drop = Object.keys(this.cache).filter(k => !keep.has(k));
    if (!drop.length) return;
    for (const k of drop) { delete this.cache[k]; this.errors.delete(k); }
    await this.save();
    this.host.emit();
  }

  /** The setting was turned off: nothing is kept. */
  async clear(): Promise<void> {
    this.cache = {};
    this.errors.clear();
    await this.save();
    this.host.emit();
  }
}
