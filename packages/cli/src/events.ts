import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { AppFrameEvent } from "@ghostly/core";
import type { EngineClientSink } from "@ghostly/browser/engine/server";
import type { EngineEvent, RpcResponse } from "@ghostly/browser/shared/rpc";
import type { EngineState, GroupView, LinkView, PinView, StoredMessage } from "@ghostly/browser/shared/types";
import { chatJson, chatMessageJson, groupJson, groupMessageJson } from "./views";
import { paymentJson } from "./wallets";

/**
 * The event stream (WISP 1100 § Event stream): what happened, derived from the engine's own events, one JSON object
 * each, with a `seq` that grows across restarts and an `id` stable for the fact it reports.
 */
export interface GhostlyEvent { seq: number; id: string; type: string; at: number; [field: string]: unknown }

/** Events the journal keeps for `listen --since`. */
export const JOURNAL_KEEP = 10_000;
/** Bytes the journal keeps at most: a contact's long texts never make it too large to read. */
export const JOURNAL_KEEP_BYTES = 16 * 1024 * 1024;
/** A journal past this is trimmed, and only this much of its end is ever read. */
export const JOURNAL_MAX_BYTES = 2 * JOURNAL_KEEP_BYTES;
const SEEN_DB = "ghostly-cli";
const SEEN = "seen";

/**
 * How long the seen set keeps the note of a settled message after its last activity (its arrival, its edit, a reaction):
 * older notes are dropped, and a message that came here longer ago with no note is no news. A daemon kept a note per
 * message of its whole history in memory, for as long as it ran.
 */
export const SEEN_KEEP_MS = 30 * 86_400_000;
/** How often a daemon drops the notes that passed `SEEN_KEEP_MS`. */
const SWEEP_EVERY_MS = 6 * 3_600_000;

/** How long a `file.*` event waits for the message that carries its file. */
export const FILE_MESSAGE_WAIT_MS = 2_000;

/** The notice an app sends when a chat first goes live (apps/ui/src/hooks/useChat.ts): shown as a line, not a message. */
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
  private journalBytes = 0;
  private readonly listeners = new Set<Listener>();
  private readonly stateListeners = new Set<(state: EngineState) => void>();
  private readonly callListeners = new Set<(chat: string, signal: string) => void>();
  private readonly appListeners = new Set<(chat: string, frame: AppFrameEvent) => void>();
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
  /** Chats and groups whose history the baseline did not read whole, and how to read it: until a file event needs it. */
  private unread = new Map<string, (chat: string) => Promise<readonly StoredMessage[]>>();
  /**
   * Whether the seen set notes mentions (`+m`): false on a set written before it did, whose mentions were reported with
   * their `group.message` already. Its first baseline then notes them without a `group.mentioned` each.
   */
  private mentionsNoted = true;
  /** Whether the notes carry their time (`@…`): false on a set written before they did, until a whole read stamps them. */
  private agesNoted = true;
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private db!: IDBDatabase;
  state: EngineState | null = null;

  /** `seenDb`: the IndexedDB database of the seen set (tests give each hub its own). */
  constructor(private readonly journalPath: string, private readonly now: () => number = Date.now, private readonly seenDb = SEEN_DB) {}

  /** Loads the journal's last seq and the seen set; call before `sink` is attached. */
  async open(): Promise<void> {
    // A journal that cannot be read never keeps the profile from opening: it is set aside and a new one begins.
    try {
      if (existsSync(this.journalPath)) {
        const { lines, size } = journalTail(this.journalPath);
        this.journalLines = lines.length;
        this.journalBytes = size;
        for (let i = lines.length - 1; i >= 0; i--) {
          try { this.seq = (JSON.parse(lines[i]) as GhostlyEvent).seq; break; } catch { /* a torn last line */ }
        }
        if (size > JOURNAL_MAX_BYTES || lines.length > JOURNAL_KEEP * 2) this.trimJournal();
      }
    } catch (error) {
      process.stderr.write(`ghostly: the event journal could not be read, a new one begins: ${error instanceof Error ? error.message : String(error)}\n`);
      try { renameSync(this.journalPath, this.journalPath + ".unreadable"); } catch { /* best effort */ }
      this.journalLines = 0;
      this.journalBytes = 0;
    }
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.seenDb, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore(SEEN); this.firstRun = true; };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    // Two requests for the whole set, never a cursor: a cursor costs one tree search per row on Node's IndexedDB.
    const store = this.db.transaction(SEEN).objectStore(SEEN);
    const all = <T>(request: IDBRequest<T[]>) => new Promise<T[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const [keys, values] = await Promise.all([all(store.getAllKeys()), all(store.getAll() as IDBRequest<string[]>)]);
    for (let i = 0; i < keys.length; i++) {
      const [chat, id] = keys[i] as [string, string];
      this.seenOf(chat).set(id, values[i]);
    }
    this.mentionsNoted = this.firstRun || this.seen.get(FORMAT)?.get(MENTIONS_NOTED) === "yes";
    this.agesNoted = this.firstRun || this.seen.get(FORMAT)?.get(AGES_NOTED) === "yes";
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
  baseline(state: EngineState, histories: Map<string, readonly StoredMessage[]>, rest?: { newest: Map<string, readonly StoredMessage[]>; whole: (chat: string) => Promise<readonly StoredMessage[]> }): void {
    this.stateChanged(state);
    for (const [chat, messages] of histories) this.messages(chat, messages);
    // `rest.newest`: chats and groups in step (`inStep`), only their newest messages read. Nothing in them is news;
    // a file of an older message is looked up when an event needs it (`rest.whole` reads the history then).
    for (const [chat, messages] of rest?.newest ?? []) { this.messages(chat, messages, []); this.unread.set(chat, rest!.whole); }
    this.baselined = true;
    this.firstRun = false;
    // The set's own marks, in one write: it notes mentions, and (every history having been read whole while it did not)
    // its notes carry their time.
    const marks = [MENTIONS_NOTED, AGES_NOTED].filter((mark) => this.seen.get(FORMAT)?.get(mark) !== "yes");
    for (const mark of marks) this.seenOf(FORMAT).set(mark, "yes");
    if (marks.length) this.persist(FORMAT, marks.map((mark) => [mark, "yes"]));
    this.mentionsNoted = true;
    this.agesNoted = true;
    this.sweep();
    if (!this.sweeper) {
      this.sweeper = setInterval(() => this.sweep(), SWEEP_EVERY_MS);
      this.sweeper.unref?.();
    }
  }

  /**
   * Drops the notes of settled messages, and of reactions, whose last activity is older than `SEEN_KEEP_MS`: from memory
   * and from the store. A message of mine still on its way (or failed, which a retry sends again) keeps its note.
   */
  sweep(): number {
    const cutoff = this.now() - SEEN_KEEP_MS;
    let dropped = 0;
    for (const [chat, known] of this.seen) {
      if (chat === FORMAT || chat.startsWith("said:")) continue;
      const reactions = chat.startsWith("reactions:");
      const gone: [string, null][] = [];
      for (const [id, note] of known) {
        const at = timeIn(note);
        if (at === undefined || at >= cutoff || (!reactions && !settled(stateIn(note)))) continue;
        known.delete(id);
        gone.push([id, null]);
      }
      if (gone.length) { this.persist(chat, gone); dropped += gone.length; }
      if (!known.size) this.seen.delete(chat);
    }
    return dropped;
  }

  /**
   * Whether these messages of a chat or group (its newest) are all as the seen set has them, reactions included: there
   * is then nothing to report of them. Never on a first run, nor on a seen set from before it noted mentions: those
   * take the whole history once.
   */
  inStep(chat: string, messages: readonly StoredMessage[]): boolean {
    if (this.firstRun || !this.mentionsNoted || !this.agesNoted) return false;
    const known = this.seen.get(chat), reactions = this.seen.get(`reactions:${chat}`);
    const cutoff = this.now() - SEEN_KEEP_MS;
    return messages.every((message) => {
      const note = known?.get(message.id), before = note === undefined ? undefined : stateIn(note);
      // Its note dropped, and nothing about it since (`SEEN_KEEP_MS`): nothing to report of it.
      if (note === undefined && message.timestamp < cutoff && activityOf(message) < cutoff) return true;
      let state = stateOf(message);
      // As `messages` reads it: a mention reported stays reported.
      if (before !== undefined && mentionedIn(before) && !mentionedIn(state)) state = withFlag(state, MENTIONED);
      if (before !== state) return false;
      return Object.entries(message.reactions ?? {}).every(([by, r]) => {
        const note = reactions?.get(`${message.id}|${by}`);
        return note === undefined ? r.at < cutoff : stateIn(note) === String(r.n);
      });
    });
  }

  onEvent(listener: Listener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onState(listener: (state: EngineState) => void): () => void { this.stateListeners.add(listener); return () => this.stateListeners.delete(listener); }
  /** A call signal from a contact's app, as the engine gives it. */
  onCallSignal(listener: (chat: string, signal: string) => void): () => void { this.callListeners.add(listener); return () => this.callListeners.delete(listener); }
  /** A frame of a contact's mini-app (apps/1), as the engine gives it: the app named by its chat app id. */
  onAppFrame(listener: (chat: string, frame: AppFrameEvent) => void): () => void { this.appListeners.add(listener); return () => this.appListeners.delete(listener); }

  /** Events after `since` still in the journal; a gap event first when older ones were dropped. */
  replay(since: number): GhostlyEvent[] {
    if (!existsSync(this.journalPath) || since >= this.seq) return [];
    const out: GhostlyEvent[] = [];
    for (const line of journalTail(this.journalPath).lines) {
      try { const event = JSON.parse(line) as GhostlyEvent; if (event.seq > since) out.push(event); } catch { /* torn */ }
    }
    if (out.length && out[0].seq > since + 1) out.unshift({ seq: since, id: `events.gap:${since}:${out[0].seq}`, type: "events.gap", at: this.now(), from: since + 1, to: out[0].seq - 1 });
    return out;
  }

  get lastSeq(): number { return this.seq; }

  /** Emits an event the host makes itself (`daemon.started`). */
  emit(type: string, id: string, fields: Record<string, unknown> = {}): GhostlyEvent {
    const event: GhostlyEvent = { seq: ++this.seq, id, type, at: this.now(), ...fields };
    // The journal failing never keeps an event from the listeners.
    try {
      const line = JSON.stringify(event) + "\n";
      appendFileSync(this.journalPath, line, { mode: 0o600 });
      this.journalBytes += Buffer.byteLength(line);
      if (++this.journalLines > JOURNAL_KEEP * 2 || this.journalBytes > JOURNAL_MAX_BYTES) this.trimJournal();
    } catch (error) {
      process.stderr.write(`ghostly: event journal error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    this.tell(event);
    return event;
  }

  /**
   * An event for the listeners only, never the journal: a contact's app frames, live only (WISP 1200), which at the
   * receiver's rate would push every other chat's events out of it in seconds. It takes no seq of its own but the last
   * event's (as an `agent.turn` takes its source's): a cursor that handled it resumes after that event, a replay never
   * gives it, and a restart never numbers an event again.
   */
  emitLive(type: string, id: string, fields: Record<string, unknown> = {}): GhostlyEvent {
    const event: GhostlyEvent = { seq: this.seq, id, type, at: this.now(), ...fields };
    this.tell(event);
    return event;
  }

  private tell(event: GhostlyEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* one listener's failure is its own */ }
    }
  }

  /** Keeps the last `JOURNAL_KEEP` events, and of them no more than `JOURNAL_KEEP_BYTES`. */
  private trimJournal(): void {
    const lines = journalTail(this.journalPath).lines.slice(-JOURNAL_KEEP);
    let start = lines.length, bytes = 0;
    while (start > 0 && bytes + Buffer.byteLength(lines[start - 1]) + 1 <= JOURNAL_KEEP_BYTES) bytes += Buffer.byteLength(lines[--start]) + 1;
    const kept = lines.slice(start);
    writeFileSync(this.journalPath + ".tmp", kept.length ? kept.join("\n") + "\n" : "", { mode: 0o600 });
    renameSync(this.journalPath + ".tmp", this.journalPath);
    this.journalLines = kept.length;
    this.journalBytes = bytes;
  }

  /**
   * What was removed here leaves the journal too: the journal is written again without the events that name it (a
   * line that names it and cannot be read goes as well), and a journal set aside as unreadable, which cannot be sorted,
   * is deleted. `ids`: what was removed (a message's id, a chat's or a group's); `gone`: whether an event is of it.
   */
  private forget(ids: readonly string[], gone: (event: GhostlyEvent) => boolean): void {
    if (!ids.length) return;
    try {
      rmSync(this.journalPath + ".unreadable", { force: true });
      if (!existsSync(this.journalPath)) return;
      const lines = journalTail(this.journalPath).lines;
      const kept = lines.filter((line) => {
        if (!ids.some((id) => line.includes(JSON.stringify(id)))) return true;
        try { return !gone(JSON.parse(line) as GhostlyEvent); } catch { return false; }
      });
      if (kept.length === lines.length) return;
      writeFileSync(this.journalPath + ".tmp", kept.length ? kept.join("\n") + "\n" : "", { mode: 0o600 });
      renameSync(this.journalPath + ".tmp", this.journalPath);
      this.journalLines = kept.length;
      this.journalBytes = kept.reduce((bytes, line) => bytes + Buffer.byteLength(line) + 1, 0);
    } catch (error) {
      process.stderr.write(`ghostly: event journal error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  private handle(message: EngineEvent | RpcResponse): void {
    switch (message.kind) {
      case "state": this.stateChanged(message.state); break;
      case "messages": this.messages(message.linkId, message.messages); break;
      // Only what changed: the same events as the whole history would give, and a deletion is named, not missing.
      case "message-changes": this.messages(message.linkId, message.messages, message.deleted); break;
      // Calls (WISP 1100 § Calls): the call manager reports them (call.incoming, call.connected, call.ended).
      case "call-signal":
        for (const listener of this.callListeners) {
          try { listener(message.linkId, message.signal); } catch (error) { process.stderr.write(`ghostly: call error: ${error instanceof Error ? error.stack : String(error)}\n`); }
        }
        break;
      // Mini-apps this profile serves as a bot (./appEvents.ts): app.opened, app.closed, app.message.
      case "app-frame":
        for (const listener of this.appListeners) {
          try { listener(message.linkId, message.event); } catch (error) { process.stderr.write(`ghostly: app frame error: ${error instanceof Error ? error.stack : String(error)}\n`); }
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
    const removedChats = [...this.chats.keys()].filter((id) => !links.has(id));
    for (const id of removedChats) {
      this.chats.delete(id);
      if (!quiet) this.emit("chat.removed", `chat.removed:${id}`, { chat: id });
    }
    // A chat removed deletes its history here: its events go too, but for its removal.
    this.forget(removedChats, (event) => removedChats.includes(event.chat as string) && event.type !== "chat.removed");
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
      // A member started or stopped writing in a private group (WISP 902 · Group Mesh § Typing), as `typing.*` in a chat.
      for (const [member, word] of Object.entries(shape.typing)) {
        const was = before.typing[member];
        if (was && was.kind === word.kind && was.status === word.status) continue;
        this.emit("group.typing.started", `group.typing.started:${id}:${member}:${this.now()}${was ? `:${this.seq + 1}` : ""}`, { group: id, member, ...word });
      }
      for (const member of Object.keys(before.typing)) {
        if (!shape.typing[member]) this.emit("group.typing.stopped", `group.typing.stopped:${id}:${member}:${this.now()}`, { group: id, member });
      }
    }
    const removedGroups = [...this.groups.keys()].filter((id) => !groups.has(id));
    for (const id of removedGroups) {
      this.groups.delete(id);
      if (!quiet) this.emit("group.removed", `group.removed:${id}`, { group: id });
    }
    // A group left or forgotten: the same.
    this.forget(removedGroups, (event) => removedGroups.includes(event.group as string) && event.type !== "group.removed");
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
      // A group's file (WISP 503) names its group.
      const group = chat ? undefined : state.groups.find((g) => id.startsWith(`group-${g.id}-`))?.id;
      const fields = { chat, ...(group ? { group } : {}), file: id, direction: transfer.direction ?? (id.includes("-in-") ? "in" : "out"), size: transfer.size, transferred: transfer.transferred, ...(transfer.error ? { error: transfer.error } : {}) };
      let emit: ((messageId: string | null) => void) | null = null;
      if (transfer.state === "done") { const key = `file.done:${id}`; emit = (messageId) => this.emit("file.done", key, { ...fields, messageId }); }
      else if (transfer.state === "failed") { const key = `file.failed:${id}:${this.now()}`; emit = (messageId) => this.emit("file.failed", key, { ...fields, messageId, retry: !!transfer.retry }); }
      else if (transfer.stage === "asking" && fields.direction === "in") { const key = `file.offered:${id}:${this.now()}`; emit = (messageId) => this.emit("file.offered", key, { ...fields, messageId, room: transfer.room ?? null }); }
      else if (transfer.stage) {
        const key = `file.stage:${id}:${transfer.stage}:${this.now()}`, stage = { stage: transfer.stage, ...(transfer.pausedBy ? { pausedBy: transfer.pausedBy } : {}) };
        emit = (messageId) => this.emit("file.stage", key, { ...fields, messageId, ...stage });
      }
      if (emit) this.fileEvent(id, emit, chat ?? (group ? `group:${group}` : null));
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
  private fileEvent(fileId: string, emit: (messageId: string | null) => void, chat: string | null): void {
    const pending = this.pendingFiles.get(fileId);
    const messageId = this.fileMessages.get(fileId);
    if (messageId && !pending) { emit(messageId); return; }
    if (pending) { pending.emits.push(emit); return; }
    const timer = setTimeout(() => this.flushFile(fileId, null), FILE_MESSAGE_WAIT_MS);
    timer.unref?.();
    this.pendingFiles.set(fileId, { timer, emits: [emit] });
    // A file of a message older than the ones the baseline read: the history is read now, once, for all its files.
    const read = chat === null ? undefined : this.unread.get(chat);
    if (!read) return;
    this.unread.delete(chat!);
    void read(chat!).then((messages) => {
      for (const message of messages) {
        if (!message.file || this.fileMessages.has(message.file.id)) continue;
        this.fileMessages.set(message.file.id, message.id);
        this.flushFile(message.file.id, message.id);
      }
    }).catch(() => { /* the file's event goes without its message, as one whose message never came */ });
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
    const cutoff = this.now() - SEEN_KEEP_MS;
    for (const message of messages) {
      present.add(message.id);
      if (message.file && this.fileMessages.get(message.file.id) !== message.id) { this.fileMessages.set(message.file.id, message.id); files.push([message.file.id, message.id]); }
      let state = stateOf(message);
      const note = known.get(message.id), before = note === undefined ? undefined : stateIn(note);
      const at = activityOf(message);
      const json = () => group ? groupMessageJson(message, this.state?.groups.find((g) => g.id === group)) : chatMessageJson(message, this.state?.links.find((l) => l.id === chat));
      if (before === undefined && message.timestamp < cutoff) {
        // Came here longer ago than `SEEN_KEEP_MS`, with no note: its note was dropped (or it came, that long ago, while
        // nothing ran). No news, and no note again, unless it was active since: then an edit since is reported, once.
        if (at < cutoff) continue;
        const noted = noteOf(state, at);
        known.set(message.id, noted);
        changes.push([message.id, noted]);
        const edit = message.edit;
        if (quiet || !edit || edit.at < cutoff || (message.sender === "me" && edit.restore)) continue;
        if (group) this.emit("group.message.edited", `group.message.edited:${group}:${message.id}:${edit.seq}`, { group, messageId: message.id, edits: edit.seq, message: json() });
        else this.emit("message.edited", `message.edited:${chat}:${message.id}:${edit.seq}`, { chat, messageId: message.id, edits: edit.seq, message: json() });
        continue;
      }
      // A mention reported stays reported: an edit that drops it and one that names me again say nothing more.
      if (before !== undefined && mentionedIn(before) && !mentionedIn(state)) state = withFlag(state, MENTIONED);
      if (before === state) {
        // A note from before notes carried their time gets it now, and nothing is reported.
        if (timeIn(note!) === undefined) { const noted = noteOf(state, at); known.set(message.id, noted); changes.push([message.id, noted]); }
        continue;
      }
      const noted = noteOf(state, at);
      known.set(message.id, noted);
      changes.push([message.id, noted]);
      if (quiet) continue;
      if (before === undefined) {
        if (group) {
          const type = message.event ? "group.event" : message.sender === "peer" ? "group.message" : "group.sent";
          this.emit(type, `${type}:${group}:${message.id}`, { group, message: json() });
        } else {
          const notice = JOIN_NOTICE.exec(message.text);
          const type = notice ? (message.sender === "peer" ? "chat.joined" : "chat.announced") : message.sender === "peer" ? "message.received" : "message.sent";
          this.emit(type, `${type}:${chat}:${message.id}`, { chat, message: json(), ...(notice ? { name: notice[1] ?? null } : {}) });
        }
        if (message.sender === "peer" && message.press) this.pressed(chat, group, message, json());
        continue;
      }
      // A press the engine learned after the reply was first seen here: a group reply first held from a copy a member
      // handed on without its reply box, which its author's whole copy completes (WISP 902 · Group Mesh § Catch-up).
      if (message.sender === "peer" && message.press && !pressedIn(before)) this.pressed(chat, group, message, json());
      // A mention of me learned after the message was reported: a group message first held from a copy a member handed
      // on without its author's whole signature, which the whole copy completes (WISP 902 · Group Mesh § Catch-up), or
      // an edit that names me. Its `group.message` said no mention; this says it, once.
      if (group && mentionedIn(state) && !mentionedIn(before) && this.mentionsNoted)
        this.emit("group.mentioned", `group.mentioned:${group}:${message.id}`, { group, messageId: message.id, message: json() });
      if (group) {
        // A new text in a group (WISP 902 § Edits): mine as made here, a member's as it came. Once per edit number.
        const [, edits] = splitState(state), [, edited] = splitState(before);
        if (edits > edited) this.emit("group.message.edited", `group.message.edited:${group}:${message.id}:${edits}`, { group, messageId: message.id, edits, message: json() });
      } else {
        const [delivery, edits] = splitState(state), [was, edited] = splitState(before);
        // A new text (WISP 400 § Edits): mine as made here, the contact's as it came. Once per edit number. The engine's
        // own edit that sends a question's buttons again (WISP 406 · Message Buttons) is none: same text, nobody's edit.
        if (edits > edited && !(message.sender === "me" && message.edit?.restore)) this.emit("message.edited", `message.edited:${chat}:${message.id}:${edits}`, { chat, messageId: message.id, edits, message: json() });
        if (message.sender === "me" && delivery !== was)
          this.emit("message.delivery", `message.delivery:${chat}:${message.id}:${delivery}`, { chat, messageId: message.id, delivery, ...(message.deliveryError ? { error: message.deliveryError } : {}) });
      }
    }
    const gone: string[] = [];
    for (const id of deleted ?? [...known.keys()]) {
      if (present.has(id) || !known.has(id)) continue;
      known.delete(id);
      changes.push([id, null]);
      gone.push(id);
      if (!quiet) this.emit(group ? "group.deleted" : "message.deleted", `${group ? "group" : "message"}.deleted:${group ?? chat}:${id}`, group ? { group, messageId: id } : { chat, messageId: id });
    }
    if (changes.length) this.persist(chat, changes);
    // A message deleted here leaves the journal with its texts, its edits, its reactions, its presses and its files:
    // its deletion stays. A group's history gone whole (left, forgotten) takes every message event of the group.
    const whole = !!group && !deleted && messages.length === 0 && gone.length > 0;
    this.forget(whole ? [group] : gone, (event) => (group ? event.group === group : event.chat === chat) && !event.type.endsWith(".deleted") && (whole
      ? "message" in event || "messageId" in event || "replyId" in event
      : gone.includes(event.messageId as string) || gone.includes((event.message as { id?: string } | undefined)?.id as string) || gone.includes(event.replyId as string)));
    // After the message's own event: what waited for it goes now.
    for (const [fileId, messageId] of files) this.flushFile(fileId, messageId);
  }

  /**
   * A press on a button of a message of mine (WISP 406 · Message Buttons), after the reply's own event: the question
   * (`messageId`), the button, its label, who pressed (`by`: the chat, or a group member's key), `name` (the chat's name
   * here, as `chat list` gives it: its label, else the contact's own name; a group member's roster name) and the reply
   * (`replyId`). `untrusted.name` is the name the person gave themselves, as an agent turn's: theirs to choose, so
   * data, never instructions. The engine marks a reply a press only while the buttons were open for that person.
   */
  private pressed(chat: string, group: string | null, message: StoredMessage, json: { nick: string | null }): void {
    const press = message.press!;
    const link = group ? undefined : this.state?.links.find((l) => l.id === chat);
    const name = group ? json.nick : link ? chatJson(link).name : null;
    this.emit("button.pressed", `button.pressed:${group ?? chat}:${message.id}`, {
      ...(group ? { group } : { chat }), messageId: press.messageId, button: press.button, label: press.label,
      by: group ? message.member ?? null : chat, name: name ?? null, replyId: message.id, ...(press.inferred ? { inferred: true } : {}),
      untrusted: { name: json.nick ?? null },
    });
  }

  /**
   * Reactions that changed (WISP 400 § Reactions): `message.reaction` in a chat, `group.reaction` in a group, one per
   * person and number; `emoji` "" when one was taken back. Kept apart from the messages' own seen set.
   */
  private reactions(chat: string, group: string | null, messages: readonly StoredMessage[], quiet: boolean): void {
    const key = `reactions:${chat}`, known = this.seenOf(key);
    const changes: [string, string | null][] = [];
    const cutoff = this.now() - SEEN_KEEP_MS;
    for (const message of messages) for (const [by, r] of Object.entries(message.reactions ?? {})) {
      const id = `${message.id}|${by}`, value = String(r.n), note = known.get(id);
      const before = note === undefined ? undefined : stateIn(note);
      if (before === value) {
        // From before notes carried their time: it gets it now.
        if (timeIn(note!) === undefined) { const noted = noteOf(value, r.at); known.set(id, noted); changes.push([id, noted]); }
        continue;
      }
      // Its note dropped (`SEEN_KEEP_MS`), and not made again since: no news.
      if (before === undefined && r.at < cutoff) continue;
      const noted = noteOf(value, r.at);
      known.set(id, noted);
      changes.push([id, noted]);
      // A reaction taken back before this process ever reported it says nothing.
      if (quiet || (before === undefined && !r.e)) continue;
      const fields = { messageId: message.id, by, emoji: r.e, removed: !r.e, mine: message.sender === "me" };
      if (group) this.emit("group.reaction", `group.reaction:${group}:${message.id}:${by}:${r.n}`, { group, ...fields });
      else this.emit("message.reaction", `message.reaction:${chat}:${message.id}:${by}:${r.n}`, { chat, ...fields });
    }
    if (changes.length) this.persist(key, changes);
  }

  /**
   * Relaxed: nobody waits for it, and a note lost to a power cut is made again from the history at the next start
   * (its event is then reported a second time, as after a crash between a message's row and its note). A disk sync
   * for each one held the whole daemon for milliseconds, three times per message sent.
   */
  private persist(chat: string, changes: [string, string | null][]): void {
    const tx = this.db.transaction(SEEN, "readwrite", { durability: "relaxed" });
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

/** What a received button press adds to its delivery in the seen set (`received+p`): it is reported once. */
const PRESSED = "+p";
/** What a group message that mentions me adds (`received+m`): a mention learned late is reported once. */
const MENTIONED = "+m";
/** The seen set's own notes: whether it notes mentions (sets from before `+m` do not). */
const FORMAT = "format:";
const MENTIONS_NOTED = "mentions";
/** The seen set's mark that its notes carry their time. */
const AGES_NOTED = "ages";

/**
 * A note: what the seen set keeps of a message (or a reaction's number), then `@` and the time of its last activity in
 * base 36 (`received+p#e2@mg3k1x2a`), by which `sweep` drops it. A note from before has no time.
 */
const noteOf = (state: string, at: number): string => `${state}@${Math.max(0, Math.floor(at)).toString(36)}`;
function stateIn(note: string): string {
  const at = note.lastIndexOf("@");
  return at === -1 ? note : note.slice(0, at);
}
function timeIn(note: string): number | undefined {
  const at = note.lastIndexOf("@");
  return at === -1 ? undefined : parseInt(note.slice(at + 1), 36);
}
/** The last time a message changed here: it came, it was edited, someone reacted. */
function activityOf(message: StoredMessage): number {
  let at = Math.max(message.timestamp, message.edit?.at ?? 0);
  for (const r of Object.values(message.reactions ?? {})) at = Math.max(at, r.at ?? 0);
  return at;
}
/** A message that will not change by itself any more: received, or mine and delivered. */
function settled(state: string): boolean {
  const delivery = splitState(state)[0].split("+")[0];
  return delivery === "received" || delivery === "delivered";
}

/**
 * What the seen set keeps of a message: its delivery (`+p` once a press on a message of mine was reported, `+m` once a
 * group message's mention of me was), and its edit number once edited (`sent#e3`, `received+p+m#e2`).
 */
function stateOf(message: StoredMessage): string {
  const peer = message.sender === "peer";
  const delivery = deliveryOf(message) + (peer && message.press ? PRESSED : "") + (peer && message.mentioned && message.linkId.startsWith("group:") ? MENTIONED : "");
  return message.edit ? `${delivery}#e${message.edit.seq}` : delivery;
}
const flagsOf = (state: string): string[] => splitState(state)[0].split("+").slice(1).map((flag) => "+" + flag);
const pressedIn = (state: string): boolean => flagsOf(state).includes(PRESSED);
const mentionedIn = (state: string): boolean => flagsOf(state).includes(MENTIONED);
/** The state with a flag added before its edit number. */
function withFlag(state: string, flag: string): string {
  const at = state.lastIndexOf("#e");
  return at === -1 ? state + flag : state.slice(0, at) + flag + state.slice(at);
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

/**
 * The journal's whole lines within its last `JOURNAL_MAX_BYTES`, and its size: never the whole file as one string, so
 * a journal grown past what a string can hold (or a trim's bound) is still read, and in bounded time.
 */
function journalTail(path: string): { lines: string[]; size: number } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    // From one byte before the cut, so a line that begins exactly at it is kept whole.
    const from = Math.max(0, size - JOURNAL_MAX_BYTES - 1);
    const buffer = Buffer.alloc(size - from);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, from + read);
      if (!n) break;
      read += n;
    }
    const lines = buffer.toString("utf8", 0, read).split("\n");
    if (from > 0) lines.shift();
    return { lines: lines.filter(Boolean), size };
  } finally {
    closeSync(fd);
  }
}
