import type { StoredMessage } from "../shared/types";

export type Delivery = "sending" | "sent" | "held" | "delivered" | "failed";
export interface OutboxStore {
  read(): Promise<StoredMessage[]>;
  update(id: string, delivery: Delivery, error?: string): Promise<void>;
}

/** Durable message IDs survive retries. A lost receipt means unknown delivery,
 * never a claim that the peer did not receive the message. Retries are explicit. */
export class Outbox {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private busy = new Set<string>();
  private stopped = false;
  constructor(private store: OutboxStore,
    private send: (message: StoredMessage) => Promise<string | null>,
    private timeoutMs: number | ((message: StoredMessage) => number) = 20_000,
    private pendingUntil?: (message: StoredMessage) => number | undefined) {}

  async recover(): Promise<void> {
    for (const message of await this.store.read()) {
      // Held items have their own durable queue and are picked up by the store-and-forward engine.
      if (message.via === "hold" || (message.delivery !== "sending" && message.delivery !== "sent")) continue;
      const until = this.pendingUntil?.(message);
      if (until && until > Date.now()) {
        await this.store.update(message.id, "sent");
        this.track(message.id, until - Date.now());
      } else await this.store.update(message.id, "failed", "Delivery was not confirmed before restart. Retry uses the same message ID.");
    }
  }

  async transmit(id: string): Promise<void> {
    if (this.stopped || this.busy.has(id) || this.timers.has(id)) return;
    this.busy.add(id);
    try {
      const message = (await this.store.read()).find(m => m.id === id);
      if (!message?.wireId || !message.delivery || message.delivery === "delivered") return;
      await this.store.update(id, "sending");
      if (this.stopped) { await this.store.update(id, "failed", "Connection closed. Delivery is unconfirmed."); return; }
      // Install before send: a fast receipt must be able to cancel it.
      this.track(id, typeof this.timeoutMs === "number" ? this.timeoutMs : this.timeoutMs(message));
      const error = await this.send(message);
      if (error) {
        this.clear(id);
        await this.store.update(id, "failed", error);
      } else if (this.timers.has(id)) await this.store.update(id, "sent");
    } catch (error) {
      this.clear(id);
      await this.store.update(id, "failed", error instanceof Error ? error.message : "Sending failed");
    } finally { this.busy.delete(id); }
  }

  async received(wireId: string): Promise<void> {
    const id = `me_${wireId}`;
    await this.store.update(id, "delivered");
    this.clear(id);
  }

  async disconnected(): Promise<void> {
    const messages = await this.store.read();
    for (const id of this.timers.keys()) {
      if (messages.find(m => m.id === id)?.via === "pkarr") {
        if (this.stopped) this.clear(id);
        continue;
      }
      this.clear(id);
      await this.store.update(id, "failed", "Connection closed before receipt. Delivery is unconfirmed; you can retry.");
    }
  }
  async stop(): Promise<void> { this.stopped = true; await this.disconnected(); }
  private track(id: string, duration: number): void {
    this.clear(id);
    this.timers.set(id, setTimeout(() => {
      this.timers.delete(id);
      void this.store.update(id, "failed", "No receipt received. The peer may have received this message; retry safely uses the same ID.").catch(() => {});
    }, duration));
  }
  private clear(id: string): void { const timer = this.timers.get(id); if (timer) clearTimeout(timer); this.timers.delete(id); }
}
