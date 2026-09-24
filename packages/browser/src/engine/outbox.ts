import type { StoredMessage } from "../shared/types";

/**
 * `queued`: sent at least once, not confirmed, and sent again by itself — under the same id — as soon as
 * the chat can carry it. `failed`: no longer retried by itself; only the Retry button sends it again.
 */
export type Delivery = "sending" | "sent" | "queued" | "held" | "delivered" | "failed";
export interface OutboxStore {
  read(): Promise<StoredMessage[]>;
  /** `extra` also changes the path the message takes and its resend deadline (`resendUntil: undefined` clears it). */
  update(id: string, delivery: Delivery, error?: string, extra?: Partial<Pick<StoredMessage, "via" | "resendUntil">>): Promise<void>;
}

/**
 * When an unconfirmed message is sent again by itself (docs/wisps/PAIRED-CHAT-INCREMENT.md, "Automatic resend").
 * A resend is only ever attempted while the chat can carry the message, so waiting for an away contact costs nothing:
 * the window bounds how long it waits, the attempts bound how often a live contact that never confirms is asked again.
 */
export const RESEND_POLICY = {
  /** From the moment it was first queued; a manual Retry starts a new one. The same week a held item lasts. */
  windowMs: 7 * 24 * 60 * 60_000,
  /** Between checks while queued; the last one repeats. The chat coming back live skips the wait. */
  backoffMs: [5_000, 15_000, 30_000, 60_000, 120_000, 300_000],
  /** Sends of one message (the first included) without a receipt before it stops by itself. */
  maxAttempts: 8,
  /** Queued this long with the contact away, it is handed to store-and-forward when the chat allows it. */
  holdAfterMs: 60_000,
};
export type ResendPolicy = typeof RESEND_POLICY;

export interface Resender {
  /** The chat can carry this message now: a live link, or the DHT text path with nothing else awaiting its receipt. */
  ready(message: StoredMessage): boolean;
  /** The path it would take now, recorded on the row so the receipt timeout and the bubble match it. */
  via?(message: StoredMessage): StoredMessage["via"];
  /** The contact is away and store-and-forward can take it: hands it over and says so. */
  divert?(message: StoredMessage): Promise<boolean>;
  /**
   * A DHT text that expired unconfirmed: queued for the live link (true), or final (false, a DHT-only chat,
   * where queuing it would publish it again every few minutes for as long as the contact is away).
   */
  requeueExpired?(message: StoredMessage): boolean;
}

/** Durable message IDs survive retries. A lost receipt means unknown delivery, never a claim that the peer did
 * not receive the message: the receiver acknowledges a duplicate id without showing it twice, so an unconfirmed
 * message is sent again by itself while the chat can carry it, within `RESEND_POLICY`, then waits for Retry. */
export class Outbox {
  /** Sent, awaiting a receipt. */
  private receipts = new Map<string, ReturnType<typeof setTimeout>>();
  /** Queued: when it is looked at again, how far along the backoff, since when. */
  private waiting = new Map<string, { timer?: ReturnType<typeof setTimeout>; step: number; since: number }>();
  private attempts = new Map<string, number>();
  private busy = new Set<string>();
  private stopped = false;
  private readonly resender: Resender;
  private readonly policy: ResendPolicy;
  private readonly now: () => number;
  constructor(private store: OutboxStore,
    private send: (message: StoredMessage) => Promise<string | null>,
    private timeoutMs: number | ((message: StoredMessage) => number) = 20_000,
    private pendingUntil?: (message: StoredMessage) => number | undefined,
    options: { resender?: Resender; policy?: Partial<ResendPolicy>; now?: () => number } = {}) {
    this.resender = options.resender ?? { ready: () => true };
    this.policy = { ...RESEND_POLICY, ...options.policy };
    this.now = options.now ?? Date.now;
  }

  async recover(): Promise<void> {
    for (const message of await this.store.read()) {
      // Held items have their own durable queue and are picked up by the store-and-forward engine.
      if (message.via === "hold" || message.sender !== "me") continue;
      if (message.delivery === "queued") { await this.queue(message, message.deliveryError ?? "Not confirmed yet."); continue; }
      if (message.delivery !== "sending" && message.delivery !== "sent") continue;
      const until = this.pendingUntil?.(message);
      if (until && until > this.now()) {
        await this.store.update(message.id, "sent");
        this.track(message.id, until - this.now());
      } else if (until !== undefined) await this.expired(message);
      else await this.queue(message, "Not confirmed before the app closed. It is sent again, under the same ID, once your contact is reachable.");
    }
  }

  /** Sends one message now. `manual`: the Retry button — a new window and a fresh count of attempts. */
  async transmit(id: string, { manual = false }: { manual?: boolean } = {}): Promise<void> {
    if (this.stopped || this.busy.has(id) || this.receipts.has(id)) return;
    this.busy.add(id);
    try {
      let message = (await this.store.read()).find(m => m.id === id);
      if (!message?.wireId || !message.delivery || message.delivery === "delivered") return;
      const wait = this.waiting.get(id);
      if (wait?.timer) { clearTimeout(wait.timer); wait.timer = undefined; }
      if (manual) { this.attempts.delete(id); this.waiting.delete(id); }
      this.attempts.set(id, (this.attempts.get(id) ?? 0) + 1);
      const via = this.resender.via?.(message) ?? message.via;
      await this.store.update(id, "sending", undefined, { via, ...(manual ? { resendUntil: undefined } : {}) });
      message = { ...message, via, ...(manual ? { resendUntil: undefined } : {}) };
      if (this.stopped) { await this.queue(message, "Connection closed. Delivery is unconfirmed."); return; }
      // Install before send: a fast receipt must be able to cancel it.
      this.track(id, typeof this.timeoutMs === "number" ? this.timeoutMs : this.timeoutMs(message));
      const error = await this.send(message);
      if (error) {
        this.clear(id);
        await this.requeue(id, error);
      } else if (this.receipts.has(id)) await this.store.update(id, "sent");
    } catch (error) {
      this.clear(id);
      await this.requeue(id, error instanceof Error ? error.message : "Sending failed");
    } finally { this.busy.delete(id); }
  }

  async received(wireId: string): Promise<void> {
    const id = `me_${wireId}`;
    await this.store.update(id, "delivered");
    this.clear(id);
    this.forget(id);
    // The DHT path carries one text at a time: the next one may go now.
    if (this.waiting.size) void this.flush().catch(() => {});
  }

  /**
   * The chat can carry text again (its link came back, or the DHT path freed up): every queued message goes now,
   * oldest first. `reopened`: a new link, so what still awaits a receipt from the old one, or from the DHT, goes on it too
   * (a receipt on the link also ends the DHT's own retries).
   */
  async flush({ reopened = false }: { reopened?: boolean } = {}): Promise<void> {
    if (this.stopped || (!reopened && !this.waiting.size)) return;
    const due = (await this.store.read())
      .filter(m => m.sender === "me" && m.via !== "hold" && (m.delivery === "queued" || (reopened && m.delivery === "sent" && this.receipts.has(m.id))))
      .sort((a, b) => a.timestamp - b.timestamp);
    for (const message of due) {
      if (message.delivery !== "sent") { await this.attempt(message.id); continue; }
      this.clear(message.id);
      if (this.resender.ready(message)) await this.transmit(message.id);
      else await this.requeue(message.id, "Connection closed before receipt. Delivery is unconfirmed.");
    }
  }

  async disconnected(): Promise<void> {
    const messages = await this.store.read();
    for (const id of [...this.receipts.keys()]) {
      if (messages.find(m => m.id === id)?.via === "pkarr") {
        if (this.stopped) this.clear(id);
        continue;
      }
      this.clear(id);
      await this.requeue(id, "Connection closed before receipt. Delivery is unconfirmed.");
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const wait of this.waiting.values()) if (wait.timer) clearTimeout(wait.timer);
    this.waiting.clear();
    await this.disconnected();
  }

  /** Looks at one queued message: sends it if the chat can carry it, hands it to store-and-forward, or waits more. */
  private async attempt(id: string): Promise<void> {
    if (this.stopped || this.busy.has(id)) return;
    const message = (await this.store.read()).find(m => m.id === id);
    if (!message || message.delivery !== "queued" || message.via === "hold") { this.forget(id); return; }
    if ((message.resendUntil ?? Infinity) <= this.now()) { await this.fail(id, `Not confirmed within ${days(this.policy.windowMs)}.`); return; }
    if (this.resender.ready(message)) { await this.transmit(id); return; }
    const wait = this.waiting.get(id);
    if (this.resender.divert && wait && this.now() - wait.since >= this.policy.holdAfterMs && await this.resender.divert(message)) { this.forget(id); return; }
    // A flush between two checks leaves the backoff where it was.
    if (!wait?.timer) this.schedule(id);
  }

  /** After a failed attempt: queued again, unless its window or its attempts are spent. */
  private async requeue(id: string, reason: string): Promise<void> {
    const message = (await this.store.read()).find(m => m.id === id);
    if (message && message.delivery !== "delivered") await this.queue(message, reason);
  }

  private async queue(message: StoredMessage, reason: string): Promise<void> {
    const now = this.now(), until = message.resendUntil ?? now + this.policy.windowMs;
    const sent = this.attempts.get(message.id) ?? 0;
    if (until <= now) return this.fail(message.id, `${reason} Not confirmed within ${days(this.policy.windowMs)}.`);
    if (sent >= this.policy.maxAttempts) return this.fail(message.id, `${reason} Sent ${sent} times without a receipt.`);
    await this.store.update(message.id, "queued", reason, { resendUntil: until });
    if (!this.stopped) this.schedule(message.id);
  }

  /** The DHT path retried within its own budget until expiry: only the live link may take it from here. */
  private async expired(message: StoredMessage): Promise<void> {
    const reason = "No DHT receipt before it expired.";
    if (this.resender.requeueExpired?.(message)) await this.queue(message, `${reason} It goes again when the chat is live.`);
    else await this.fail(message.id, reason);
  }

  private async fail(id: string, reason: string): Promise<void> {
    this.forget(id);
    await this.store.update(id, "failed", `${reason} Your contact may have received it; Retry uses the same message ID, so it is never shown twice.`);
  }

  private schedule(id: string): void {
    const wait = this.waiting.get(id) ?? { step: 0, since: this.now() };
    if (wait.timer) clearTimeout(wait.timer);
    const delay = this.policy.backoffMs[Math.min(wait.step, this.policy.backoffMs.length - 1)];
    wait.timer = setTimeout(() => { wait.timer = undefined; wait.step++; void this.attempt(id).catch(() => {}); }, delay);
    this.waiting.set(id, wait);
  }

  private forget(id: string): void {
    const wait = this.waiting.get(id);
    if (wait?.timer) clearTimeout(wait.timer);
    this.waiting.delete(id);
    this.attempts.delete(id);
  }

  private track(id: string, duration: number): void {
    this.clear(id);
    this.receipts.set(id, setTimeout(() => {
      this.receipts.delete(id);
      void (async () => {
        const message = (await this.store.read()).find(m => m.id === id);
        if (message?.via === "pkarr") await this.expired(message);
        else await this.requeue(id, "No receipt received yet.");
      })().catch(() => {});
    }, duration));
  }
  private clear(id: string): void { const timer = this.receipts.get(id); if (timer) clearTimeout(timer); this.receipts.delete(id); }
}

const days = (ms: number) => { const d = Math.round(ms / 86_400_000); return d >= 1 ? `${d} day${d === 1 ? "" : "s"}` : `${Math.round(ms / 60_000)} minutes`; };
