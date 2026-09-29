import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { EngineClientSink } from "@ghostly/browser/engine/server";
import type { EngineEvent, RpcResponse } from "@ghostly/browser/shared/rpc";
import type { EngineState, GroupView, LinkView, PinView, StoredMessage } from "@ghostly/browser/shared/types";
import { chatJson, groupJson, groupMessageJson, messageJson } from "./views";
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

/** How long a `file.*` event waits for the message that carries its file. */
export const FILE_MESSAGE_WAIT_MS = 2_000;

/** The notice an app sends when a chat first goes live (src/hooks/useChat.ts): shown as a line, not a message. */
export const JOIN_NOTICE = /^👋 (?:(.+) )?joined$/;

type Listener = (event: GhostlyEvent) => void;
type Seen = Map<string, Map<string, string>>;

interface ChatShape { stage: string | null; live: boolean; transport: string | null; name: string | null; typing: boolean; typingKind: string; typingStatus: string | null; pin: PinView | null }
interface GroupShape { status: string | null; members: string[]; typing: Record<string, { kind: string; status?: string }>; pin: PinView | null }

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
  private readonly callListeners = new Set<(chat: string, signal: string) => void>();
  private seen: Seen = new Map();
  private firstRun = false;
  private chats = new Map<string, ChatShape>();
  private groups = new Map<string, GroupShape>();
  private payments = new Map<string, string>();
  private transfers = new Map<string, string>();
  private received = new Map<string, string>();
  /** File id to the message that carries it, for `file.*` events. */
  private fileMessages = new Map<string, string>();
  /** `file.*` events whose message was not seen yet: they wait for it a moment (the engine stores it right after). */
  private pendingFiles = new Map<string, { timer: ReturnType<typeof setTimeout>; emits: ((messageId: string | null) => void)[] }>();
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
  /** A call signal from a contact's app, as the engine gives it. */
  onCallSignal(listener: (chat: string, signal: string) => void): () => void { this.callListeners.add(listener); return () => this.callListeners.delete(listener); }

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
      // Only what changed: the same events as the whole history would give, and a deletion is named, not missing.
      case "message-changes": this.messages(message.linkId, message.messages, message.deleted); break;
      // Calls (WISP 11xx § Calls): the call manager reports them (call.incoming, call.connected, call.ended).
      case "call-signal":
        for (const listener of this.callListeners) {
          try { listener(message.linkId, message.signal); } catch (error) { process.stderr.write(`ghostly: call error: ${error instanceof Error ? error.stack : String(error)}\n`); }
        }
        break;
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
      if (!before) { this.emit("chat.created", `chat.created:${id}`, { chat: id, summary: { ...chatJson(link), invite: null } }); continue; }
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
      this.pinned("chat", id, before.pin, shape.pin);
      // The contact started or stopped writing (WISP 401 § Typing): it stops by itself 6 s after its last word. What
      // it is doing (typing, recording, thinking, a bot's status) goes with the start, and a change while it lasts
      // is a start again (its id then carries the sequence, so two changes in one millisecond stay apart).
      if (shape.typing !== before.typing) {
        this.emit(shape.typing ? "typing.started" : "typing.stopped", `typing.${shape.typing ? "started" : "stopped"}:${id}:${this.now()}`, { chat: id, ...(shape.typing ? typingFields(shape) : {}) });
      } else if (shape.typing && (shape.typingKind !== before.typingKind || shape.typingStatus !== before.typingStatus)) {
        this.emit("typing.started", `typing.started:${id}:${this.now()}:${this.seq + 1}`, { chat: id, ...typingFields(shape) });
      }
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
      this.pinned("group", id, before.pin, shape.pin);
      // A member started or stopped writing in a private group (WISP 9xx · Group Mesh § Typing), as `typing.*` in a chat.
      for (const [member, word] of Object.entries(shape.typing)) {
        const was = before.typing[member];
        if (was && was.kind === word.kind && was.status === word.status) continue;
        this.emit("group.typing.started", `group.typing.started:${id}:${member}:${this.now()}${was ? `:${this.seq + 1}` : ""}`, { group: id, member, ...word });
      }
      for (const member of Object.keys(before.typing)) {
        if (!shape.typing[member]) this.emit("group.typing.stopped", `group.typing.stopped:${id}:${member}:${this.now()}`, { group: id, member });
      }
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
    for (const link of state.links) {
      for (const identity of link.identities?.received ?? []) {
        const key = `${link.id}:${identity.id}`, shape = identity.status, before = this.received.get(key);
        this.received.set(key, shape);
        if (quiet || before === shape) continue;
        this.emit(before === undefined ? "identity.received" : "identity.status", `identity.${before === undefined ? "received" : "status"}:${key}:${shape}`, {
          chat: link.id, identity: { id: identity.id, provider: identity.provider, subject: identity.subject, status: identity.status, verified: identity.verified },
        });
      }
    }
    for (const [id, transfer] of Object.entries(state.transfers ?? {})) {
      const shape = `${transfer.state}|${transfer.stage ?? ""}`, before = this.transfers.get(id);
      this.transfers.set(id, shape);
      if (quiet || before === shape) continue;
      const chat = state.links.find((l) => id.startsWith(`${l.id}-`))?.id ?? null;
      const fields = { chat, file: id, direction: transfer.direction ?? (id.includes("-in-") ? "in" : "out"), size: transfer.size, transferred: transfer.transferred, ...(transfer.error ? { error: transfer.error } : {}) };
      let emit: ((messageId: string | null) => void) | null = null;
      if (transfer.state === "done") { const key = `file.done:${id}`; emit = (messageId) => this.emit("file.done", key, { ...fields, messageId }); }
      else if (transfer.state === "failed") { const key = `file.failed:${id}:${this.now()}`; emit = (messageId) => this.emit("file.failed", key, { ...fields, messageId, retry: !!transfer.retry }); }
      else if (transfer.stage === "asking" && fields.direction === "in") { const key = `file.offered:${id}:${this.now()}`; emit = (messageId) => this.emit("file.offered", key, { ...fields, messageId, room: transfer.room ?? null }); }
      else if (transfer.stage) {
        const key = `file.stage:${id}:${transfer.stage}:${this.now()}`, stage = { stage: transfer.stage, ...(transfer.pausedBy ? { pausedBy: transfer.pausedBy } : {}) };
        emit = (messageId) => this.emit("file.stage", key, { ...fields, messageId, ...stage });
      }
      if (emit) this.fileEvent(id, emit);
    }
    this.state = state;
    for (const listener of this.stateListeners) {
      try { listener(state); } catch { /* its own */ }
    }
  }

  /**
   * Someone else pinned a message, or unpinned it (WISP 400 § Pinned message): `chat.pinned` or `group.pinned`, with
   * `messageId` (the row here; null when it is not here, or unpinned), `ref` (the id both sides know), `by` (`peer` or a
   * member key) and `removed`. What this profile pins itself says nothing: its command answered already.
   */
  private pinned(kind: "chat" | "group", id: string, before: PinView | null, now: PinView | null): void {
    if (!now || now.by === "me" || (before?.id === now.id && before.at === now.at)) return;
    const fields = { [kind]: id, messageId: now.messageId ?? null, ref: now.id || null, by: now.by, removed: !now.id };
    this.emit(`${kind}.pinned`, `${kind}.pinned:${id}:${now.id || "off"}:${now.at}`, fields);
  }

  /**
   * A `file.*` event names the message that carries the file. The engine can say where a transfer stands before it
   * stores that message: the event then waits for it, up to 2 s, and goes with `messageId: null` after that.
   */
  private fileEvent(fileId: string, emit: (messageId: string | null) => void): void {
    const pending = this.pendingFiles.get(fileId);
    const messageId = this.fileMessages.get(fileId);
    if (messageId && !pending) { emit(messageId); return; }
    if (pending) { pending.emits.push(emit); return; }
    const timer = setTimeout(() => this.flushFile(fileId, null), FILE_MESSAGE_WAIT_MS);
    timer.unref?.();
    this.pendingFiles.set(fileId, { timer, emits: [emit] });
  }

  private flushFile(fileId: string, messageId: string | null): void {
    const pending = this.pendingFiles.get(fileId);
    if (!pending) return;
    this.pendingFiles.delete(fileId);
    clearTimeout(pending.timer);
    for (const emit of pending.emits) emit(messageId);
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

  /** A chat's or group's whole history, or with `deleted` only what changed in it (then only those ids are gone). */
  private messages(chat: string, messages: readonly StoredMessage[], deleted?: readonly string[]): void {
    const known = this.seenOf(chat);
    const group = chat.startsWith("group:") ? chat.slice(6) : null;
    // A group's whole history, empty: I left or forgot the group and its history went with it (a group joined again
    // starts from nothing). Nobody deleted a message: its rows are forgotten here without a `group.deleted` each.
    const quiet = (this.firstRun && !this.baselined) || (!!group && !deleted && messages.length === 0);
    const changes: [string, string | null][] = [];
    const present = new Set<string>();
    this.reactions(chat, group, messages, quiet);
    const files: [string, string][] = [];
    for (const message of messages) {
      present.add(message.id);
      if (message.file && this.fileMessages.get(message.file.id) !== message.id) { this.fileMessages.set(message.file.id, message.id); files.push([message.file.id, message.id]); }
      const state = stateOf(message), before = known.get(message.id);
      if (before === state) continue;
      known.set(message.id, state);
      changes.push([message.id, state]);
      if (quiet) continue;
      const json = group ? groupMessageJson(message, this.state?.groups.find((g) => g.id === group)) : messageJson(message);
      if (before === undefined) {
        if (group) {
          const type = message.event ? "group.event" : message.sender === "peer" ? "group.message" : "group.sent";
          this.emit(type, `${type}:${group}:${message.id}`, { group, message: json });
        } else {
          const notice = JOIN_NOTICE.exec(message.text);
          const type = notice ? (message.sender === "peer" ? "chat.joined" : "chat.announced") : message.sender === "peer" ? "message.received" : "message.sent";
          this.emit(type, `${type}:${chat}:${message.id}`, { chat, message: json, ...(notice ? { name: notice[1] ?? null } : {}) });
        }
      } else if (group) {
        // A new text in a group (WISP 9xx § Edits): mine as made here, a member's as it came. Once per edit number.
        const [, edits] = splitState(state), [, edited] = splitState(before);
        if (edits > edited) this.emit("group.message.edited", `group.message.edited:${group}:${message.id}:${edits}`, { group, messageId: message.id, edits, message: json });
      } else {
        const [delivery, edits] = splitState(state), [was, edited] = splitState(before);
        // A new text (WISP 400 § Edits): mine as made here, the contact's as it came. Once per edit number.
        if (edits > edited) this.emit("message.edited", `message.edited:${chat}:${message.id}:${edits}`, { chat, messageId: message.id, edits, message: json });
        if (message.sender === "me" && delivery !== was)
          this.emit("message.delivery", `message.delivery:${chat}:${message.id}:${delivery}`, { chat, messageId: message.id, delivery, ...(message.deliveryError ? { error: message.deliveryError } : {}) });
      }
    }
    for (const id of deleted ?? [...known.keys()]) {
      if (present.has(id) || !known.has(id)) continue;
      known.delete(id);
      changes.push([id, null]);
      if (!quiet) this.emit(group ? "group.deleted" : "message.deleted", `${group ? "group" : "message"}.deleted:${group ?? chat}:${id}`, group ? { group, messageId: id } : { chat, messageId: id });
    }
    if (changes.length) this.persist(chat, changes);
    // After the message's own event: what waited for it goes now.
    for (const [fileId, messageId] of files) this.flushFile(fileId, messageId);
  }

  /**
   * Reactions that changed (WISP 400 § Reactions): `message.reaction` in a chat, `group.reaction` in a group, one per
   * person and number; `emoji` "" when one was taken back. Kept apart from the messages' own seen set.
   */
  private reactions(chat: string, group: string | null, messages: readonly StoredMessage[], quiet: boolean): void {
    const key = `reactions:${chat}`, known = this.seenOf(key);
    const changes: [string, string | null][] = [];
    for (const message of messages) for (const [by, r] of Object.entries(message.reactions ?? {})) {
      const id = `${message.id}|${by}`, value = String(r.n);
      if (known.get(id) === value) continue;
      const before = known.get(id);
      known.set(id, value);
      changes.push([id, value]);
      // A reaction taken back before this process ever reported it says nothing.
      if (quiet || (before === undefined && !r.e)) continue;
      const fields = { messageId: message.id, by, emoji: r.e, removed: !r.e, mine: message.sender === "me" };
      if (group) this.emit("group.reaction", `group.reaction:${group}:${message.id}:${by}:${r.n}`, { group, ...fields });
      else this.emit("message.reaction", `message.reaction:${chat}:${message.id}:${by}:${r.n}`, { chat, ...fields });
    }
    if (changes.length) this.persist(key, changes);
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

/** What the seen set keeps of a message: its delivery, and its edit number once edited (`sent#e3`). */
function stateOf(message: StoredMessage): string {
  return message.edit ? `${deliveryOf(message)}#e${message.edit.seq}` : deliveryOf(message);
}
function splitState(state: string): [string, number] {
  const at = state.lastIndexOf("#e");
  return at === -1 ? [state, 0] : [state.slice(0, at), Number(state.slice(at + 2)) || 0];
}

function chatShape(link: LinkView): ChatShape {
  const view = chatJson(link);
  return {
    stage: view.stage, live: view.live, transport: view.transport, name: view.name, typing: !!link.peerTyping,
    typingKind: link.peerTyping ? link.peerTypingKind ?? "typing" : "typing", typingStatus: link.peerTyping ? link.peerTypingStatus ?? null : null, pin: link.pin ?? null,
  };
}

/** A `typing.started`'s word: the kind, and the contact's status line when it gave one (already cleaned). */
function typingFields(shape: ChatShape): { kind: string; status?: string } {
  return { kind: shape.typingKind, ...(shape.typingStatus ? { status: shape.typingStatus } : {}) };
}

function groupShape(group: GroupView): GroupShape {
  return { status: group.status ?? (group.invitation ? "invited" : null), members: group.members.map((m) => m.key).sort(),
    typing: Object.fromEntries((group.typing ?? []).map((t) => [t.key, { kind: t.kind ?? "typing", ...(t.status ? { status: t.status } : {}) }])), pin: group.pin ?? null };
}
