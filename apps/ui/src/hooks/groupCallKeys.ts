import { BaseKeyProvider, createKeyMaterialFromBuffer, KeyProviderEvent, type KeyInfo } from "livekit-client";

/*
 * A sealed group call's keys (WISP 602 § End-to-end encryption), one per epoch, each in its own slot of LiveKit's
 * shared key ring. Loaded only with livekit-client, at the join (`groupCallLivekit.ts`).
 *
 * LiveKit seals each frame with the ring's current key and writes that key's slot in the frame's last byte
 * (livekit-client 2.24.0 `worker/FrameCryptor.ts:514,539`); a member opens it with the key in the slot the byte names
 * (`:716-723`). Its `ExternalE2EEKeyProvider.setKey` always uses slot 0, so the new epoch's key replaced the old one
 * there for sending and opening at once: at each epoch move, members on the new key and members still on the old one
 * dropped each other's frames until everyone had moved. Here epoch `e` goes in slot `e % 16`, and the key of the
 * epoch before stays openable for a moment (`PREVIOUS_KEY_MS`).
 */

/** Slots in the ring: LiveKit's default `keyringSize` (`KEY_PROVIDER_DEFAULTS`), set here all the same. */
export const CALL_KEY_SLOTS = 16;

/**
 * How long the key of the epoch before stays openable after a move: frames sealed with it still in flight, and
 * members whose commit is still on its way, are heard meanwhile. Then it is taken out, so a member removed from the
 * group but still in the room (WISP 602 § Removal) is not heard for long with the key it holds.
 */
export const PREVIOUS_KEY_MS = 10_000;

/** The ring slot an epoch's key goes in. Two epochs 16 apart share one: a call never has both in use. */
export const callKeySlot = (epoch: number): number => ((epoch % CALL_KEY_SLOTS) + CALL_KEY_SLOTS) % CALL_KEY_SLOTS;

interface Held {
  /** The epoch whose key is in the slot; null once taken out (a random key nobody has). */
  epoch: number | null;
  info: KeyInfo;
}

/**
 * LiveKit's shared-key provider, as `ExternalE2EEKeyProvider` sets it up (`sharedKey`, no ratchet, a failing key never
 * marked invalid: livekit-client `e2ee/KeyProvider.ts:89-99`), with each epoch's key in its own slot.
 *
 * `setEpochKey` goes through `onSetEncryptionKey(key, undefined, slot)`, which tells the room to make that slot the
 * current one (`KeyProvider.ts:39-43`; `E2eeManager.ts:461-462` posts it with `updateCurrentKeyIndex`; the worker's
 * `ParticipantKeyHandler.setKeyFromMaterial` sets the slot and `currentKeyIndex`, `:177,184`): this device seals with
 * the newest epoch's key from then on and opens the epoch before's frames too. The epoch before's slot is overwritten
 * with a random key after `previousKeyMs` (and any older one at once), told to the room without moving the current
 * slot. `getKeys` gives the ring as it is, which the room sets again at each (re)connect (`E2eeManager.ts:430-433`).
 */
export class GroupCallKeyProvider extends BaseKeyProvider {
  private readonly slots = new Map<number, Held>();
  private current: number | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private ended = false;

  constructor(private readonly previousKeyMs = PREVIOUS_KEY_MS) {
    super({ sharedKey: true, ratchetWindowSize: 0, failureTolerance: -1, keyringSize: CALL_KEY_SLOTS });
  }

  /** Sets `epoch`'s raw key (HKDF material, as `ExternalE2EEKeyProvider` takes an ArrayBuffer) as the one to seal with. */
  setEpochKey(epoch: number, key: ArrayBuffer): Promise<void> {
    return this.queued(async () => {
      const material = await createKeyMaterialFromBuffer(key);
      if (this.ended) return;
      const before = this.current;
      const slot = callKeySlot(epoch);
      this.slots.set(slot, { epoch, info: { key: material, keyIndex: slot } });
      this.current = epoch;
      this.onSetEncryptionKey(material, undefined, slot);
      for (const [s, held] of this.slots) {
        if (s === slot || held.epoch === null) continue;
        const was = held.epoch;
        if (was === before) this.later(() => this.retire(s, was));
        else await this.retire(s, was);
      }
    });
  }

  /** The epoch whose key this device seals with now, or null before the first. */
  get epoch(): number | null {
    return this.current;
  }

  /** Each slot's key as the ring holds it (the room sets them all again when it connects). */
  override getKeys(): KeyInfo[] {
    return [...this.slots.values()].map((held) => held.info);
  }

  /** The call is over: no key is taken out later (the room and its worker are gone). */
  dispose(): void {
    this.ended = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  /** Overwrites `slot` with a random key, if it still holds `epoch`'s and isn't the one sealed with. */
  private async retire(slot: number, epoch: number): Promise<void> {
    const random = new Uint8Array(32);
    crypto.getRandomValues(random);
    const junk = await createKeyMaterialFromBuffer(random.buffer);
    if (this.ended || this.slots.get(slot)?.epoch !== epoch || this.current === epoch) return;
    const info: KeyInfo = { key: junk, keyIndex: slot };
    this.slots.set(slot, { epoch: null, info });
    // Not `onSetEncryptionKey`: that would make this slot the one sealed with.
    this.emit(KeyProviderEvent.SetKey, info, false);
  }

  private later(task: () => Promise<void>): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.queued(task).catch(() => { /* the room keeps the key it had */ });
    }, this.previousKeyMs);
    this.timers.add(timer);
  }

  /** One key change at a time, in the order asked: the room's worker must see them in that order. */
  private queued(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }
}
