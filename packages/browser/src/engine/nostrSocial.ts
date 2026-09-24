import { sanitizeAvatar, toBase64Url, type IdentityDisplay } from "@ghostly/core";
import { STORES, store, transact, wrap } from "../shared/idb";
import { cacheAvatar } from "../profiles/public";
import { checkedEvent, DEFAULT_NOSTR_RELAYS, normalizeNostrRelays, publishToRelays, readRelays, type NostrEvent, type RelayReadOptions } from "../nostr/relay";
import {
  followHints, followsTemplate, KIND_FOLLOWS, KIND_MUTE, KIND_NOTE, KIND_PROFILE, MAX_NOTES_KEPT, mutedBecause, newestOf, normalizePubkey, noteTemplate,
  NOTES_PAGE, npub, parseFollows, parseMuteList, parseNote, parseProfile, profileTemplate, shortNpub, STALE_AFTER_SECONDS, type EventTemplate, type NostrMuteList, type NostrNote, type NostrProfile,
} from "../nostr/social";
import type { NostrContactCache, NostrContactView, NostrDraft, NostrDraftRequest, NostrOwnCache, NostrOwnView, NostrProfileView, NostrPublishResult, NostrSocialSettings, NostrSocialState } from "../nostr/types";

/** What the engine gives the social layer. */
export interface NostrSocialHost {
  settings(): NostrSocialSettings | undefined;
  online(): boolean;
  emit(): void;
  /** The person's keys with a Nostr proof in this profile. */
  ownSubjects(): string[];
  /** A contact's keys with a currently verified Nostr proof in this chat. */
  contactSubjects(linkId: string): string[];
  linkIds(): string[];
  readContacts(linkId: string): Record<string, NostrContactCache> | undefined;
  writeContacts(linkId: string, cache: Record<string, NostrContactCache>): Promise<void>;
  /** Gives the contact's received proof its public name/picture, for badges and lists. */
  setDisplay(linkId: string, subject: string, display: IdentityDisplay): Promise<void>;
  /** Tests: a socket factory and a clock. */
  makeSocket?: (url: string) => WebSocket;
  now?: () => number;
}

const OWN_KEY = "nostrSocial";
const DRAFT_TTL_MS = 10 * 60_000;
const MAX_DRAFTS = 8;
const PROFILE_SOURCE = "Nostr profile (kind 0, signed by this key, self-described)";

export const DEFAULT_NOSTR_SETTINGS: NostrSocialSettings = { relays: [...DEFAULT_NOSTR_RELAYS], autoLoadProfiles: false, publish: false };

/** The settings with defaults filled in and the relay list validated; a broken stored list falls back to the defaults. */
export function effectiveNostrSettings(s: NostrSocialSettings | undefined): NostrSocialSettings {
  let relays: string[];
  try { relays = normalizeNostrRelays(s?.relays ?? DEFAULT_NOSTR_RELAYS); } catch { relays = [...DEFAULT_NOSTR_RELAYS]; }
  return { relays, autoLoadProfiles: s?.autoLoadProfiles === true, publish: s?.publish === true };
}

interface Draft { subject: string; template: EventTemplate; at: number; kind: "note" | "follow" | "unfollow" | "profile" }

/**
 * The Nostr social layer, engine side: what a contact's proven key lets the person *see* (profile, follows,
 * notes) and, with the publication capability on, *do* (post, follow, update their profile) through their
 * own signer. Nothing is fetched without the person's action or the explicit auto-load setting; nothing
 * is published without a draft this module built, confirmed and signed outside it.
 */
export class NostrSocial {
  private own: Record<string, NostrOwnCache> = {};
  private inflight = new Map<string, Promise<void>>();
  private loading = new Map<string, "profile" | "follows" | "notes">();
  private loadingOwn = new Set<string>();
  private errors = new Map<string, string>();
  private drafts = new Map<string, Draft>();

  constructor(private host: NostrSocialHost) {}

  private get now() { return Math.floor((this.host.now?.() ?? Date.now()) / 1000); }
  private get settings() { return effectiveNostrSettings(this.host.settings()); }
  private readOptions(): RelayReadOptions {
    return { makeSocket: this.host.makeSocket, signal: AbortSignal.timeout(20_000) };
  }

  async load(): Promise<void> {
    const settings = await store(STORES.settings, "readonly");
    this.own = (await wrap<Record<string, NostrOwnCache> | undefined>(settings.get(OWN_KEY))) ?? {};
  }
  private async saveOwn(): Promise<void> {
    await transact([STORES.settings], stores => { stores[STORES.settings].put(this.own, OWN_KEY); });
    this.host.emit();
  }

  // -- views --------------------------------------------------------------------------------------

  state(): NostrSocialState {
    return { settings: this.settings, own: this.host.ownSubjects().map(subject => this.ownView(subject)) };
  }

  private profileView(p: NostrProfile | undefined, avatar: string | undefined): NostrProfileView | undefined {
    if (!p) return undefined;
    const view: NostrProfileView = { hasPicture: !!p.picture, eventAt: p.eventAt, eventId: p.eventId };
    if (p.name) view.name = p.name;
    if (p.handle) view.handle = p.handle;
    if (p.about) view.about = p.about;
    if (p.nip05) view.nip05 = p.nip05;
    if (p.website) view.website = p.website;
    if (avatar) view.avatar = avatar;
    return view;
  }
  private stale = (fetchedAt: number) => this.now - fetchedAt > STALE_AFTER_SECONDS;

  private ownView(subject: string): NostrOwnView {
    const c = this.own[subject];
    const view: NostrOwnView = { subject, npub: npub(subject) };
    if (c?.profile) view.profile = { fetchedAt: c.profile.fetchedAt, relays: c.profile.relays, stale: this.stale(c.profile.fetchedAt), found: !!c.profile.profile, profile: this.profileView(c.profile.profile, c.profile.avatar) };
    if (c?.follows) view.follows = { fetchedAt: c.follows.fetchedAt, relays: c.follows.relays, stale: this.stale(c.follows.fetchedAt), follows: c.follows.follows, eventAt: c.follows.event?.created_at ?? 0 };
    if (c?.mute) view.mute = { fetchedAt: c.mute.fetchedAt, relays: c.mute.relays, pubkeys: c.mute.list?.pubkeys.length ?? 0, words: c.mute.list?.words.length ?? 0, notes: c.mute.list?.eventIds.length ?? 0, hasPrivate: c.mute.list?.hasPrivate ?? false };
    if (this.loadingOwn.has(subject)) view.loading = true;
    const error = this.errors.get(`own:${subject}`);
    if (error) view.error = error;
    return view;
  }

  /** Every mute list the person loaded for their keys, as one. */
  private muteLists(): NostrMuteList[] {
    return this.host.ownSubjects().map(s => this.own[s]?.mute?.list).filter((m): m is NostrMuteList => !!m);
  }
  private muted(note: NostrNote, author: string): boolean {
    return this.muteLists().some(m => !!mutedBecause(note, author, m));
  }

  linkView(linkId: string): NostrContactView[] | undefined {
    const subjects = this.host.contactSubjects(linkId);
    if (subjects.length === 0) return undefined;
    const cache = this.host.readContacts(linkId) ?? {};
    const myKeys = this.host.ownSubjects();
    return subjects.map(subject => {
      const c = cache[subject];
      const view: NostrContactView = { subject, npub: npub(subject) };
      if (c?.profile) view.profile = { fetchedAt: c.profile.fetchedAt, relays: c.profile.relays, stale: this.stale(c.profile.fetchedAt), found: !!c.profile.profile, profile: this.profileView(c.profile.profile, c.profile.avatar) };
      if (c?.follows) {
        view.follows = { fetchedAt: c.follows.fetchedAt, relays: c.follows.relays, stale: this.stale(c.follows.fetchedAt), count: c.follows.follows.length, eventAt: c.follows.eventAt };
        const mine = myKeys.map(k => ({ key: k, follows: this.own[k]?.follows })).find(x => x.follows);
        if (mine?.follows) {
          const h = followHints(c.follows.follows, mine.follows.follows, myKeys, subject);
          view.follows.hints = { followsYou: h.followsYou, youFollow: h.youFollow, mutual: h.mutual.length, myKey: mine.key, myFollowsAt: mine.follows.fetchedAt };
        }
      }
      if (c?.notes) {
        const authorMuted = this.muteLists().some(m => m.pubkeys.includes(subject));
        const shown = authorMuted ? [] : c.notes.notes.filter(n => !this.muted(n, subject));
        view.notes = { fetchedAt: c.notes.fetchedAt, relays: c.notes.relays, notes: shown.map(n => ({ id: n.id, createdAt: n.createdAt, content: n.content, reply: n.reply })), more: !c.notes.exhausted, hidden: c.notes.notes.length - shown.length, authorMuted };
      }
      const loading = this.loading.get(`${linkId}:${subject}`);
      if (loading) view.loading = loading;
      const error = this.errors.get(`${linkId}:${subject}`);
      if (error) view.error = error;
      return view;
    });
  }

  // -- contacts -----------------------------------------------------------------------------------

  private requireOnline() { if (!this.host.online()) throw new Error("Offline: turn the network on first"); }

  /** Only for a key this contact proved, and only when the person asks (or the auto-load setting says so). */
  async loadContact({ linkId, subject, what, more }: { linkId: string; subject: string; what: "profile" | "follows" | "notes"; more?: boolean }): Promise<void> {
    this.requireOnline();
    if (!this.host.contactSubjects(linkId).includes(subject)) throw new Error("This contact has not shared a verified Nostr identity with this key");
    const key = `${linkId}:${subject}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    this.errors.delete(key);
    this.loading.set(key, what);
    this.host.emit();
    const task = (async () => {
      try {
        if (what === "profile") await this.fetchProfile(linkId, subject);
        else if (what === "follows") await this.fetchFollows(linkId, subject);
        else await this.fetchNotes(linkId, subject, !!more);
      } catch (e) {
        this.errors.set(key, e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        this.loading.delete(key);
        this.inflight.delete(key);
        this.host.emit();
      }
    })();
    this.inflight.set(key, task);
    return task;
  }

  private async patchContact(linkId: string, subject: string, change: (c: NostrContactCache) => NostrContactCache): Promise<void> {
    if (!this.host.contactSubjects(linkId).includes(subject)) return;
    const all = { ...(this.host.readContacts(linkId) ?? {}) };
    all[subject] = change(all[subject] ?? { subject });
    await this.host.writeContacts(linkId, all);
  }

  private async fetchProfile(linkId: string, subject: string): Promise<void> {
    const { relays } = this.settings;
    const result = await readRelays(relays, { kinds: [KIND_PROFILE], authors: [subject], limit: 3 }, this.readOptions());
    if (result.answered.length === 0) throw new Error("No relay answered");
    const event = newestOf(result.events, KIND_PROFILE, subject);
    const profile = event ? parseProfile(event, subject) : undefined;
    let avatar: string | undefined;
    if (profile?.picture) {
      const small = await cacheAvatar(profile.picture);
      if (small && typeof sanitizeAvatar(small) === "string") avatar = small;
    }
    const fetchedAt = this.now;
    await this.patchContact(linkId, subject, c => ({ ...c, profile: { fetchedAt, relays: result.answered, profile, avatar } }));
    if (profile && (profile.name || avatar)) {
      const display: IdentityDisplay = { source: PROFILE_SOURCE, fetchedAt };
      if (profile.name) display.name = profile.name;
      if (avatar) display.avatar = avatar;
      await this.host.setDisplay(linkId, subject, display);
    }
  }

  private async fetchFollows(linkId: string, subject: string): Promise<void> {
    const result = await readRelays(this.settings.relays, { kinds: [KIND_FOLLOWS], authors: [subject], limit: 3 }, this.readOptions());
    if (result.answered.length === 0) throw new Error("No relay answered");
    const event = newestOf(result.events, KIND_FOLLOWS, subject);
    const parsed = event ? parseFollows(event, subject) : undefined;
    const fetchedAt = this.now;
    await this.patchContact(linkId, subject, c => ({ ...c, follows: { fetchedAt, relays: result.answered, follows: parsed?.follows ?? [], eventId: parsed?.eventId ?? "", eventAt: parsed?.eventAt ?? 0 } }));
  }

  private async fetchNotes(linkId: string, subject: string, more: boolean): Promise<void> {
    const current = this.host.readContacts(linkId)?.[subject]?.notes;
    const oldest = more && current?.notes.length ? Math.min(...current.notes.map(n => n.createdAt)) : undefined;
    const filter = { kinds: [KIND_NOTE], authors: [subject], limit: NOTES_PAGE, ...(oldest !== undefined ? { until: oldest - 1 } : {}) };
    const result = await readRelays(this.settings.relays, filter, { ...this.readOptions(), maxEvents: NOTES_PAGE * 2 });
    if (result.answered.length === 0) throw new Error("No relay answered");
    const page = result.events.map(e => parseNote(e, subject)).filter((n): n is NostrNote => !!n);
    const known = new Map((more ? current?.notes ?? [] : []).map(n => [n.id, n]));
    for (const n of page) known.set(n.id, n);
    const notes = [...known.values()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)).slice(0, MAX_NOTES_KEPT);
    const fetchedAt = this.now;
    await this.patchContact(linkId, subject, c => ({ ...c, notes: { fetchedAt, relays: result.answered, notes, exhausted: page.length < NOTES_PAGE || notes.length >= MAX_NOTES_KEPT } }));
  }

  async forgetContact({ linkId, subject }: { linkId: string; subject: string }): Promise<void> {
    const all = { ...(this.host.readContacts(linkId) ?? {}) };
    if (!(subject in all)) return;
    delete all[subject];
    this.errors.delete(`${linkId}:${subject}`);
    await this.host.writeContacts(linkId, all);
    this.host.emit();
  }

  /**
   * The chat's proofs changed, or the chat was opened: what was cached for a key that is no longer verified
   * is dropped (never shown under another proof), and, with the auto-load setting on, a missing or stale
   * profile is fetched.
   */
  async ledgerChanged(linkId: string): Promise<void> {
    const verified = this.host.contactSubjects(linkId);
    const cache = this.host.readContacts(linkId);
    if (cache) {
      const kept = Object.fromEntries(Object.entries(cache).filter(([s]) => verified.includes(s)));
      if (Object.keys(kept).length !== Object.keys(cache).length) await this.host.writeContacts(linkId, kept);
    }
    if (!this.settings.autoLoadProfiles || !this.host.online()) return;
    for (const subject of verified) {
      const p = this.host.readContacts(linkId)?.[subject]?.profile;
      if (!p || this.stale(p.fetchedAt)) await this.loadContact({ linkId, subject, what: "profile" }).catch(() => {});
    }
  }

  // -- the person's own keys ----------------------------------------------------------------------

  async loadOwn({ subject }: { subject: string }): Promise<void> {
    this.requireOnline();
    if (!this.host.ownSubjects().includes(subject)) throw new Error("No Nostr identity with this key in your profile");
    const key = `own:${subject}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    this.errors.delete(key);
    this.loadingOwn.add(subject);
    this.host.emit();
    const task = (async () => {
      try {
        const result = await readRelays(this.settings.relays, { kinds: [KIND_PROFILE, KIND_FOLLOWS, KIND_MUTE], authors: [subject], limit: 9 }, this.readOptions());
        if (result.answered.length === 0) throw new Error("No relay answered");
        const fetchedAt = this.now;
        const profileEvent = newestOf(result.events, KIND_PROFILE, subject);
        const profile = profileEvent ? parseProfile(profileEvent, subject) : undefined;
        let avatar: string | undefined;
        if (profile?.picture) { const small = await cacheAvatar(profile.picture); if (small && typeof sanitizeAvatar(small) === "string") avatar = small; }
        const followsEvent = newestOf(result.events, KIND_FOLLOWS, subject);
        const muteEvent = newestOf(result.events, KIND_MUTE, subject);
        this.own[subject] = {
          subject,
          profile: { fetchedAt, relays: result.answered, event: profileEvent, profile, avatar },
          follows: { fetchedAt, relays: result.answered, event: followsEvent, follows: followsEvent ? parseFollows(followsEvent, subject)?.follows ?? [] : [] },
          mute: { fetchedAt, relays: result.answered, event: muteEvent, list: muteEvent ? parseMuteList(muteEvent, subject) : undefined },
        };
        await this.saveOwn();
      } catch (e) {
        this.errors.set(key, e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        this.loadingOwn.delete(subject);
        this.inflight.delete(key);
        this.host.emit();
      }
    })();
    this.inflight.set(key, task);
    return task;
  }

  // -- publication --------------------------------------------------------------------------------

  private requirePublication(subject: string) {
    if (!this.settings.publish) throw new Error("Publishing on Nostr is off. Turn it on in Profile → Nostr first.");
    if (!this.host.ownSubjects().includes(subject)) throw new Error("No Nostr identity with this key in your profile");
    this.requireOnline();
  }

  /** The current replaceable event of `kind`, read fresh so a new version never drops what another app published. */
  private async current(subject: string, kind: number): Promise<NostrEvent | undefined> {
    const result = await readRelays(this.settings.relays, { kinds: [kind], authors: [subject], limit: 3 }, this.readOptions());
    if (result.answered.length === 0) throw new Error("No relay answered; publishing now could replace what you published elsewhere");
    const fresh = newestOf(result.events, kind, subject);
    const cached = kind === KIND_FOLLOWS ? this.own[subject]?.follows?.event : kind === KIND_PROFILE ? this.own[subject]?.profile?.event : undefined;
    return [fresh, cached].filter((e): e is NostrEvent => !!e).sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
  }

  async draft(request: NostrDraftRequest): Promise<NostrDraft> {
    this.requirePublication(request.subject);
    const { relays } = this.settings;
    const now = this.now;
    let template: EventTemplate, summary: string, kind: Draft["kind"];
    if (request.action === "note") {
      template = noteTemplate(request.content, now); summary = "Post a note"; kind = "note";
    } else if (request.action === "follow" || request.action === "unfollow") {
      const target = normalizePubkey(request.target);
      if (target === request.subject) throw new Error("That is your own key");
      template = followsTemplate(await this.current(request.subject, KIND_FOLLOWS), target, request.action === "follow", now);
      summary = `${request.action === "follow" ? "Follow" : "Unfollow"} ${shortNpub(target)}`; kind = request.action;
    } else if (request.action === "profile") {
      template = profileTemplate(await this.current(request.subject, KIND_PROFILE), request.fields, now);
      summary = "Update your profile"; kind = "profile";
    } else throw new Error("Unknown action");
    for (const [id, d] of this.drafts) if (Date.now() - d.at > DRAFT_TTL_MS) this.drafts.delete(id);
    while (this.drafts.size >= MAX_DRAFTS) this.drafts.delete(this.drafts.keys().next().value!);
    const draftId = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    this.drafts.set(draftId, { subject: request.subject, template, at: Date.now(), kind });
    const what = kind === "note" ? "This note" : kind === "profile" ? "Your profile" : "Your follow list";
    const notice = `${what} will be public on Nostr: sent to ${relays.join(", ")}, readable by anyone, kept by relays for as long as they like. Deleting later is a request relays may ignore. The relays learn your IP address.`;
    return { draftId, subject: request.subject, template, notice, summary, relays };
  }

  /** The draft, signed by the person's signer, checked against exactly what was drafted, then sent. */
  async publish({ draftId, event }: { draftId: string; event: unknown }): Promise<NostrPublishResult> {
    const draft = this.drafts.get(draftId);
    if (!draft || Date.now() - draft.at > DRAFT_TTL_MS) throw new Error("This draft is too old. Start again.");
    this.requirePublication(draft.subject);
    const signed = checkedEvent(event, 16 * 1024, this.host.now?.() ?? Date.now());
    if (!signed) throw new Error("The signer did not return a valid signed event");
    if (signed.pubkey !== draft.subject) throw new Error("Your signer holds a different key than this identity");
    const t = draft.template;
    if (signed.kind !== t.kind || signed.created_at !== t.created_at || signed.content !== t.content || JSON.stringify(signed.tags) !== JSON.stringify(t.tags))
      throw new Error("The signer changed the event; nothing was published");
    const result = await publishToRelays(this.settings.relays, signed, { makeSocket: this.host.makeSocket, signal: AbortSignal.timeout(20_000) });
    this.drafts.delete(draftId);
    if (result.accepted.length === 0) throw new Error(`No relay accepted it: ${result.rejected.map(r => `${r.relay}: ${r.reason}`).join("; ")}`);
    const own = this.own[draft.subject] ?? { subject: draft.subject };
    const fetchedAt = this.now;
    if (signed.kind === KIND_FOLLOWS) own.follows = { fetchedAt, relays: result.accepted, event: signed, follows: parseFollows(signed, draft.subject)?.follows ?? [] };
    if (signed.kind === KIND_PROFILE) own.profile = { fetchedAt, relays: result.accepted, event: signed, profile: parseProfile(signed, draft.subject), avatar: own.profile?.avatar };
    this.own[draft.subject] = own;
    await this.saveOwn();
    return result;
  }

  /** Housekeeping when a chat is removed or the engine stops. */
  forgetLink(linkId: string): void {
    for (const key of [...this.errors.keys()]) if (key.startsWith(`${linkId}:`)) this.errors.delete(key);
  }
  stop(): void {
    this.drafts.clear();
  }
}
