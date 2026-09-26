import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { EngineClientSink } from "@ghostly/browser/engine/server";
import type { EngineEvent, RpcResponse } from "@ghostly/browser/shared/rpc";
import type { EngineState, GroupView, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { chatJson, groupJson, messageJson } from "./views";
import { paymentJson } from "./wallets";

/**
 * The event stream (WISP 11xx § Event stream): what happened, derived from the engine's own events, one JSON object
 * each, with a `seq` that grows across restarts and an `id` stable for the fact it reports.
 */
export interface GhostlyEvent { seq: number; id: string; type: string; at: number; [field: string]: unknown }

/** Events the journal keeps for `listen --since`. */
export const JOURNAL_KEEP = 10_000;
const SEEN_DB = "ghostly-cli";
const SEEN = "seen";

/** The notice an app sends when a chat first goes live (src/hooks/useChat.ts): shown as a line, not a message. */
export const JOIN_NOTICE = /^👋 (?:(.+) )?joined$/;

type Listener = (event: GhostlyEvent) => void;
type Seen = Map<string, Map<string, string>>;

interface ChatShape { stage: string | null; live: boolean; transport: string | null; name: string | null }
interface GroupShape { status: string | null; members: string[] }

/**
 * Turns the engine's events into the stream, keeps the journal, and remembers which messages it already reported
 * (a store of its own in the profile's IndexedDB): after a restart, only what is new is reported, and a first
 * start reports nothing of the history that was already there.
 */
export class EventHub {
  private seq = 0;
  private journalLines = 0;
  private readonly listeners = new Set<Listener>();
  private readonly stateListeners = new Set<(state: EngineState) => void>();
  private seen: Seen = new Map();
  private firstRun = false;
  private chats = new Map<string, ChatShape>();
  private groups = new Map<string, GroupShape>();
  private payments = new Map<string, string>();
  private transfers = new Map<string, string>();
  private baselined = false;
  private db!: IDBDatabase;
  state: EngineState | null = null;

  /** `seenDb`: the IndexedDB database of the seen set (tests give each hub its own). */
  constructor(private readonly journalPath: string, private readonly now: () => number = Date.now, private readonly seenDb = SEEN_DB) {}

  /** Loads the journal's last seq and the seen set; call before `sink` is attached. */
  async open(): Promise<void> {
    if (existsSync(this.journalPath)) {
      const lines = readFileSync(this.journalPath, "utf8").split("\n").filter(Boolean);
      this.journalLines = lines.length;
      for (let i = lines.length - 1; i >= 0; i--) {
        try { this.seq = (JSON.parse(lines[i]) as GhostlyEvent).seq; break; } catch { /* a torn last line */ }
      }
    }
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.seenDb, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore(SEEN); this.firstRun = true; };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<{ key: IDBValidKey; value: string }[]>((resolve, reject) => {
      const out: { key: IDBValidKey; value: string }[] = [];
      const request = this.db.transaction(SEEN).objectStore(SEEN).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(out);
        out.push({ key: cursor.key, value: cursor.value as string });
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
    for (const { key, value } of rows) {
      const [chat, id] = key as [string, string];
      this.seenOf(chat).set(id, value);
    }
  }

  /** The sink the engine server posts to. */
  readonly sink: EngineClientSink = {
    post: (message: EngineEvent | RpcResponse) => {
      try { this.handle(message); } catch (error) { process.stderr.write(`ghostly: event error: ${error instanceof Error ? error.stack : String(error)}\n`); }
    },
  };

  /**
   * The engine as it is at start, before the sink is attached: chats and groups are known without events; messages
   * missing from the seen set are news (they came while no process derived events, a crash), except on a first
   * run, which only learns the history that was already there.
   */
  baseline(state: EngineState, histories: Map<string, readonly StoredMessage[]>): void {
    this.stateChanged(state);
    for (const [chat, messages] of histories) this.messages(chat, messages);
    this.baselined = true;
    this.firstRun = false;
  }

  onEvent(listener: Listener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onState(listener: (state: EngineState) => void): () => void { this.stateListeners.add(listener); return () => this.stateListeners.delete(listener); }

  /** Events after `since` still in the journal; a gap event first when older ones were dropped. */
  replay(since: number): GhostlyEvent[] {
    if (!existsSync(this.journalPath) || since >= this.seq) return [];
    const out: GhostlyEvent[] = [];
    for (const line of readFileSync(this.journalPath, "utf8").split("\n")) {
      if (!line) continue;
      try { const event = JSON.parse(line) as GhostlyEvent; if (event.seq > since) out.push(event); } catch { /* torn */ }
    }
    if (out.length && out[0].seq > since + 1) out.unshift({ seq: since, id: `events.gap:${since}:${out[0].seq}`, type: "events.gap", at: this.now(), from: since + 1, to: out[0].seq - 1 });
    return out;
  }

  get lastSeq(): number { return this.seq; }

  /** Emits an event the host makes itself (`daemon.started`). */
  emit(type: string, id: string, fields: Record<string, unknown> = {}): GhostlyEvent {
    const event: GhostlyEvent = { seq: ++this.seq, id, type, at: this.now(), ...fields };
    appendFileSync(this.journalPath, JSON.stringify(event) + "\n", { mode: 0o600 });
    if (++this.journalLines > JOURNAL_KEEP * 2) this.trimJournal();
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* one listener's failure is its own */ }
    }
    return event;
  }

  private trimJournal(): void {
    const lines = readFileSync(this.journalPath, "utf8").split("\n").filter(Boolean).slice(-JOURNAL_KEEP);
    writeFileSync(this.journalPath + ".tmp", lines.join("\n") + "\n", { mode: 0o600 });
    renameSync(this.journalPath + ".tmp", this.journalPath);
    this.journalLines = lines.length;
  }

  private handle(message: EngineEvent | RpcResponse): void {
    switch (message.kind) {
      case "state": this.stateChanged(message.state); break;
      case "messages": this.messages(message.linkId, message.messages); break;
      case "call-signal": {
        let kind: unknown;
        try { kind = (JSON.parse(message.signal) as { t?: unknown }).t; } catch { kind = undefined; }
        // A headless Ghostly has no camera or microphone: it only says a call came (WISP 11xx § Parity).
        if (kind === "o") this.emit("call.offer", `call.offer:${message.linkId}:${this.now()}`, { chat: message.linkId });
        break;
      }
      default: break;
    }
  }

  private stateChanged(state: EngineState): void {
    const quiet = !this.baselined;
    const links = new Map(state.links.map((link) => [link.id, link]));
    for (const [id, link] of links) {
      const shape = chatShape(link), before = this.chats.get(id);
      this.chats.set(id, shape);
      if (quiet) continue;
      if (!before) { this.emit("chat.created", `chat.created:${id}`, { chat: id, summary: chatJson(link) }); continue; }
      if (shape.stage && shape.stage !== before.stage) {
        const progress = link.pairingProgress;
        this.emit("chat.pairing", `chat.pairing:${id}:${shape.stage}:${progress?.since ?? this.now()}`, {
          chat: id, stage: shape.stage, ...(progress?.detail ? { detail: progress.detail } : {}), ...(progress?.reason ? { reason: progress.reason } : {}), ...(progress?.peerSeen ? { peerSeen: true } : {}),
        });
      }
      if (shape.live !== before.live || shape.transport !== before.transport) {
        const at = this.now();
        this.emit("chat.connection", `chat.connection:${id}:${shape.live ? shape.transport : "down"}:${at}`, { chat: id, live: shape.live, transport: shape.transport, text: link.textDelivery ?? null });
      }
      if (shape.name !== before.name) this.emit("chat.renamed", `chat.renamed:${id}:${this.now()}`, { chat: id, name: shape.name });
    }
    for (const id of [...this.chats.keys()]) {
      if (links.has(id)) continue;
      this.chats.delete(id);
      if (!quiet) this.emit("chat.removed", `chat.removed:${id}`, { chat: id });
    }
    const groups = new Map(state.groups.map((group) => [group.id, group]));
    for (const [id, group] of groups) {
      const shape = groupShape(group), before = this.groups.get(id);
      this.groups.set(id, shape);
      if (quiet) continue;
      if (!before) { this.emit("group.created", `group.created:${id}`, { group: id, summary: groupJson(group) }); continue; }
      if (shape.status !== before.status) this.emit("group.status", `group.status:${id}:${shape.status}:${this.now()}`, { group: id, status: shape.status });
      const joined = shape.members.filter((key) => !before.members.includes(key));
      const left = before.members.filter((key) => !shape.members.includes(key));
      if (joined.length || left.length) this.emit("group.members", `group.members:${id}:${this.now()}`, { group: id, joined, left });
    }
    for (const id of [...this.groups.keys()]) {
      if (groups.has(id)) continue;
      this.groups.delete(id);
      if (!quiet) this.emit("group.removed", `group.removed:${id}`, { group: id });
    }
    for (const [id, payment] of Object.entries(state.payments ?? {})) {
      const shape = `${payment.state}|${payment.error ?? ""}|${payment.closed ? 1 : 0}`, before = this.payments.get(id);
      this.payments.set(id, shape);
      if (quiet || before === shape) continue;
      const json = paymentJson(payment);
      if (before === undefined) this.emit("payment.created", `payment.created:${id}`, { chat: payment.linkId, payment: json });
      else this.emit("payment.updated", `payment.updated:${id}:${payment.state}:${this.now()}`, { chat: payment.linkId, payment: json });
    }
    for (const [id, transfer] of Object.entries(state.transfers ?? {})) {
      const shape = `${transfer.state}|${transfer.stage ?? ""}`, before = this.transfers.get(id);
      this.transfers.set(id, shape);
      if (quiet || before === shape) continue;
      const chat = state.links.find((l) => id.startsWith(`${l.id}-`))?.id ?? null;
      const fields = { chat, file: id, direction: transfer.direction ?? (id.includes("-in-") ? "in" : "out"), size: transfer.size, transferred: transfer.transferred, ...(transfer.error ? { error: transfer.error } : {}) };
      if (transfer.state === "done") this.emit("file.done", `file.done:${id}`, fields);
      else if (transfer.state === "failed") this.emit("file.failed", `file.failed:${id}:${this.now()}`, { ...fields, retry: !!transfer.retry });
      else if (transfer.stage === "asking" && fields.direction === "in") this.emit("file.offered", `file.offered:${id}:${this.now()}`, { ...fields, room: transfer.room ?? null });
      else if (transfer.stage) this.emit("file.stage", `file.stage:${id}:${transfer.stage}:${this.now()}`, { ...fields, stage: transfer.stage, ...(transfer.pausedBy ? { pausedBy: transfer.pausedBy } : {}) });
    }
    this.state = state;
    for (const listener of this.stateListeners) {
      try { listener(state); } catch { /* its own */ }
    }
  }

  /** Whether this side said something once in a chat (the join notice): kept with the seen set. */
  said(chat: string, what: string): boolean {
    return this.seen.get(`said:${chat}`)?.has(what) ?? false;
  }
  markSaid(chat: string, what: string): void {
    this.seenOf(`said:${chat}`).set(what, "yes");
    this.persist(`said:${chat}`, [[what, "yes"]]);
  }

  private seenOf(chat: string): Map<string, string> {
    let map = this.seen.get(chat);
    if (!map) this.seen.set(chat, (map = new Map()));
    return map;
  }

  private messages(chat: string, messages: readonly StoredMessage[]): void {
    const known = this.seenOf(chat);
    const group = chat.startsWith("group:") ? chat.slice(6) : null;
    const quiet = this.firstRun && !this.baselined;
    const changes: [string, string | null][] = [];
    const present = new Set<string>();
    for (const message of messages) {
      present.add(message.id);
      const state = deliveryOf(message), before = known.get(message.id);
      if (before === state) continue;
      known.set(message.id, state);
      changes.push([message.id, state]);
      if (quiet) continue;
      const json = messageJson(message);
      if (before === undefined) {
        if (group) {
          const type = message.event ? "group.event" : message.sender === "peer" ? "group.message" : "group.sent";
          this.emit(type, `${type}:${group}:${message.id}`, { group, message: json });
        } else {
          const notice = JOIN_NOTICE.exec(message.text);
          const type = notice ? (message.sender === "peer" ? "chat.joined" : "chat.announced") : message.sender === "peer" ? "message.received" : "message.sent";
          this.emit(type, `${type}:${chat}:${message.id}`, { chat, message: json, ...(notice ? { name: notice[1] ?? null } : {}) });
        }
      } else if (message.sender === "me" && !group) {
        this.emit("message.delivery", `message.delivery:${chat}:${message.id}:${state}`, { chat, messageId: message.id, delivery: state, ...(message.deliveryError ? { error: message.deliveryError } : {}) });
      }
    }
    for (const id of [...known.keys()]) {
      if (present.has(id)) continue;
      known.delete(id);
      changes.push([id, null]);
      if (!quiet) this.emit(group ? "group.deleted" : "message.deleted", `${group ? "group" : "message"}.deleted:${group ?? chat}:${id}`, group ? { group, messageId: id } : { chat, messageId: id });
    }
    if (changes.length) this.persist(chat, changes);
  }

  private persist(chat: string, changes: [string, string | null][]): void {
    const tx = this.db.transaction(SEEN, "readwrite");
    const store = tx.objectStore(SEEN);
    for (const [id, state] of changes) {
      if (state === null) store.delete([chat, id]);
      else store.put(state, [chat, id]);
    }
  }
}

function deliveryOf(message: StoredMessage): string {
  return message.sender === "peer" ? "received" : message.delivery ?? "sent";
}

function chatShape(link: LinkView): ChatShape {
  const view = chatJson(link);
  return { stage: view.stage, live: view.live, transport: view.transport, name: view.name };
}

function groupShape(group: GroupView): GroupShape {
  return { status: group.status ?? (group.invitation ? "invited" : null), members: group.members.map((m) => m.key).sort() };
}
