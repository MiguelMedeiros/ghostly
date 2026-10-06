/**
 * A stand-in for the client's broker, with the WISP's rules: storage per app and per chat with its limits, and
 * `chat.send` only while both sides have the app open, delivered in order and asynchronously, as a copy.
 */
import { MINI_APP_LIMITS, type MiniAppApi, type MiniAppContext, type MiniAppJson, type MiniAppPeerEvent } from "@ghostly/core/miniApp";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

export class MockBroker implements MiniAppApi {
  /** The app's storage in this chat: survives a close and a reopen, as the client's does. */
  readonly stored = new Map<string, string>();
  /** Every value this side sent, as sent. */
  readonly sent: MiniAppJson[] = [];
  peer: MockBroker | null = null;
  isOpen = false;
  /** Frames on their way to this side. */
  inFlight = 0;
  private messageListeners = new Set<(data: MiniAppJson) => void>();
  private peerListeners = new Set<(peer: MiniAppPeerEvent) => void>();
  private incoming: Promise<void> = Promise.resolve();

  constructor(
    readonly name: string,
    readonly version = "1.0.0",
    readonly inChat = true,
  ) {}

  async context(): Promise<MiniAppContext> {
    return { version: this.version, inChat: this.inChat, peer: this.peer?.isOpen ? { version: this.peer.version } : null };
  }

  async file(): Promise<ArrayBuffer> {
    throw new Error("no such file");
  }

  storage = {
    get: async (key: string): Promise<MiniAppJson | undefined> => {
      const text = this.stored.get(key);
      return text === undefined ? undefined : (JSON.parse(text) as MiniAppJson);
    },
    set: async (key: string, value: MiniAppJson): Promise<void> => {
      if (new TextEncoder().encode(key).length > MINI_APP_LIMITS.storageKeyBytes) throw new Error("key too long");
      const text = JSON.stringify(value);
      if (bytes(value) > MINI_APP_LIMITS.storageValueBytes) throw new Error("value too big");
      const total = [...this.stored].reduce((n, [k, v]) => (k === key ? n : n + k.length + v.length), key.length + text.length);
      if (total > MINI_APP_LIMITS.storageScopeBytes) throw new Error("storage full");
      this.stored.set(key, text);
    },
    delete: async (key: string): Promise<void> => {
      this.stored.delete(key);
    },
    keys: async (): Promise<string[]> => [...this.stored.keys()],
  };

  chat = {
    send: async (value: MiniAppJson): Promise<void> => {
      const peer = this.peer;
      if (!this.isOpen || !peer?.isOpen) throw new Error("the peer does not have the app open");
      if (bytes(value) > MINI_APP_LIMITS.chatDataBytes) throw new Error("frame too big");
      this.sent.push(value);
      peer.deliver(JSON.parse(JSON.stringify(value)) as MiniAppJson);
    },
    on: ((event: "message" | "peer", listener: (data: never) => void) => {
      const set = (event === "message" ? this.messageListeners : this.peerListeners) as Set<(data: never) => void>;
      set.add(listener);
      return () => set.delete(listener);
    }) as MiniAppApi["chat"]["on"],
  };

  async close(): Promise<void> {
    this.shutdown();
  }

  /** The person opens the app in this chat. */
  launch(): void {
    this.isOpen = true;
    this.peer?.emitPeer({ open: true, version: this.version });
  }

  /** The app closes (or the page reloads): its listeners go, frames still on their way to it are lost. */
  shutdown(): void {
    this.isOpen = false;
    this.messageListeners.clear();
    this.peerListeners.clear();
    this.peer?.emitPeer({ open: false });
  }

  /** A frame from the peer's side, as the broker would hand it over: for injecting what a hostile peer sends. */
  inject(value: unknown): void {
    this.deliver(value as MiniAppJson);
  }

  private deliver(value: MiniAppJson): void {
    this.inFlight++;
    this.incoming = this.incoming.then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      this.inFlight--;
      if (!this.isOpen) return;
      for (const listener of [...this.messageListeners]) listener(value);
    });
  }

  private emitPeer(event: MiniAppPeerEvent): void {
    this.inFlight++;
    this.incoming = this.incoming.then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      this.inFlight--;
      if (!this.isOpen) return;
      for (const listener of [...this.peerListeners]) listener(event);
    });
  }
}

/** Two sides of one chat. */
export function chatPair(): [MockBroker, MockBroker] {
  const a = new MockBroker("ana");
  const b = new MockBroker("bob");
  a.peer = b;
  b.peer = a;
  return [a, b];
}
