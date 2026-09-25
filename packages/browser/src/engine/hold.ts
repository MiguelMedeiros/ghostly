import { decodeControl, fromBase64Url, parseVoiceMeta, HOLD_LIMITS, HoldKeys, HoldRefusedError, newHoldMailbox, readManifest, utf8Decode, utf8Encode, type HoldPointer, type PaymentMethodName, type PaymentRequest, type PkarrTransport, type VoiceMeta } from "@ghostly/core";
import { heldName, manifestName, type HoldStore } from "../backup/storage";
import type { HeldEntry, HoldState, LinkHoldView, StoredLink } from "../shared/types";

export const emptyHoldState = (): HoldState => ({ enabled: false, outSeq: 0, inSeq: 0, peerAck: 0, pointerRev: 0, peerPointerRev: 0, outbox: [], refused: 0 });

/** What the engine gives store-and-forward: storage, discovery, the chats and where received items go. */
export interface HoldHost {
  transport: PkarrTransport;
  /** This device's storage for held items and its space, when set up. */
  storage(): { store: HoldStore; space: string } | null;
  link(linkId: string): { stored: StoredLink; open: boolean } | undefined;
  linkIds(): string[];
  saveHold(linkId: string, hold: HoldState): Promise<void>;
  /** A held item's chat message changed state. */
  delivery(linkId: string, messageId: string, state: "held" | "delivered" | "failed", error?: string): Promise<void>;
  /** What to seal, by kind. Null when it is gone (deleted). */
  text(linkId: string, messageId: string): Promise<string | null>;
  file(fileId: string): Promise<{ bytes: Uint8Array; name: string; size: number; mime: string; voice?: VoiceMeta } | null>;
  paymentRequest(paymentId: string): PaymentRequest | null;
  receiveText(linkId: string, message: { id: string; text: string; timestamp: number }): Promise<void>;
  /** Returns why it was not kept (room, a reused id), or null when it was. */
  receiveFile(linkId: string, file: { wireId: string; name: string; size: number; mime: string; timestamp: number; voice?: VoiceMeta }, bytes: Uint8Array, digest: string): Promise<string | null>;
  receivePaymentRequest(linkId: string, request: PaymentRequest): Promise<void>;
  changed(): void;
  fetch?: typeof fetch;
  now?: () => number;
  /** How long an item is held, when a test shortens it; never longer than the profile's seven days. */
  ttlMs?: () => number | undefined;
}

/** How often the engine looks at its held items: expiry, renewals, the contact's pointer. */
const TICK_MS = 30_000;
/** The contact's pointer is read this often while something is outstanding either way, else rarely. */
const POLL_BUSY_MS = 30_000;
const POLL_IDLE_MS = 5 * 60_000;
/** The manifest and its addresses are signed again before they get this old (they live seven days). */
const RENEW_AFTER_MS = 4 * 24 * 3600_000;
/** My pointer is published again this often while something is held, in case a relay forgot it. */
const REPUBLISH_MS = 60 * 60_000;
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Store-and-forward for away contacts (WISP 4xx, `hold/1`), on both ends of every chat that turned it
 * on: what this device sends while the contact is away is sealed and put in this device's own storage,
 * named in a manifest, and pointed at from a small record on the DHT; what the contact held for this
 * device is picked up from its pointer, checked and stored in order, and acknowledged on this device's
 * own pointer. Sequences, the outbox and the switch live on the chat's row; nothing is kept in memory
 * that a restart could not rebuild.
 */
export class HoldEngine {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly chains = new Map<string, Promise<void>>();
  private readonly keyCache = new Map<string, { peer: string; seed: string; keys: HoldKeys }>();
  private readonly lastPoll = new Map<string, number>();
  private readonly lastPublish = new Map<string, number>();
  private readonly expecting = new Map<string, number>();
  private readonly errors = new Map<string, string>();

  constructor(private readonly host: HoldHost) {}

  private now(): number { return this.host.now?.() ?? Date.now(); }
  private ttl(): number { const custom = this.host.ttlMs?.(); return custom && custom > 0 ? Math.min(custom, HOLD_LIMITS.ttlMs) : HOLD_LIMITS.ttlMs; }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick(true);
  }
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.chains.values()]);
  }

  private serialize(linkId: string, run: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(linkId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    this.chains.set(linkId, next.catch(() => {}));
    return next;
  }

  state(linkId: string): HoldState { return this.host.link(linkId)?.stored.hold ?? emptyHoldState(); }
  private async save(linkId: string, hold: HoldState): Promise<HoldState> {
    await this.host.saveHold(linkId, hold);
    return hold;
  }

  /** The keys for this chat, once the contact is pinned: cached per participation pair. */
  keysFor(linkId: string): HoldKeys | null {
    const live = this.host.link(linkId);
    const stored = live?.stored;
    if (!stored?.profile || !stored.participationSeed || !stored.pairedPeerKey) return null;
    const cached = this.keyCache.get(linkId);
    if (cached && cached.peer === stored.pairedPeerKey && cached.seed === stored.participationSeed) return cached.keys;
    try {
      const keys = new HoldKeys(stored, stored.participationSeed, stored.pairedPeerKey);
      this.keyCache.set(linkId, { peer: stored.pairedPeerKey, seed: stored.participationSeed, keys });
      return keys;
    } catch { return null; }
  }

  /** Items can be held for this contact now: both switched it on, storage is set up and the contact is pinned. */
  canHold(linkId: string): boolean {
    const hold = this.state(linkId);
    return hold.enabled && !!hold.peerAllows && !!this.host.storage() && !!this.keysFor(linkId);
  }
  /** Ways of paying a request held for this contact may name: what its app allowed at the last session. */
  heldPaymentMethods(linkId: string): PaymentMethodName[] | null {
    if (!this.canHold(linkId)) return null;
    return (this.state(linkId).peerPaymentMethods ?? []).filter((m) => m === "cashu" || m === "lightning");
  }

  view(linkId: string): LinkHoldView | undefined {
    const live = this.host.link(linkId);
    if (!live?.stored.profile) return undefined;
    const hold = this.state(linkId);
    const outstanding = hold.outbox.filter((e) => e.state !== "failed");
    return {
      enabled: hold.enabled, peerAllows: hold.peerAllows, storage: !!this.host.storage(), canHold: this.canHold(linkId),
      outstanding: outstanding.length, bytes: outstanding.reduce((sum, e) => sum + e.bytes, 0),
      maxBytes: HOLD_LIMITS.maxMailboxBytes, maxItems: HOLD_LIMITS.maxMailboxBundles, ttlMs: HOLD_LIMITS.ttlMs,
      refused: hold.refused, error: this.errors.get(linkId),
    };
  }

  async setEnabled(linkId: string, enabled: boolean): Promise<void> {
    await this.serialize(linkId, async () => {
      await this.save(linkId, { ...this.state(linkId), enabled });
    });
    this.host.changed();
    if (enabled) this.wake(linkId);
  }

  /** What the contact's app said on a session: whether it accepts held items, and how many it holds for this side. */
  async peerSaid(linkId: string, said: { peerAllows: boolean; peerTop?: number }): Promise<void> {
    await this.serialize(linkId, async () => {
      const hold = this.state(linkId);
      if (hold.peerAllows !== said.peerAllows) await this.save(linkId, { ...hold, peerAllows: said.peerAllows });
      if (said.peerTop !== undefined && said.peerTop > hold.inSeq) this.expecting.set(linkId, said.peerTop);
    });
    this.host.changed();
    if (this.expecting.has(linkId)) this.wake(linkId);
  }
  async rememberPeerMethods(linkId: string, methods: PaymentMethodName[]): Promise<void> {
    await this.serialize(linkId, async () => {
      const hold = this.state(linkId);
      if (JSON.stringify(hold.peerPaymentMethods ?? []) !== JSON.stringify(methods)) await this.save(linkId, { ...hold, peerPaymentMethods: methods });
    });
  }

  /** Storage was set up, changed or removed. */
  storageChanged(): void { this.host.changed(); void this.tick(true); }

  /** Someone is looking at this chat, or the app is back: read the contact's pointer now. */
  wake(linkId?: string): void {
    for (const id of linkId ? [linkId] : this.host.linkIds()) this.lastPoll.delete(id);
    void this.tick(true);
  }

  /**
   * Holds one item for the contact: a sequence and an object name are chosen and saved first, so a
   * retry after a crash uploads the same item under the same name, then the bundle is sealed, uploaded,
   * listed in the manifest and pointed at. The chat message goes `held` only once all of that is done.
   */
  hold(linkId: string, item: { kind: HeldEntry["kind"]; id: string; messageId: string; ref?: string; bytes: number; timestamp: number }): Promise<void> {
    return this.serialize(linkId, async () => {
      const storage = this.host.storage();
      const fail = async (error: string) => { await this.host.delivery(linkId, item.messageId, "failed", error); throw new Error(error); };
      if (!storage || !this.canHold(linkId)) return fail("Held messages need S3 storage (Profile → Backups) and a contact that allows them.");
      const hold = this.state(linkId);
      const outstanding = hold.outbox.filter((e) => e.state !== "failed");
      if (outstanding.length >= HOLD_LIMITS.maxMailboxBundles) return fail(`At most ${HOLD_LIMITS.maxMailboxBundles} items can wait for this contact. Wait until some are picked up.`);
      if (item.bytes > HOLD_LIMITS.maxBundleBytes - 4096) return fail(`An item held for an away contact is at most ${Math.round(HOLD_LIMITS.maxBundleBytes / 1024 / 1024)} MB.`);
      if (outstanding.reduce((sum, e) => sum + e.bytes, 0) + item.bytes > HOLD_LIMITS.maxMailboxBytes) return fail(`Items waiting for this contact would exceed ${Math.round(HOLD_LIMITS.maxMailboxBytes / 1024 / 1024)} MB. Wait until some are picked up.`);
      const mailbox = hold.mailbox ?? newHoldMailbox();
      const seq = hold.outSeq + 1;
      const now = this.now();
      const entry: HeldEntry = { seq, id: item.id, messageId: item.messageId, kind: item.kind, ref: item.ref, name: heldName(storage.space, mailbox, seq), bytes: item.bytes, ts: item.timestamp, expires: now + this.ttl(), state: "queued" };
      await this.save(linkId, { ...hold, mailbox, outSeq: seq, outbox: [...hold.outbox, entry] });
      await this.upload(linkId, entry);
    });
  }

  /** A failed item again, under its sequence and name; an item that was dropped (expired) is held anew by the caller. */
  retry(linkId: string, messageId: string): Promise<boolean> {
    let found = false;
    return this.serialize(linkId, async () => {
      const entry = this.state(linkId).outbox.find((e) => e.messageId === messageId);
      if (!entry) return;
      found = true;
      if (entry.state === "held") { await this.host.delivery(linkId, messageId, "held"); return; }
      await this.upload(linkId, entry);
    }).then(() => found);
  }

  /** Seals and uploads one queued or failed entry, then the manifest and the pointer. */
  private async upload(linkId: string, entry: HeldEntry): Promise<void> {
    const storage = this.host.storage(), keys = this.keysFor(linkId), hold = this.state(linkId);
    const update = async (patch: Partial<HeldEntry>) => this.save(linkId, { ...this.state(linkId), outbox: this.state(linkId).outbox.map((e) => (e.seq === entry.seq ? { ...e, ...patch } : e)) });
    const fail = async (error: string) => {
      await update({ state: "failed", error });
      this.errors.set(linkId, error);
      await this.host.delivery(linkId, entry.messageId, "failed", error);
      this.host.changed();
      throw new Error(error);
    };
    if (!storage || !keys || !hold.mailbox) return fail("Held messages need S3 storage (Profile → Backups) and a pinned contact.");
    let body: Uint8Array, meta: unknown;
    try {
      if (entry.kind === "text") {
        const text = await this.host.text(linkId, entry.messageId);
        if (text === null) return fail("The message is gone");
        body = utf8Encode(text);
      } else if (entry.kind === "file") {
        const file = await this.host.file(entry.ref!);
        if (!file) return fail("The file is gone");
        body = file.bytes; meta = { name: file.name, size: file.size, mime: file.mime, ...(file.voice && { voice: file.voice }) };
      } else {
        const request = this.host.paymentRequest(entry.ref!);
        if (!request) return fail("The payment request is gone");
        body = utf8Encode(JSON.stringify({ id: request.id, ts: request.timestamp, v: request.amount.value, u: request.amount.asset, memo: request.memo, e: request.endpoints, a: request.ask }));
      }
    } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
    let bytes: Uint8Array;
    try { bytes = keys.seal({ mailbox: hold.mailbox, seq: entry.seq, id: entry.id, ts: entry.ts, kind: entry.kind, meta, expires: entry.expires }, body); }
    catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
    if (bytes.length > HOLD_LIMITS.maxBundleBytes) return fail(`An item held for an away contact is at most ${Math.round(HOLD_LIMITS.maxBundleBytes / 1024 / 1024)} MB.`);
    try { await storage.store.put(entry.name, bytes); }
    catch (error) { return fail(`Could not store the item: ${error instanceof Error ? error.message : String(error)}`); }
    await update({ state: "held", error: undefined, bytes: bytes.length });
    try { await this.publish(linkId, true); }
    catch (error) { return fail(`Stored, but could not tell the contact where: ${error instanceof Error ? error.message : String(error)}`); }
    this.errors.delete(linkId);
    await this.host.delivery(linkId, entry.messageId, "held");
    this.host.changed();
  }

  /** A message deleted here: its held item goes too, so the contact never picks it up. */
  forget(linkId: string, messageId: string): Promise<void> {
    return this.serialize(linkId, async () => {
      const hold = this.state(linkId);
      const entry = hold.outbox.find((e) => e.messageId === messageId);
      if (!entry) return;
      await this.save(linkId, { ...hold, outbox: hold.outbox.filter((e) => e !== entry) });
      await this.host.storage()?.store.remove(entry.name).catch(() => {});
      if (entry.state === "held") await this.publish(linkId, true).catch(() => {});
    });
  }
  forgetLink(linkId: string): void {
    this.keyCache.delete(linkId); this.lastPoll.delete(linkId); this.lastPublish.delete(linkId); this.expecting.delete(linkId); this.errors.delete(linkId); this.chains.delete(linkId);
  }

  /**
   * Writes the manifest (every held item with a fresh presigned address) and publishes my pointer: where
   * the manifest is, the highest sequence held, and the highest sequence received from the contact.
   */
  private async publish(linkId: string, rewriteManifest: boolean): Promise<void> {
    const storage = this.host.storage(), keys = this.keysFor(linkId);
    let hold = this.state(linkId);
    if (!keys) throw new Error("The contact is not pinned");
    const now = this.now();
    const held = hold.outbox.filter((e) => e.state === "held");
    let manifestUrl: string | null = null;
    const expires = now + HOLD_LIMITS.ttlMs;
    if (held.length && storage && hold.mailbox) {
      if (rewriteManifest || !hold.manifestSignedAt) {
        const entries = [];
        for (const entry of held) entries.push([entry.seq, entry.id, entry.kind, entry.bytes, await storage.store.presign(entry.name, HOLD_LIMITS.ttlMs / 1000), entry.expires]);
        const manifest = keys.seal({ mailbox: hold.mailbox, seq: hold.pointerRev + 1, id: `manifest-${hold.pointerRev + 1}`, ts: now, kind: "manifest", meta: { entries }, expires }, new Uint8Array());
        await storage.store.put(manifestName(storage.space, hold.mailbox), manifest);
        hold = await this.save(linkId, { ...this.state(linkId), manifestSignedAt: now });
      }
      manifestUrl = await storage.store.presign(manifestName(storage.space, hold.mailbox!), HOLD_LIMITS.ttlMs / 1000);
    } else if (hold.mailbox && storage && rewriteManifest && hold.manifestSignedAt) {
      await storage.store.remove(manifestName(storage.space, hold.mailbox)).catch(() => {});
      hold = await this.save(linkId, { ...this.state(linkId), manifestSignedAt: undefined });
    }
    const pointer: HoldPointer = { rev: hold.pointerRev + 1, issued: now, expires, manifestUrl, top: hold.outSeq, ack: hold.inSeq, count: held.length, bytes: held.reduce((sum, e) => sum + e.bytes, 0), refused: hold.refusedSeqs ?? [] };
    const records = keys.pointerRecords(pointer, now);
    await this.save(linkId, { ...this.state(linkId), pointerRev: pointer.rev });
    await this.host.transport.publish(keys.identity, records);
    this.lastPublish.set(linkId, now);
  }

  /** Every chat with the feature on: expiry, renewals, and the contact's pointer when it is due. */
  private async tick(all = false): Promise<void> {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const linkId of this.host.linkIds()) {
      const hold = this.state(linkId);
      if (!hold.enabled || !this.keysFor(linkId)) continue;
      await this.serialize(linkId, () => this.maintain(linkId)).catch(() => {});
      const busy = hold.outbox.some((e) => e.state !== "failed") || this.expecting.has(linkId);
      const due = (this.lastPoll.get(linkId) ?? 0) + (busy ? POLL_BUSY_MS : POLL_IDLE_MS) <= this.now();
      if (hold.peerAllows && (all || due) && (this.lastPoll.get(linkId) ?? 0) + 5_000 <= this.now()) await this.serialize(linkId, () => this.poll(linkId)).catch(() => {});
    }
    if (this.running) this.timer = setTimeout(() => void this.tick(), TICK_MS);
  }

  /** Queued items go up, expired ones are dropped, old manifests are signed again, a held pointer is repeated. */
  private async maintain(linkId: string): Promise<void> {
    const now = this.now();
    let hold = this.state(linkId);
    const expired = hold.outbox.filter((e) => e.state !== "failed" && e.expires <= now);
    if (expired.length) {
      hold = await this.save(linkId, { ...hold, outbox: hold.outbox.filter((e) => !expired.includes(e)) });
      for (const entry of expired) {
        await this.host.storage()?.store.remove(entry.name).catch(() => {});
        await this.host.delivery(linkId, entry.messageId, "failed", "Held for its whole lifetime without being picked up. Retry to hold it again.");
      }
      this.host.changed();
    }
    for (const entry of hold.outbox.filter((e) => e.state === "queued")) await this.upload(linkId, entry).catch(() => {});
    hold = this.state(linkId);
    const held = hold.outbox.some((e) => e.state === "held");
    if (this.host.storage() && (expired.length || (held && (hold.manifestSignedAt ?? 0) + RENEW_AFTER_MS <= now))) await this.publish(linkId, true).catch((error) => this.errors.set(linkId, String(error instanceof Error ? error.message : error)));
    else if (held && (this.lastPublish.get(linkId) ?? 0) + REPUBLISH_MS <= now) await this.publish(linkId, false).catch(() => {});
  }

  /**
   * Reads the contact's pointer: what it received of ours becomes `delivered` and leaves storage; what it
   * holds for us beyond what we have is fetched from its manifest, checked and stored in order, then
   * acknowledged on our pointer. An item that fails its checks is refused and skipped, never stored.
   */
  private async poll(linkId: string): Promise<void> {
    const keys = this.keysFor(linkId);
    if (!keys) return;
    const now = this.now();
    this.lastPoll.set(linkId, now);
    let packet;
    try { packet = await this.host.transport.resolve(keys.peerAddress); }
    catch (error) { this.errors.set(linkId, `Could not read the contact's pointer: ${error instanceof Error ? error.message : String(error)}`); this.host.changed(); return; }
    const pointer = packet ? keys.readPointer(packet, now) : null;
    if (!pointer) return;
    let hold = this.state(linkId);
    if (pointer.rev < hold.peerPointerRev) return;
    if (pointer.rev !== hold.peerPointerRev) hold = await this.save(linkId, { ...hold, peerPointerRev: pointer.rev });
    // What the contact received is delivered here, and leaves storage; what it refused is failed here, with the reason.
    const settled = hold.outbox.filter((e) => e.state !== "failed" && e.seq <= pointer.ack);
    if (settled.length) {
      hold = await this.save(linkId, { ...hold, peerAck: pointer.ack, outbox: hold.outbox.filter((e) => !settled.includes(e)) });
      for (const entry of settled) {
        if (pointer.refused.includes(entry.seq)) await this.host.delivery(linkId, entry.messageId, "failed", "Your contact's app refused this item: it could not be verified as yours, or was too large for it. Retry to hold it again.");
        else await this.host.delivery(linkId, entry.messageId, "delivered");
        await this.host.storage()?.store.remove(entry.name).catch(() => {});
      }
      await this.publish(linkId, true).catch(() => {});
      this.host.changed();
    } else if (pointer.ack !== hold.peerAck) hold = await this.save(linkId, { ...hold, peerAck: pointer.ack });
    if (pointer.top <= hold.inSeq) { this.expecting.delete(linkId); return; }
    if (!pointer.manifestUrl || pointer.expires <= now) { this.errors.set(linkId, "The contact holds items for you, but their address expired. They are handed out again when the contact is next online."); this.host.changed(); return; }
    let entries: ReturnType<typeof readManifest>, mailbox: string;
    try {
      const manifest = keys.open(await this.fetchBytes(pointer.manifestUrl, HOLD_LIMITS.maxManifestBytes), { maxBytes: HOLD_LIMITS.maxManifestBytes, now });
      if (manifest.header.kind !== "manifest") throw new HoldRefusedError("format", "Not a manifest");
      mailbox = manifest.header.mailbox;
      entries = readManifest(manifest.header.meta).filter(([seq]) => seq > this.state(linkId).inSeq);
    } catch (error) {
      if (error instanceof HoldRefusedError) { await this.save(linkId, { ...this.state(linkId), refused: this.state(linkId).refused + 1 }); this.errors.set(linkId, `Refused what the contact's storage offered: ${error.message}`); }
      else this.errors.set(linkId, `Could not pick up held items: ${error instanceof Error ? error.message : String(error)}`);
      this.host.changed();
      return;
    }
    let changed = false, stop = false;
    for (const [seq, id, kind, bytes, url, expires] of entries) {
      if (stop) break;
      if (expires <= now) { await this.save(linkId, { ...this.state(linkId), inSeq: seq }); changed = true; continue; }
      try {
        // Every item must come from the mailbox its manifest names: one folder, one contact, one direction.
        const { header, body } = keys.open(await this.fetchBytes(url, Math.min(bytes, HOLD_LIMITS.maxBundleBytes)), { maxBytes: HOLD_LIMITS.maxBundleBytes, now, mailbox });
        if (header.seq !== seq || header.id !== id || header.kind !== kind) throw new HoldRefusedError("format", "The item does not match the manifest");
        // Stored before the sequence advances: a crash in between stores it again, which the id dedups.
        if (header.kind === "text") await this.host.receiveText(linkId, { id: header.id, text: utf8Decode(body), timestamp: header.ts });
        else if (header.kind === "file") {
          const meta = header.meta as { name: string; size: number; mime: string; voice?: unknown };
          const voice = parseVoiceMeta(meta.voice, meta.mime);
          const refused = await this.host.receiveFile(linkId, { wireId: header.id, name: meta.name, size: meta.size, mime: meta.mime, timestamp: header.ts, ...(voice && { voice }) }, body, hex(fromBase64Url(header.digest)));
          if (refused) throw new HoldRefusedError("limits", refused);
        } else if (header.kind === "pay-req") {
          let parsed: unknown;
          try { parsed = JSON.parse(utf8Decode(body)); } catch { throw new HoldRefusedError("format", "Not a payment request"); }
          const frame = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? decodeControl(JSON.stringify({ ...(parsed as object), t: "pay-req" })) : null;
          if (frame?.t !== "pay-req") throw new HoldRefusedError("format", "Not a payment request");
          await this.host.receivePaymentRequest(linkId, { id: frame.id, timestamp: frame.ts, amount: { value: frame.v, asset: frame.u }, memo: frame.memo, endpoints: frame.e, ask: frame.a });
        }
        hold = await this.save(linkId, { ...this.state(linkId), inSeq: seq });
        changed = true;
      } catch (error) {
        if (error instanceof HoldRefusedError) {
          await this.save(linkId, { ...this.state(linkId), inSeq: seq, refused: this.state(linkId).refused + 1, refusedSeqs: [...(this.state(linkId).refusedSeqs ?? []), seq].slice(-32) });
          this.errors.set(linkId, `Refused a held item from the contact: ${error.message}`);
          changed = true;
        } else {
          // A network or storage problem: the next poll starts here again.
          this.errors.set(linkId, `Could not pick up held items: ${error instanceof Error ? error.message : String(error)}`);
          stop = true;
        }
      }
    }
    if (!stop) this.expecting.delete(linkId);
    if (changed) {
      await this.publish(linkId, false).catch((error) => this.errors.set(linkId, `Picked up, but could not acknowledge: ${error instanceof Error ? error.message : String(error)}`));
      if (!stop && !this.errors.get(linkId)?.startsWith("Refused")) this.errors.delete(linkId);
    }
    this.host.changed();
  }

  /** A presigned address read whole, but never past `max` bytes: what the manifest declared, not what a server sends. */
  private async fetchBytes(url: string, max: number): Promise<Uint8Array> {
    const doFetch = this.host.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    const response = await doFetch(url, { cache: "no-store", credentials: "omit" });
    if (!response.ok) throw new Error(`The storage answered ${response.status}`);
    const declared = Number(response.headers.get("content-length"));
    if (declared > max) throw new HoldRefusedError("size", "The held item is larger than the manifest said");
    if (!response.body) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > max) throw new HoldRefusedError("size", "The held item is larger than the manifest said");
      return bytes;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      size += next.value.length;
      if (size > max) { await reader.cancel().catch(() => {}); throw new HoldRefusedError("size", "The held item is larger than the manifest said"); }
      chunks.push(next.value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
    return out;
  }
}
