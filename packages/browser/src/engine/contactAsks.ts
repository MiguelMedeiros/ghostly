import {
  contactDay, createChatInvite, createIdentity, identityFromSeedB64, knockSlotIdentity, knockSlotOf, knockSlotRecords, makeStamp, mergeContactKnocks,
  readContactLink, readKnockSlot, readLinkRecord, requestRecords, seenEntry, ContactRequestError, REQUEST_LIFETIME_MS, STAMP_BITS_DEFAULT,
  type ContactRequest, type GhostRecord, type Identity,
} from "@ghostly/core";
import { STORES, store, wrap } from "../shared/idb";
import type { ContactAskView } from "../shared/types";
import { newDeviceKey, sealSeed, unsealSeed } from "./paymentAdapters/persistence";
import type { SealedProofKey } from "./identities";

/**
 * Asking through someone's contact link (WISP 8xx § Lifecycle, Asking), the requester's side. One asker key per
 * profile and link, kept for good so a second ask goes to the same place. The request, with a chat invite made for it,
 * goes under the asker key; the knock goes in its slot and is written again whenever it is gone, until the link's
 * record lists the request as seen. After that the chat waits like any invite nobody joined yet, for seven days.
 */

interface StoredAsk {
  /** The link's key. */
  link: string;
  seed: SealedProofKey;
  /** The asker key. */
  key: string;
  /** The chat whose invite the request carries, and that invite. */
  chatId?: string;
  invite?: string;
  name?: string;
  text?: string;
  issued?: number;
  expires?: number;
  state?: ContactAskView["state"];
  stamp?: { day: number; bits: number; stamp: number };
  publishedAt?: number;
  /** When its slot or the link's record was last read. */
  lookedAt?: number;
}

export interface ContactAskHost {
  online(): boolean;
  emit(): void;
  publish(identity: Identity, records: GhostRecord[]): Promise<void>;
  resolve(pubKeyZ32: string): Promise<GhostRecord[] | null>;
  /** A new chat made for the request: its invite, under the label the requester gave the link, opened with its text. */
  createChat(request: { label?: string; text: string }): Promise<{ linkId: string; inviteCode: string }>;
  /** Whether a contact link is this profile's own. */
  ownLink(linkKeyZ32: string): boolean;
}

export const CONTACT_ASKS_KEY = "contactAsks";
/** How often a request not yet seen is looked after: every 30 s for ten minutes, then every ten minutes. */
export const ASK_FAST_MS = 30_000;
export const ASK_FAST_FOR_MS = 10 * 60_000;
export const ASK_SLOW_MS = 10 * 60_000;
/** The request goes out again this often while it was not seen, so the DHT keeps it. */
export const REQUEST_REPUBLISH_MS = 60 * 60_000;
/** After a knock, its slot is read again this much later, twice at most: another requester may have written at once. */
export const KNOCK_CHECK_MS = 1_000;

const SLACK_MS = 5_000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class ContactAsks {
  private asks: StoredAsk[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private host: ContactAskHost) {}

  async load(): Promise<void> {
    this.asks = await wrap<StoredAsk[] | undefined>((await store(STORES.settings, "readonly")).get(CONTACT_ASKS_KEY)) ?? [];
  }

  start(): void {
    this.running = true;
    this.schedule(ASK_FAST_MS);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  views(): ContactAskView[] {
    return this.asks.filter(a => a.chatId && a.state).map(a => ({ chatId: a.chatId!, state: a.state!, expires: a.expires! }));
  }

  /**
   * Sends a request through a contact link. Refused, with the words the person reads, for a code that is not a contact
   * link, the profile's own link, a link turned off or busy, a request already waiting there, or a name or text that
   * breaks a bound. Nothing is made before every check passed.
   */
  ask(params: { code: string; name: string; text: string; label?: string }): Promise<{ chatId: string }> {
    return this.serial(() => this.send(params));
  }

  /** Looks after every request not yet seen once (the timer does this at its pace). */
  tick(): Promise<void> {
    return this.serial(() => this.look());
  }

  private async send({ code, name, text, label }: { code: string; name: string; text: string; label?: string }): Promise<{ chatId: string }> {
    const reading = readContactLink(code);
    if (!reading.ok) throw new Error(reading.reason === "chat" ? "This is a chat invite: open it in Join." : "This is not a Ghostly contact link.");
    const link = reading.linkKeyZ32;
    if (this.host.ownLink(link)) throw new Error("This is your contact link.");
    const now = Date.now();
    const known = this.asks.find(a => a.link === link);
    if (known?.state && known.state !== "ended" && known.state !== "off" && (known.expires ?? 0) > now) throw new Error("You already sent a request through this link.");
    const record = readLinkRecord(await this.host.resolve(link) ?? []);
    if (record?.state === "off") throw new Error("This contact link was turned off.");
    if (record?.state === "busy") throw new Error("They are not taking requests right now. Try again later.");
    const asker = known ? await this.identity(known) : createIdentity();
    const request = (invite: string): ContactRequest => ({ invite, name: name.trim(), text: text.trim(), issued: now, expires: now + REQUEST_LIFETIME_MS });
    try {
      // Checked with a throwaway invite first, so a name or text that does not fit makes no chat.
      requestRecords(asker.seedB64, link, request(createChatInvite().inviteCode));
    } catch (error) {
      if (!(error instanceof ContactRequestError)) throw error;
      // eslint-disable-next-line preserve-caught-error -- a message for the person; ES2020 has no Error.cause.
      throw new Error(error.problem === "name" ? "Write a name of up to 48 characters." : error.problem === "too-long" ? "Shorten the message." : "Write a message of up to 200 bytes.");
    }
    const chat = await this.host.createChat({ ...(label?.trim() ? { label: label.trim() } : {}), text: text.trim() });
    const sent = request(chat.inviteCode);
    // A request of before left nothing to reuse: its stamp, its publish and its looks are this request's to make.
    const ask: StoredAsk = {
      link, key: asker.pubKeyZ32, seed: known?.seed ?? await this.seal(asker),
      chatId: chat.linkId, invite: chat.inviteCode, name: sent.name, text: sent.text, issued: now, expires: sent.expires, state: "sending",
    };
    await this.put(ask);
    // The chat is answered at once, so the app takes it into its chat list before anything else (an app drops a chat
    // the engine made that it does not know after 15 s); the stamp, which can take seconds, and the publishing come
    // right after, as the first look.
    void this.tick().catch(() => {});
    this.schedule(ASK_FAST_MS);
    return { chatId: chat.linkId };
  }

  /** Publishes the request when due and knocks when its knock is gone. Never throws: the next look tries again. */
  private async goOut(ask: StoredAsk, asker: Identity, publish: boolean): Promise<void> {
    const now = Date.now();
    try {
      if (publish) {
        await this.host.publish(asker, requestRecords(asker.seedB64, ask.link, { invite: ask.invite!, name: ask.name!, text: ask.text!, issued: ask.issued!, expires: ask.expires! }));
        ask = { ...ask, publishedAt: now };
      }
      const slot = knockSlotIdentity(ask.link, knockSlotOf(ask.link, ask.key));
      for (let attempt = 0; attempt < 3; attempt++) {
        const knocks = readKnockSlot(ask.link, await this.host.resolve(slot.pubKeyZ32) ?? []);
        const stamp = ask.stamp!;
        if (knocks.some(k => k.key === ask.key && k.day === stamp.day && k.stamp === stamp.stamp)) break;
        if (attempt === 2) break;
        await this.host.publish(slot, knockSlotRecords(ask.link, mergeContactKnocks(knocks, { key: ask.key, day: stamp.day, stamp: stamp.stamp }, now)));
        await sleep(KNOCK_CHECK_MS);
      }
      ask = { ...ask, state: ask.state === "sending" ? "knocking" : ask.state, lookedAt: now };
    } catch {
      ask = { ...ask, lookedAt: now };
    }
    await this.put(ask);
    this.host.emit();
  }

  private async look(): Promise<void> {
    if (!this.host.online()) return;
    const now = Date.now();
    for (const ask of this.asks) {
      if (ask.state !== "sending" && ask.state !== "knocking" && ask.state !== "seen") continue;
      if (ask.expires! <= now) { await this.put({ ...ask, state: "ended" }); this.host.emit(); continue; }
      // Seen: nothing goes out for it any more; it waits for an answer until it ends.
      if (ask.state === "seen") continue;
      const pace = now - ask.issued! < ASK_FAST_FOR_MS ? ASK_FAST_MS : ASK_SLOW_MS;
      // The last look ended a few seconds after the timer that started it: a look due within `SLACK_MS` is due.
      if (ask.lookedAt !== undefined && now - ask.lookedAt < pace - SLACK_MS) continue;
      const record = readLinkRecord(await this.host.resolve(ask.link).catch(() => null) ?? []);
      if (record?.state === "off") { await this.put({ ...ask, state: "off" }); this.host.emit(); continue; }
      if (record?.seen.includes(seenEntry(ask.link, ask.key))) { await this.put({ ...ask, state: "seen" }); this.host.emit(); continue; }
      let next = ask;
      const day = contactDay(now);
      const bits = Math.max(record?.bits ?? STAMP_BITS_DEFAULT, STAMP_BITS_DEFAULT);
      // The owner takes today's and yesterday's stamps at the bits its link asks for now: make a new one when that fails.
      if (!next.stamp || next.stamp.day < day - 1 || next.stamp.bits < bits) next = { ...next, stamp: { day, bits, stamp: makeStamp(ask.link, ask.key, day, bits) } };
      await this.goOut(next, await this.identity(next), next.publishedAt === undefined || now - next.publishedAt >= REQUEST_REPUBLISH_MS);
    }
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().catch(() => {}).finally(() => {
        if (!this.running || this.timer) return;
        if (this.asks.some(a => a.state === "sending" || a.state === "knocking")) this.schedule(ASK_FAST_MS);
        // Only seen ones: a slow look, so one with no answer in seven days says so.
        else if (this.asks.some(a => a.state === "seen")) this.schedule(ASK_SLOW_MS);
      });
    }, ms);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }

  private async seal(identity: Identity): Promise<SealedProofKey> {
    const deviceKey = newDeviceKey();
    return { sealed: await sealSeed(identity.seedB64, deviceKey), deviceKey };
  }

  private async identity(ask: StoredAsk): Promise<Identity> {
    return identityFromSeedB64(await unsealSeed(ask.seed.sealed, ask.seed.deviceKey));
  }

  private async put(ask: StoredAsk): Promise<void> {
    const next = [...this.asks.filter(a => a.link !== ask.link), ask];
    await wrap((await store(STORES.settings, "readwrite")).put(next, CONTACT_ASKS_KEY));
    this.asks = next;
  }
}
