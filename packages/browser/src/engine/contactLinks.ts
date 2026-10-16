import {
  createContactLink, encodeContactLink, endedRequests, identityFromSeedB64, inboxRecord, inviteLink, knockSlotIdentity, linkRecords, newInbox, openRequest,
  planKnocks, readKnockSlot, settleRequest, takeRequest, turnOff, KNOCK_SLOTS, type ContactRequest, type GhostRecord, type Identity, type InboxState,
} from "@ghostly/core";
import { STORES, store, wrap } from "../shared/idb";
import type { ContactLinkView, ContactRequestView } from "../shared/types";
import { newDeviceKey, sealSeed, unsealSeed } from "./paymentAdapters/persistence";
import type { SealedProofKey } from "./identities";

/**
 * The profile's contact link (WISP 8xx Contact Links), the owner's side: one link at a time, its key made for the link
 * alone and kept sealed like a proof key, its link record published while online and re-published every hour so the
 * DHT keeps it. A link turned off (or replaced by a new one) says `off` under its old key once a day for 30 days, then
 * its seed is forgotten.
 *
 * Requests: the four knock slots are read at the link's pace, each new asker key that knocked with a good stamp has
 * its request read within the limits of `contactInbox.ts`, and what opens and holds waits in Requests, the link's
 * record listing it as seen. Nothing reaches the chat list from here.
 */

interface StoredLink {
  seed: SealedProofKey;
  linkKeyZ32: string;
  createdAt: number;
}

/** A request in Requests: what the asker sent, under its asker key. */
interface StoredRequest extends ContactRequest {
  key: string;
  receivedAt: number;
}

interface StoredContactLinks {
  current?: StoredLink & { inbox: InboxState; published?: number; requests?: StoredRequest[] };
  /** Links turned off, still saying so. */
  retired: Array<StoredLink & { offAt: number; said?: number }>;
}

export interface ContactLinkHost {
  online(): boolean;
  emit(): void;
  /** Puts records under a key on Pkarr (the relays and, on Desktop, the DHT). */
  publish(identity: Identity, records: GhostRecord[]): Promise<void>;
  /** The records under a key, or null when nothing is there. */
  resolve(pubKeyZ32: string): Promise<GhostRecord[] | null>;
  /** Whether a chat invite is one this profile made or already joined: a request carrying one is no request. */
  ownInvite(code: string): boolean;
}

export const CONTACT_LINKS_KEY = "contactLinks";
/** Mainline keeps a mutable item about two hours: the link record goes out again every hour. */
export const LINK_REPUBLISH_MS = 60 * 60_000;
/** A retired link says `off` this often, for `OFF_FOR_MS`. */
export const OFF_REPUBLISH_MS = 24 * 60 * 60_000;
export const OFF_FOR_MS = 30 * 24 * 60 * 60_000;
const FIRST_PUBLISH_MS = 15_000;
const RETRY_MS = 5 * 60_000;
/** How often the knock slots are read: every five minutes, and every 15 s for ten minutes after the link or Requests was shown. */
export const POLL_MS = 5 * 60_000;
export const POLL_SHOWN_MS = 15_000;
export const SHOWN_FOR_MS = 10 * 60_000;

export class ContactLinks {
  private stored: StoredContactLinks = { retired: [] };
  private error: string | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight: Promise<void> | null = null;
  private again = false;
  private writes: Promise<void> = Promise.resolve();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private shownAt = -Infinity;
  /** Making, turning off, taking and settling requests run one at a time: each reads and writes the whole record. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private host: ContactLinkHost) {}

  async load(): Promise<void> {
    const found = await wrap<StoredContactLinks | undefined>((await store(STORES.settings, "readonly")).get(CONTACT_LINKS_KEY));
    this.stored = found ?? { retired: [] };
  }

  start(): void {
    this.running = true;
    this.schedule(FIRST_PUBLISH_MS);
    this.schedulePoll(FIRST_PUBLISH_MS);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  /**
   * The link was shown or copied, or Requests opened: people open a link in the minutes after it is shared, and the
   * owner looking at Requests wants what came. Look now, and more often for ten minutes.
   */
  shown(): void {
    this.shownAt = Date.now();
    this.schedulePoll(0);
  }

  /** The requests waiting, newest first. */
  requests(): ContactRequestView[] {
    return [...this.stored.current?.requests ?? []].reverse().map(r => ({ id: r.key, name: r.name, text: r.text, receivedAt: r.receivedAt, expires: r.expires }));
  }

  /** Reads the knock slots once and takes what is new into Requests. */
  poll(): Promise<void> {
    return this.serial(() => this.take());
  }

  /** Undefined while the profile has no link. */
  view(): ContactLinkView | undefined {
    const current = this.stored.current;
    if (!current) return undefined;
    const code = encodeContactLink(current.linkKeyZ32);
    return {
      code,
      link: inviteLink(code),
      createdAt: current.createdAt,
      state: current.inbox.state === "busy" ? "busy" : "open",
      waiting: current.inbox.waiting.length,
      missed: current.inbox.missed.length,
      ...(current.published ? { publishedAt: current.published } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** Makes the profile's link, turning the one before off: one link per profile at a time. */
  create(): Promise<ContactLinkView> {
    return this.serial(() => this.make());
  }

  private async make(): Promise<ContactLinkView> {
    const made = createContactLink();
    const deviceKey = newDeviceKey();
    const now = Date.now();
    const retired = this.retire(now);
    await this.save({
      current: { seed: { sealed: await sealSeed(made.seedB64, deviceKey), deviceKey }, linkKeyZ32: made.linkKeyZ32, createdAt: now, inbox: newInbox(now) },
      retired,
    });
    this.host.emit();
    await this.publishNow();
    return this.view()!;
  }

  /** Turns the link off, for good: requesters who open it are told so. */
  turnOff(): Promise<void> {
    return this.serial(() => this.off());
  }

  private async off(): Promise<void> {
    if (!this.stored.current) return;
    await this.save({ retired: this.retire(Date.now()) });
    this.host.emit();
    await this.publishNow();
  }

  /** "Clear all data": the link says `off` once, now, and nothing is kept. */
  async withdraw(): Promise<void> {
    this.stop();
    const links = [...(this.stored.current ? [this.stored.current] : []), ...this.stored.retired];
    await Promise.allSettled(links.map(async link => this.host.publish(await this.identity(link), linkRecords(inboxRecord(turnOff(newInbox(Date.now())), Date.now())))));
  }

  /** Publishes what is due now: the current link's record, and `off` for each retired link not said today. */
  async publishNow(): Promise<void> {
    if (this.inFlight) { this.again = true; return this.inFlight; }
    this.inFlight = this.publish().finally(() => { this.inFlight = null; });
    await this.inFlight;
    if (this.again) { this.again = false; await this.publishNow(); }
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }

  private schedulePoll(ms: number): void {
    if (!this.running) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll().catch(() => {}).finally(() => {
        if (!this.running || this.pollTimer) return;
        const shown = Date.now() - this.shownAt < SHOWN_FOR_MS;
        this.schedulePoll(shown ? POLL_SHOWN_MS : POLL_MS);
      });
    }, ms);
  }

  private async take(): Promise<void> {
    const current = this.stored.current;
    if (!current || !this.host.online()) return;
    const now = Date.now();
    const linkKey = current.linkKeyZ32;
    const slots = await Promise.all(Array.from({ length: KNOCK_SLOTS }, (_, i) => this.host.resolve(knockSlotIdentity(linkKey, i).pubKeyZ32).catch(() => null)));
    let inbox = current.inbox;
    for (const key of endedRequests(inbox, now)) inbox = settleRequest(inbox, key, "ended");
    const plan = planKnocks(linkKey, inbox, slots.flatMap(records => records ? readKnockSlot(linkKey, records) : []), now);
    inbox = plan.inbox;
    const taken: StoredRequest[] = [];
    if (plan.read.length) {
      const { seedB64 } = await this.identity(current);
      for (const key of plan.read) {
        const records = await this.host.resolve(key).catch(() => null);
        const request = records ? openRequest(seedB64, key, records, now) : null;
        if (!request || this.host.ownInvite(request.invite)) continue;
        inbox = takeRequest(linkKey, inbox, key, request.expires, now);
        taken.push({ ...request, key, receivedAt: now });
      }
    }
    // A publish that went out meanwhile marked the link: keep its mark. Requests are only ever changed in this queue.
    const latest = this.stored.current;
    if (!latest || latest.linkKeyZ32 !== linkKey) return;
    const requests = [...current.requests ?? [], ...taken].filter(r => inbox.waiting.some(w => w.key === r.key));
    const changed = plan.publish || taken.length > 0 || inbox.state !== current.inbox.state || inbox.bits !== current.inbox.bits;
    await this.save({ ...this.stored, current: { ...latest, inbox, requests } });
    this.host.emit();
    if (changed) await this.publishNow();
  }

  private retire(now: number): StoredContactLinks["retired"] {
    const kept = this.stored.retired.filter(link => now - link.offAt < OFF_FOR_MS);
    const current = this.stored.current;
    return current ? [...kept, { seed: current.seed, linkKeyZ32: current.linkKeyZ32, createdAt: current.createdAt, offAt: now }] : kept;
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.publishNow().finally(() => { if (this.running && !this.timer) this.schedule(this.error ? RETRY_MS : LINK_REPUBLISH_MS); });
    }, ms);
  }

  private async publish(): Promise<void> {
    if (!this.host.online()) return;
    const now = Date.now();
    const { current, retired } = this.stored;
    let published = false;
    const said = new Set<string>();
    this.error = undefined;
    if (current) {
      try {
        await this.host.publish(await this.identity(current), linkRecords(inboxRecord(current.inbox, now)));
        published = true;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      }
    }
    for (const link of retired) {
      if (now - link.offAt >= OFF_FOR_MS || (link.said !== undefined && now - link.said < OFF_REPUBLISH_MS)) continue;
      try {
        await this.host.publish(await this.identity(link), linkRecords(inboxRecord(turnOff(newInbox(now)), now)));
        said.add(link.linkKeyZ32);
      } catch { /* said again at the next pass */ }
    }
    // A link made or turned off while this pass was out keeps what it is: only the marks of what went out are added.
    const latest = this.stored;
    await this.save({
      ...(latest.current ? { current: published && latest.current.linkKeyZ32 === current?.linkKeyZ32 ? { ...latest.current, published: now } : latest.current } : {}),
      retired: latest.retired.filter(link => now - link.offAt < OFF_FOR_MS).map(link => said.has(link.linkKeyZ32) ? { ...link, said: now } : link),
    });
    this.host.emit();
  }

  private async identity(link: StoredLink): Promise<Identity> {
    return identityFromSeedB64(await unsealSeed(link.seed.sealed, link.seed.deviceKey));
  }

  /**
   * The record is the one in memory from now on, and the writes go to the database in the order they were made: a
   * publish that ends while a request is being taken can never put back the record from before it.
   */
  private save(next: StoredContactLinks): Promise<void> {
    this.stored = next;
    const write = this.writes.then(async () => { await wrap((await store(STORES.settings, "readwrite")).put(next, CONTACT_LINKS_KEY)); });
    this.writes = write.catch(() => {});
    return write;
  }
}
