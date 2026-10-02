import type { StoredMessage } from "../shared/types";

/**
 * `queued`: sent at least once, not confirmed, and sent again by itself — under the same id — as soon as
 * the chat can carry it. `failed`: no longer retried by itself; only the Retry button sends it again.
 */
export type Delivery = "sending" | "sent" | "queued" | "waiting" | "held" | "delivered" | "failed";
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
  /**
   * Sends a file (a voice note is one) that waits for the live link. It has its own sender, and goes in its place
   * among the texts that wait: this returns once it is said on the link (its offer, never its bytes), so a text
   * written after it goes after its bubble and does not wait for the transfer. `ready` says whether it can go.
   */
  sendFile?(message: StoredMessage): Promise<void>;
}

/** How long one turn of an outbox may hold the next one back: a send that never returns must not stop the chat. */
const TURN_MS = 30_000;

/**
 * A text of mine, not handed to store-and-forward, and still to go: queued, or waiting for the chat to carry it. (A
 * file or a payment request that waits for the live session has no wire id, and its own sender.)
 */
const toGo = (m: StoredMessage) => m.sender === "me" && m.via !== "hold" && !!m.wireId && (m.delivery === "queued" || m.delivery === "waiting");
/** A file of mine that waits for the live link (its row has no wire id: the transfer has its own). */
const waitingFile = (m: StoredMessage) => m.sender === "me" && m.via !== "hold" && !m.wireId && !!m.file && m.delivery === "waiting";
const oldestFirst = (a: StoredMessage, b: StoredMessage) => a.timestamp - b.timestamp;

/** Durable message IDs survive retries. A lost receipt means unknown delivery, never a claim that the peer did
 * not receive the message: the receiver acknowledges a duplicate id without showing it twice, so an unconfirmed
 * message is sent again by itself while the chat can carry it, within `RESEND_POLICY`, then waits for Retry.
 *
 * What a chat's outbox hands its link goes oldest first. The contact's app places each message where it arrives
 * (WISP 400, requirement 10), so the order they are sent in is the order the contact reads them in, for good. A new
 * message, a link that came back, a receipt that freed the DHT path and each queued message's own timer all send, and
 * each of them took its turn while another was still between two steps: a message written later went out before one
 * written earlier, and the contact kept them that way. They now take turns (`turn`), and each turn sends what is
 * older first. Only a message the chat cannot carry (a long text while on the DHT) is passed by a later one.
 *
 * A link that closes takes its turn too (`disconnected`), and so does a receipt that never came. Both make a sent
 * message queued again, and both did it beside a look in progress: a link that dropped with a hundred texts
 * unconfirmed and came back within a second was looked at while half of them were between sent and queued, the look
 * passed those by and sent the later ones first. A look in progress when the link closes stops there: what it sent
 * on the old link may be lost, and the ones after them must not go on the new link before them. */
export class Outbox {
  /** Sent, awaiting a receipt. */
  private receipts = new Map<string, ReturnType<typeof setTimeout>>();
  /** Queued: when it is looked at again, how far along the backoff, since when. */
  private waiting = new Map<string, { timer?: ReturnType<typeof setTimeout>; step: number; since: number }>();
  private attempts = new Map<string, number>();
  private busy = new Set<string>();
  /** Still in flight when the look a reopened chat asked for began (`flush({ reopened })`): sent again once that send returns. */
  private reopenedWhileBusy = new Set<string>();
  /** The turns taken so far, one after the other (`turn`). */
  private line: Promise<void> = Promise.resolve();
  /** How many times the chat reopened, and the count each message last went out under: one sent since is on the new link. */
  private opened = 0;
  private sentUnder = new Map<string, number>();
  /** How many times the link closed with something unconfirmed on it, and the count when the turn in progress began. */
  private closed = 0;
  private began = 0;
  /** The link closed and what was unconfirmed on it is not queued again yet: the next turn does it first. */
  private dropped = false;
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
      if (message.delivery === "waiting") { this.schedule(message.id); continue; }
      if (message.delivery !== "sending" && message.delivery !== "sent") continue;
      const until = this.pendingUntil?.(message);
      if (until && until > this.now()) {
        await this.store.update(message.id, "sent");
        this.track(message.id, until - this.now());
      } else if (until !== undefined) await this.expired(message);
      else await this.queue(message, "Not confirmed before the app closed. It is sent again, under the same ID, once your contact is reachable.");
    }
  }

  /**
   * One at a time, in the order asked: `run` starts when the turns before it are over. A turn that takes longer than
   * `TURN_MS` no longer holds the next one back.
   */
  private turn<T>(run: () => Promise<T>): Promise<T> {
    const result = this.line.then(async () => {
      // A link that closed since: what was unconfirmed on it is queued again before anything else goes.
      if (this.dropped) { this.dropped = false; await this.requeueUnconfirmed(); }
      this.began = this.closed;
      return run();
    });
    this.line = new Promise<void>(next => {
      const timer = setTimeout(next, TURN_MS);
      void result.then(() => {}, () => {}).then(() => { clearTimeout(timer); next(); });
    });
    return result;
  }

  /** The link has not closed since this turn began: what the turn sends goes on the link the turn looked at. */
  private get sameLink(): boolean { return !this.stopped && this.closed === this.began; }

  /** A new message a turn could not send (the link closed under it, or the ones before it still wait): it waits too. */
  private async waitsItsTurn(message: StoredMessage): Promise<void> {
    await this.store.update(message.id, "waiting", "Waits for the messages before it to go.", { via: "datalink", resendUntil: message.resendUntil ?? this.now() + this.policy.windowMs });
    this.schedule(message.id);
  }

  /**
   * Sends one message. A new one goes after the ones written before it that still wait to go: those the chat can
   * carry go first, and if it then cannot carry this one (the DHT path took one of them), it waits its turn too.
   * `manual`: the Retry button — it goes now, with a new window and a fresh count of attempts.
   */
  transmit(id: string, { manual = false }: { manual?: boolean } = {}): Promise<void> {
    return this.turn(async () => {
      if (manual || this.stopped || this.busy.has(id) || this.receipts.has(id)) return this.transmitNow(id, { manual });
      const messages = await this.store.read(), message = messages.find(m => m.id === id);
      // Nothing before it waits (the usual case): it goes as it was read, with no second look at the store.
      const before = message?.delivery === "sending" ? this.before(messages, message) : [];
      if (!before.length) return this.transmitNow(id, {}, message);
      const passed = await this.inOrder(before);
      if (this.stopped) return;
      if (this.sameLink && this.resender.ready({ ...message!, via: "datalink" })) {
        await this.catchUp(passed);
        if (this.sameLink) return this.transmitNow(id);
      }
      if (this.stopped) return;
      await this.waitsItsTurn(message!);
    });
  }

  /** The messages written before a new one that have not gone yet, oldest first. */
  private before(messages: StoredMessage[], message: StoredMessage): StoredMessage[] {
    // Stored and about to go: its own turn comes after this one.
    const stored = (m: StoredMessage) => m.sender === "me" && m.via !== "hold" && m.delivery === "sending" && !!m.wireId && m.timestamp < message.timestamp && !this.receipts.has(m.id) && !this.busy.has(m.id);
    return [...this.due(messages.filter(m => m.id !== message.id && m.timestamp <= message.timestamp)), ...messages.filter(stored)].sort(oldestFirst);
  }

  /**
   * What a look at the chat takes up, oldest first: what is queued or waiting, and what was sent and still awaits its
   * receipt when the path it took is not the one the chat has now (it went on the DHT and the chat is live: it goes on
   * the link, before what was written after it) or when the chat reopened since (`opened`).
   */
  private due(messages: StoredMessage[], opened?: number): StoredMessage[] {
    const unconfirmed = (m: StoredMessage) => m.sender === "me" && m.via !== "hold" && m.delivery === "sent" && this.receipts.has(m.id);
    return messages.filter(m => !this.busy.has(m.id) && (toGo(m) || this.file(m) || (unconfirmed(m)
      && ((opened !== undefined && (this.sentUnder.get(m.id) ?? 0) < opened) || (!!this.resender.via && this.resender.via(m) !== m.via && this.resender.ready(m)))))).sort(oldestFirst);
  }

  /**
   * Looks at each message, oldest first: it goes if the chat can carry it. The ones the chat could not carry are
   * handed back, and asked once more at the moment a later one is found able to go (`catchUp`): a link says it is open
   * a moment before it carries text, and a look that began in that moment sent the later messages and left the first
   * ones behind.
   */
  private file(message: StoredMessage): boolean { return !!this.resender.sendFile && waitingFile(message); }

  /** A waiting file is said on the link, after the older messages passed by that can go now. False: the link cannot carry it. */
  private async fileGoes(message: StoredMessage, passed?: StoredMessage[]): Promise<boolean> {
    // Not yet: it is looked at again as a queued text is, so a file alone in the chat does not wait for the next link.
    if (!this.resender.ready(message)) { if (!this.waiting.get(message.id)?.timer) this.schedule(message.id); return false; }
    if (passed) await this.catchUp(passed);
    if (!this.sameLink) return true;
    await this.resender.sendFile!(message).catch(() => {});
    this.forget(message.id);
    return true;
  }

  private async inOrder(messages: StoredMessage[]): Promise<StoredMessage[]> {
    const passed: StoredMessage[] = [];
    for (const message of messages) {
      // The link closed under this look: the rest stays, and the look the next link asks for starts from the oldest.
      if (!this.sameLink) break;
      if (message.delivery === "sending") {
        await this.catchUp(passed);
        if (this.sameLink) await this.transmitNow(message.id); else if (!this.stopped) await this.waitsItsTurn(message);
        continue;
      }
      if (!(await (this.file(message) ? this.fileGoes(message, passed) : this.again(message, passed)))) passed.push(message);
    }
    return passed;
  }

  /** The messages passed by that the chat can carry by now go, oldest first; the others stay where they are. */
  private async catchUp(passed: StoredMessage[]): Promise<void> {
    for (let i = 0; i < passed.length && this.sameLink;) {
      if (!this.resender.ready(passed[i])) { i++; continue; }
      const [older] = passed.splice(i, 1);
      if (this.file(older)) await this.fileGoes(older); else await this.attempt(older.id);
      // Something was awaited: the ones before it are asked again.
      i = 0;
    }
  }

  /** `read`: the message's row, when it was read just now with nothing awaited since. */
  private async transmitNow(id: string, { manual = false }: { manual?: boolean } = {}, read?: StoredMessage): Promise<void> {
    if (this.stopped || this.busy.has(id) || this.receipts.has(id)) return;
    this.busy.add(id);
    let again: boolean;
    try {
      let message = read ?? (await this.store.read()).find(m => m.id === id);
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
      this.sentUnder.set(id, this.opened);
      const error = await this.send(message);
      if (error) {
        this.clear(id);
        await this.requeue(id, error);
      } else if (this.receipts.has(id)) await this.store.update(id, "sent");
    } catch (error) {
      this.clear(id);
      await this.requeue(id, error instanceof Error ? error.message : "Sending failed");
    } finally { this.busy.delete(id); again = this.reopenedWhileBusy.delete(id); }
    // The chat went live while this send was on its way (on the DHT, or on a link that just closed): a reader that
    // is live now may not look at the DHT for minutes, so it goes again on the new link, under the same id.
    if (again) {
      const message = (await this.store.read()).find(m => m.id === id);
      if (message) await this.again(message);
    }
  }

  /**
   * A message the chat cannot carry yet (a second DHT text while one awaits its receipt, a long text on the
   * DHT): kept as `waiting`, and sent by itself, in order, once the chat can carry it. Never sent before, so
   * nothing about it is unconfirmed; it counts no attempt until it goes.
   */
  async wait(id: string, reason: string): Promise<void> {
    const message = (await this.store.read()).find(m => m.id === id);
    if (!message || this.stopped) return;
    await this.store.update(id, "waiting", reason, { resendUntil: message.resendUntil ?? this.now() + this.policy.windowMs });
    this.schedule(id);
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
  flush({ reopened = false }: { reopened?: boolean } = {}): Promise<void> {
    if (this.stopped || (!reopened && !this.waiting.size)) return Promise.resolve();
    // What goes out from here on goes on the new link: a second look at the chat (the link says it is open in two
    // ways, a receipt comes) does not send it once more.
    const opened = reopened ? ++this.opened : undefined;
    return this.turn(async () => {
      if (this.stopped) return;
      // A send still on its way goes again in this look, in its place: the look waits its turn behind it. One that
      // outlived its turn (`TURN_MS`) is not `sent` yet and this look passes it by: it goes again once it returns.
      if (reopened) for (const id of this.busy) this.reopenedWhileBusy.add(id);
      await this.inOrder(this.due(await this.store.read(), opened));
    });
  }

  /** A queued message's check came due: the ones written before it that have not gone are looked at first. */
  private async check(id: string): Promise<void> {
    if (this.stopped) return;
    const messages = await this.store.read(), message = messages.find(m => m.id === id);
    if (!message || !(toGo(message) || this.file(message))) { await this.attempt(id); return; }
    await this.inOrder(this.due(messages.filter(m => m.timestamp <= message.timestamp)));
  }

  /**
   * A queued or waiting message is looked at; one sent and awaiting its receipt goes again now, if the chat can carry
   * it. False when the chat could not carry it.
   */
  private async again(message: StoredMessage, passed?: StoredMessage[]): Promise<boolean> {
    if (message.sender !== "me" || message.via === "hold") return true;
    if (message.delivery === "queued" || message.delivery === "waiting") return this.attempt(message.id, passed);
    if (message.delivery !== "sent" || !this.receipts.has(message.id)) return true;
    this.clear(message.id);
    if (this.resender.ready(message)) { if (passed) await this.catchUp(passed); await this.transmitNow(message.id); return true; }
    await this.requeue(message.id, "Connection closed before receipt. Delivery is unconfirmed.");
    return false;
  }

  /**
   * The link closed: what awaits a receipt from it is queued again, in a turn of its own, so a look at the chat never
   * finds a message between sent and queued. A look in progress stops (`sameLink`).
   */
  disconnected(): Promise<void> {
    if (!this.receipts.size) return Promise.resolve();
    this.closed++;
    this.dropped = true;
    // The next turn does it as it begins, whichever comes first; this one makes sure there is one.
    return this.turn(async () => {});
  }

  private async requeueUnconfirmed(): Promise<void> {
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
    this.reopenedWhileBusy.clear();
    for (const wait of this.waiting.values()) if (wait.timer) clearTimeout(wait.timer);
    this.waiting.clear();
    this.dropped = false;
    await this.requeueUnconfirmed();
  }

  /**
   * Looks at one queued message: sends it if the chat can carry it, hands it to store-and-forward, or waits more.
   * False when the chat could not carry it and it still waits. `passed`: older messages the chat could not carry a
   * moment ago, which go first if it can now.
   */
  private async attempt(id: string, passed?: StoredMessage[]): Promise<boolean> {
    if (this.stopped || this.busy.has(id)) return true;
    const message = (await this.store.read()).find(m => m.id === id);
    if (!message || (message.delivery !== "queued" && message.delivery !== "waiting") || message.via === "hold") { this.forget(id); return true; }
    if ((message.resendUntil ?? Infinity) <= this.now()) {
      if (message.delivery === "waiting") { this.forget(id); await this.store.update(id, "failed", `Your contact was not reachable within ${days(this.policy.windowMs)}. It was not sent; Retry sends it.`); }
      else await this.fail(id, `Not confirmed within ${days(this.policy.windowMs)}.`);
      return true;
    }
    if (this.resender.ready(message)) { if (passed) await this.catchUp(passed); await this.transmitNow(id); return true; }
    const wait = this.waiting.get(id);
    if (this.resender.divert && wait && this.now() - wait.since >= this.policy.holdAfterMs && await this.resender.divert(message)) { this.forget(id); return true; }
    // A flush between two checks leaves the backoff where it was.
    if (!wait?.timer) this.schedule(id);
    return false;
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
    wait.timer = setTimeout(() => { wait.timer = undefined; wait.step++; void this.turn(() => this.check(id)).catch(() => {}); }, delay);
    this.waiting.set(id, wait);
  }

  private forget(id: string): void {
    const wait = this.waiting.get(id);
    if (wait?.timer) clearTimeout(wait.timer);
    this.waiting.delete(id);
    this.attempts.delete(id);
    this.sentUnder.delete(id);
  }

  private track(id: string, duration: number): void {
    this.clear(id);
    const timer = setTimeout(() => {
      // In a turn, and awaiting its receipt until then: a look in progress sends it again in its place, where it
      // used to find it neither awaiting a receipt nor queued, pass it by and send the later ones first.
      void this.turn(async () => {
        if (this.receipts.get(id) !== timer) return;
        this.receipts.delete(id);
        const message = (await this.store.read()).find(m => m.id === id);
        if (message?.via === "pkarr") await this.expired(message);
        else await this.requeue(id, "No receipt received yet.");
      }).catch(() => {});
    }, duration);
    this.receipts.set(id, timer);
  }
  private clear(id: string): void { const timer = this.receipts.get(id); if (timer) clearTimeout(timer); this.receipts.delete(id); }
}

const days = (ms: number) => { const d = Math.round(ms / 86_400_000); return d >= 1 ? `${d} day${d === 1 ? "" : "s"}` : `${Math.round(ms / 60_000)} minutes`; };
