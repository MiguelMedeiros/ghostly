import { appendFileSync, closeSync, existsSync, fstatSync, ftruncateSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import type { AppFrameEvent } from "@ghostly/core";
import type { EngineClientSink } from "@ghostly/browser/engine/server";
import type { EngineEvent, RpcResponse } from "@ghostly/browser/shared/rpc";
import type { EngineState, FileTransferView, GroupView, LinkView, PinView, StoredMessage } from "@ghostly/browser/shared/types";
import { chatJson, chatMessageJson, groupJson, groupMessageJson, type MessageJson } from "./views";
import { paymentJson } from "./wallets";

/**
 * The event stream (WISP 1100 § Event stream): what happened, derived from the engine's own events, one JSON object
 * each, with a `seq` that grows across restarts and an `id` stable for the fact it reports.
 */
export interface GhostlyEvent { seq: number; id: string; type: string; at: number; [field: string]: unknown }

/** Events the journal keeps for `listen --since`. */
export const JOURNAL_KEEP = 10_000;
/**
 * Seqs reserved ahead in `<journal>.reserved` (`EventHub.reserve`): a new reservation is written when fewer than half
 * of them are left, so the mark is rewritten once per 128 events, and a full disk that refuses it still leaves 128.
 */
export const SEQS_RESERVED = 256;
/** Bytes the journal keeps at most: a contact's long texts never make it too large to read. */
export const JOURNAL_KEEP_BYTES = 16 * 1024 * 1024;
/** A journal past this is trimmed, and only this much of its end is ever read. */
export const JOURNAL_MAX_BYTES = 2 * JOURNAL_KEEP_BYTES;
/**
 * Up to this many ids removed at once, the journal's bytes are searched for each (`forget`); more are matched against
 * each line once, read whole: 2,000 ids searched line by line held a daemon 12 s on a journal of 10,000 events.
 */
const FORGET_SEARCHED_IDS = 16;
const SEEN_DB = "ghostly-cli";
const SEEN = "seen";

/**
 * How long the seen set keeps the note of a settled message after its last activity (its arrival, its edit, a reaction),
 * each as this device's clock has it: older notes are dropped, and a message that came here longer ago with no note is
 * no news. A daemon kept a note per
 * message of its whole history in memory, for as long as it ran.
 */
export const SEEN_KEEP_MS = 30 * 86_400_000;
/** How often a daemon drops the notes that passed `SEEN_KEEP_MS`. */
const SWEEP_EVERY_MS = 6 * 3_600_000;

/** How long a `file.*` event waits for the message that carries its file. */
export const FILE_MESSAGE_WAIT_MS = 2_000;

/**
 * The notice an app sends when a chat first goes live (apps/ui/src/hooks/useChat.ts): shown as a line, not a message.
 * The contact's only on the row the engine took as their joined line (`StoredMessage.joinLine`).
 */
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
  /**
   * The last seq the journal dropped (a trim, a journal set aside), kept in `<journal>.dropped`: a replay from before it
   * starts with `events.gap`. What the person removed (`forget`) leaves holes after it, which are none.
   */
  private dropped = 0;
  /** Whether `<journal>.dropped` is written: before `forget` first takes a journal's first events, it must be. */
  private marked = false;
  /** Whether `dropped` is ahead of `<journal>.dropped` (a full disk refused it): the next event's write tries it again. */
  private markOwed = false;
  /**
   * The highest seq `<journal>.reserved` holds: no event is told a seq past it before the mark says so, and a start
   * numbers on from it. A full disk can take an event and its `.dropped` mark both, after it was told; the next start
   * then never gives its seq again, and a replay across it says `events.gap`. A stop gives back what it did not use.
   */
  private reserved = 0;
  /** Typing changes told this run: a change's id carries it, as it takes no seq of its own (`emitLive`). */
  private typingChanges = 0;
  private journalLines = 0;
  private journalBytes = 0;
  /**
   * Where the journal first names each chat, group and message (`namedIn`), by the hash of the id as written
   * (`hashOfId`; two ids that share one only read more), so `forget` reads it from there on: each deletion read the
   * whole journal (up to 32 MiB) from disk and searched it, a contact's delete for everyone included. Built from the
   * journal at the first `forget`, kept by `emit`; null again once lines move (a trim, a rewrite).
   */
  private firstNamed: Map<number, number> | null = null;
  /** The journal's size `firstNamed` covers: another size (a write it did not see) builds it again. */
  private namedSize = 0;
  /** Where the first line that cannot be read is, which `forget` reads from too: it may name what is removed. */
  private unreadableAt = Infinity;
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
    const reserved = readDropped(this.journalPath + ".reserved") ?? 0;
    try {
      const dropped = readDropped(this.journalPath + ".dropped");
      if (existsSync(this.journalPath)) {
        const { seq, first, lines, size, tail } = journalEnd(this.journalPath);
        this.journalLines = lines;
        this.journalBytes = size;
        this.seq = seq;
        // No mark (the journal never lost its first events since it had one, or it is from before marks): what is
        // missing before its first event counts as dropped.
        this.dropped = dropped ?? (first === undefined ? seq : first - 1);
        this.marked = dropped !== undefined;
        // A last line with no newline (a power cut mid-write): the next event must not be appended to it. A whole event
        // is ended; a cut one goes, and its seq, told to listeners before the cut, is not given again: a replay past it
        // says `events.gap`.
        let ended = false;
        if (tail?.whole) try { appendFileSync(this.journalPath, "\n"); this.journalBytes++; ended = true; } catch { /* cut instead */ }
        if (tail && !ended) {
          truncateSync(this.journalPath, tail.at);
          this.journalLines--;
          this.journalBytes = tail.at;
          const lost = tail.whole ? seq : tail.seq !== undefined && tail.seq > seq ? tail.seq : undefined;
          if (lost !== undefined) { this.seq = lost; this.markDropped(Math.max(this.dropped, lost)); }
        }
        if (this.journalBytes > JOURNAL_MAX_BYTES || this.journalLines > JOURNAL_KEEP * 2) this.trimJournal();
      } else if (dropped !== undefined) rmSync(this.journalPath + ".dropped", { force: true });
    } catch (error) {
      process.stderr.write(`ghostly: the event journal could not be read, a new one begins: ${error instanceof Error ? error.message : String(error)}\n`);
      try { renameSync(this.journalPath, this.journalPath + ".unreadable"); } catch { /* best effort */ }
      this.journalLines = 0;
      this.journalBytes = 0;
      this.markDropped(this.seq);
    }
    // Seqs the last run reserved and did not give back (a crash, or a stop that could not write): some may have been told
    // with no line here. None is given again, and a replay across them says `events.gap`.
    this.reserved = reserved;
    if (reserved > this.seq) {
      this.seq = reserved;
      this.markDropped(Math.max(this.dropped, reserved));
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
   * and from the store. A message of mine still on its way (or failed, which a retry sends again) keeps its note. The
   * 30 days count back from the newest activity the set knows when the clock reads later than it: a clock run ahead (a
   * wrong RTC, a VM restored with a skewed clock) would otherwise drop the notes of the recent history, which the next
   * start with the clock right reports again.
   */
  sweep(): number {
    let newest = 0;
    for (const [chat, known] of this.seen) {
      if (chat === FORMAT || chat.startsWith("said:")) continue;
      for (const note of known.values()) newest = Math.max(newest, timeIn(note) ?? 0);
    }
    const cutoff = Math.min(this.now(), newest) - SEEN_KEEP_MS;
    let dropped = 0;
    for (const [chat, known] of this.seen) {
      if (chat === FORMAT || chat === UNDERWAY || chat.startsWith("said:")) continue;
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
      if (note === undefined && cameAt(message) < cutoff && activityOf(message) < cutoff) return true;
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

  /**
   * Events after `since` still in the journal; a gap event where ones up to `dropped` are missing (a trim, a full disk
   * that took none of them). The events of what the person removed (`forget`) after it are no gap: they are not here on
   * purpose.
   */
  replay(since: number): GhostlyEvent[] {
    if (since >= this.seq) return [];
    const out: GhostlyEvent[] = [];
    let before = since;
    const gapTo = (next: number) => {
      if (next > before + 1 && before < this.dropped)
        out.push({ seq: before, id: `events.gap:${before}:${next}`, type: "events.gap", at: this.now(), from: before + 1, to: Math.min(this.dropped, next - 1) });
    };
    if (existsSync(this.journalPath)) for (const line of journalTail(this.journalPath).lines) {
      let event: GhostlyEvent;
      try { event = JSON.parse(line) as GhostlyEvent; } catch { continue; /* torn */ }
      if (event.seq <= before) continue;
      gapTo(event.seq);
      out.push(event);
      before = event.seq;
    }
    // The last events, never written: a gap up to the next one.
    gapTo(Math.min(this.dropped, this.seq) + 1);
    return out;
  }

  /**
   * Notes that the journal no longer holds the events up to `seq`. Written before the journal is: a stop in between
   * leaves the mark ahead of the journal (a gap said where none was), never behind it (a gap not said).
   */
  private markDropped(seq: number): void {
    this.dropped = seq;
    // Through a copy: a full disk leaves the mark it had, never an empty one (no mark, a gap not said).
    try {
      writeFileSync(this.journalPath + ".dropped.tmp", String(seq), { mode: 0o600 });
      renameSync(this.journalPath + ".dropped.tmp", this.journalPath + ".dropped");
      this.marked = true;
      this.markOwed = false;
    } catch (error) {
      // A full disk refuses the copy (a new file), not a rewrite of the mark there: that takes no new block.
      try {
        writeMark(this.journalPath + ".dropped", seq, false);
        this.marked = true;
        this.markOwed = false;
      } catch {
        this.markOwed = true;
        process.stderr.write(`ghostly: event journal error: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }

  /**
   * Reserves seqs ahead of the one about to be told, in `<journal>.reserved`, rewritten where it is (no new block, so a
   * full disk takes it): written before the event goes anywhere, as `markDropped` is. Refused, the event still goes
   * (the reservation made before covers the next ones), and the next event tries again.
   */
  private reserve(): void {
    if (this.reserved - this.seq >= SEQS_RESERVED / 2) return;
    try {
      writeMark(this.journalPath + ".reserved", this.seq + SEQS_RESERVED, true);
      this.reserved = this.seq + SEQS_RESERVED;
    } catch (error) {
      process.stderr.write(`ghostly: event journal error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  /**
   * At a stop: the seqs reserved past the last one told are given back, so the next start numbers on from it, with no
   * jump. Not written (a disk that takes no rewrite either), the next start numbers past the reservation instead.
   */
  release(): void {
    if (this.reserved <= this.seq) return;
    try {
      writeMark(this.journalPath + ".reserved", this.seq, true);
      this.reserved = this.seq;
    } catch (error) {
      process.stderr.write(`ghostly: event journal error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  get lastSeq(): number { return this.seq; }

  /** Emits an event the host makes itself (`daemon.started`). */
  emit(type: string, id: string, fields: Record<string, unknown> = {}): GhostlyEvent {
    const event: GhostlyEvent = { seq: ++this.seq, id, type, at: this.now(), ...fields };
    this.reserve();
    // The journal failing never keeps an event from the listeners.
    let written = false;
    try {
      // A mark a full disk refused goes first, as `markDropped` would have it: ahead of the journal.
      if (this.markOwed) this.markDropped(this.dropped);
      const line = Buffer.from(JSON.stringify(event) + "\n");
      const at = appendWhole(this.journalPath, line);
      written = true;
      if (this.firstNamed && at === this.namedSize) {
        for (const id of namedIn(event)) if (!this.firstNamed.has(hashOfId(id))) this.firstNamed.set(hashOfId(id), at);
        this.namedSize = at + line.length;
      } else this.firstNamed = null;
      this.journalBytes += line.length;
      if (++this.journalLines > JOURNAL_KEEP * 2 || this.journalBytes > JOURNAL_MAX_BYTES) this.trimJournal();
    } catch (error) {
      process.stderr.write(`ghostly: event journal error: ${error instanceof Error ? error.message : String(error)}\n`);
      // Not in the journal (a full disk): a replay past it says `events.gap`.
      if (!written) this.markDropped(Math.max(this.dropped, event.seq));
    }
    this.tell(event);
    return event;
  }

  /**
   * An event for the listeners only, never the journal: a contact's app frames, live only (WISP 1200), which at the
   * receiver's rate would push every other chat's events out of it in seconds, and typing, which lasts seconds. It takes no seq of its own but the last
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
    const first = firstSeq(kept);
    this.markDropped(Math.max(this.dropped, first === undefined ? this.seq : first - 1));
    this.firstNamed = null;
    writeFileSync(this.journalPath + ".tmp", kept.length ? kept.join("\n") + "\n" : "", { mode: 0o600 });
    renameSync(this.journalPath + ".tmp", this.journalPath);
    this.journalLines = kept.length;
    this.journalBytes = bytes;
  }

  /**
   * What was removed here leaves the journal too: the events that name it are blanked, or the journal is written again
   * without them (a line that names it and cannot be read goes as well), and a journal set aside as unreadable, which
   * cannot be sorted, is deleted. `ids`: what was removed (a message's id, a chat's or a group's); `gone`: whether an
   * event is of it; `unquote`: an event that stays, written again without what it quotes of the removed (a reply's
   * event), else none.
   */
  private forget(ids: readonly string[], gone: (event: GhostlyEvent) => boolean, unquote: (event: GhostlyEvent) => GhostlyEvent | undefined = () => undefined): void {
    if (!ids.length) return;
    try {
      rmSync(this.journalPath + ".unreadable", { force: true });
      if (!existsSync(this.journalPath)) return;
      // Only from the first line that names one of them on, and nothing when none does.
      const named = this.namedFrom(ids);
      if (named === undefined) return;
      let { bytes, start, at } = journalWindow(this.journalPath, named);
      // A few ids: looked for in the bytes, and only the lines that name one are read. None named: nothing to write.
      // Many (a chat removed with its history, a long change): every line is read once, against all of them at once.
      const needles = ids.map((id) => JSON.stringify(id)), few = ids.length <= FORGET_SEARCHED_IDS;
      const names = (line: string) => needles.some((needle) => line.includes(needle));
      // What changes: each line's bounds in `bytes`, and what it becomes (null: it goes).
      const edits: { from: number; to: number; line: string | null }[] = [];
      for (const [from, to] of few ? linesNaming(bytes, start, needles) : linesOf(bytes, start)) {
        const line = bytes.toString("utf8", from, to);
        let event: GhostlyEvent;
        // A line that names one and cannot be read goes.
        try { event = JSON.parse(line) as GhostlyEvent; } catch { if (few || names(line)) edits.push({ from, to, line: null }); continue; }
        if (gone(event)) { edits.push({ from, to, line: null }); continue; }
        const written = unquote(event);
        if (written) edits.push({ from, to, line: JSON.stringify(written) });
      }
      if (!edits.length) return;
      // Without a mark, the next start would take the events removed at the journal's start for dropped ones.
      if (!this.marked) this.markDropped(this.dropped);
      // A few lines are written over where they are: one that goes as spaces (a blank no reader takes for an event, and
      // the next trim drops), a quote taken out padded to its line. The journal written again for each deletion was up to
      // 16 MiB and 95 ms of a blocked daemon.
      if (few && edits.every(({ from, to, line }) => line === null || Buffer.byteLength(line) <= to - from)) {
        const fd = openSync(this.journalPath, "r+");
        try {
          for (const { from, to, line } of edits) {
            const over = Buffer.alloc(to - from, " ");
            if (line !== null) over.write(line);
            for (let done = 0; done < over.length;) done += writeSync(fd, over, done, over.length - done, at + from + done);
          }
        } finally {
          closeSync(fd);
        }
        return;
      }
      // Written again whole: what came before the lines read is read too, and every line after the first edit moves.
      this.firstNamed = null;
      if (start === 0 && at > 0) {
        const window = journalWindow(this.journalPath);
        for (const edit of edits) { edit.from += at - window.at; edit.to += at - window.at; }
        ({ bytes, start, at } = window);
      }
      const parts: Buffer[] = [];
      let from = start, removed = 0;
      for (const edit of edits) {
        parts.push(bytes.subarray(from, edit.from));
        if (edit.line === null) removed++;
        else parts.push(Buffer.from(edit.line));
        from = edit.line === null ? edit.to + 1 : edit.to;
      }
      parts.push(bytes.subarray(from));
      const written = Buffer.concat(parts);
      writeFileSync(this.journalPath + ".tmp", written, { mode: 0o600 });
      renameSync(this.journalPath + ".tmp", this.journalPath);
      this.journalLines -= removed;
      this.journalBytes = written.length;
    } catch (error) {
      this.firstNamed = null;
      process.stderr.write(`ghostly: event journal error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  /**
   * The first place in the journal a line may name one of these ids (`namedIn`), or undefined when none does. The
   * first call reads the journal for it once.
   */
  private namedFrom(ids: readonly string[]): number | undefined {
    if (!this.firstNamed || statSync(this.journalPath).size !== this.namedSize) {
      // In the bytes, never made into text: each value of a key `namedIn` reads (and of any `id`), by its hash.
      const { bytes, start, at, size } = journalWindow(this.journalPath);
      const firstNamed = new Map<number, number>();
      for (const key of NAMING_KEYS) {
        for (let found = bytes.indexOf(key, start); found !== -1; found = bytes.indexOf(key, found + key.length)) {
          const open = found + key.length;
          if (bytes[open] !== 0x22) continue;
          let close = open + 1;
          while (close < bytes.length && bytes[close] !== 0x22 && bytes[close] !== 0x0a) close += bytes[close] === 0x5c ? 2 : 1;
          if (bytes[close] !== 0x22) continue;
          const hash = hashOf(bytes, open, close + 1), line = at + Math.max(start, bytes.lastIndexOf(0x0a, found) + 1);
          if ((firstNamed.get(hash) ?? Infinity) > line) firstNamed.set(hash, line);
        }
      }
      // A line cut short (not `{…}`) cannot be read for what it names.
      this.unreadableAt = Infinity;
      for (const [from, to] of linesOf(bytes, start)) {
        if (bytes[from] === 0x7b && bytes[to - 1] === 0x7d) continue;
        if (bytes.subarray(from, to).some((byte) => byte !== 0x20)) { this.unreadableAt = at + from; break; }
      }
      this.firstNamed = firstNamed;
      this.namedSize = size;
    }
    let from = this.unreadableAt;
    for (const id of ids) from = Math.min(from, this.firstNamed.get(hashOfId(id)) ?? Infinity);
    return from === Infinity ? undefined : from;
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
      // is a start again (its id then carries a count, so two changes in one millisecond stay apart). Live only, as app
      // frames are: it lasts seconds, and at the rate a contact may change it, it would push the other chats' events out
      // of the journal.
      if (shape.typing !== before.typing) {
        this.emitLive(shape.typing ? "typing.started" : "typing.stopped", `typing.${shape.typing ? "started" : "stopped"}:${id}:${this.now()}`, { chat: id, ...(shape.typing ? typingFields(shape) : {}) });
      } else if (shape.typing && (shape.typingKind !== before.typingKind || shape.typingStatus !== before.typingStatus)) {
        this.emitLive("typing.started", `typing.started:${id}:${this.now()}:${++this.typingChanges}`, { chat: id, ...typingFields(shape) });
      }
    }
    const removedChats = [...this.chats.keys()].filter((id) => !links.has(id));
    for (const id of removedChats) {
      this.chats.delete(id);
      if (!quiet) this.emit("chat.removed", `chat.removed:${id}`, { chat: id });
    }
    // A chat removed deletes its history here: its events go too, but for its removal.
    const chatsGone = new Set(removedChats);
    this.forget(removedChats, (event) => chatsGone.has(event.chat as string) && event.type !== "chat.removed");
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
      // A member started or stopped writing in a private group (WISP 902 · Group Mesh § Typing), as `typing.*` in a chat,
      // live only too.
      for (const [member, word] of Object.entries(shape.typing)) {
        const was = before.typing[member];
        if (was && was.kind === word.kind && was.status === word.status) continue;
        this.emitLive("group.typing.started", `group.typing.started:${id}:${member}:${this.now()}${was ? `:${++this.typingChanges}` : ""}`, { group: id, member, ...word });
      }
      for (const member of Object.keys(before.typing)) {
        if (!shape.typing[member]) this.emitLive("group.typing.stopped", `group.typing.stopped:${id}:${member}:${this.now()}`, { group: id, member });
      }
    }
    const removedGroups = [...this.groups.keys()].filter((id) => !groups.has(id));
    for (const id of removedGroups) {
      this.groups.delete(id);
      if (!quiet) this.emit("group.removed", `group.removed:${id}`, { group: id });
    }
    // A group left or forgotten: the same.
    const groupsGone = new Set(removedGroups);
    this.forget(removedGroups, (event) => groupsGone.has(event.group as string) && event.type !== "group.removed");
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
        // A proof can come back to a status it had (a record removed and restored, a re-share after a withdraw): each
        // change is a new fact, so its id carries the time and the sequence, as a typing change does.
        const id = before === undefined ? `identity.received:${key}:${shape}` : `identity.status:${key}:${shape}:${this.now()}:${this.seq + 1}`;
        this.emit(before === undefined ? "identity.received" : "identity.status", id, {
          chat: link.id, identity: { id: identity.id, provider: identity.provider, subject: identity.subject, status: identity.status, verified: identity.verified, error: identity.error ?? null },
        });
      }
    }
    for (const [id, transfer] of Object.entries(state.transfers ?? {})) this.transferChanged(id, transfer, state, quiet);
    this.state = state;
    for (const listener of this.stateListeners) {
      try { listener(state); } catch { /* its own */ }
    }
  }

  /**
   * A transfer's `file.*` event, when its shape changed. One under way is noted in the seen set until its end is told:
   * one that ends while no hub watches (a stop, a start before the baseline) is told by the next start, at its baseline
   * or from its record (`ended`), once. `quiet`: the baseline, which tells only those ends.
   */
  private transferChanged(id: string, transfer: FileTransferView, state: EngineState, quiet: boolean): void {
    const shape = `${transfer.state}|${transfer.stage ?? ""}`, before = this.transfers.get(id);
    this.transfers.set(id, shape);
    const end = transfer.state === "done" || transfer.state === "failed", underway = this.seen.get(UNDERWAY)?.has(id) ?? false;
    if (!end && !underway) {
      this.seenOf(UNDERWAY).set(id, "yes");
      this.persist(UNDERWAY, [[id, "yes"]]);
    }
    if ((quiet && !(end && underway)) || before === shape) return;
    const chat = state.links.find((l) => id.startsWith(`${l.id}-`))?.id ?? null;
    // A group's file (WISP 503) names its group.
    const group = chat ? undefined : state.groups.find((g) => id.startsWith(`group-${g.id}-`))?.id;
    const fields = { chat, ...(group ? { group } : {}), file: id, direction: transfer.direction ?? (id.includes("-in-") ? "in" : "out"), size: transfer.size, transferred: transfer.transferred, ...(transfer.error ? { error: transfer.error } : {}) };
    // An end told is no longer under way: its note goes as it is told (one still waiting for its message at a stop stays).
    const told = () => {
      if (!this.seen.get(UNDERWAY)?.delete(id)) return;
      this.persist(UNDERWAY, [[id, null]]);
    };
    let emit: ((messageId: string | null) => void) | null = null;
    if (transfer.state === "done") { const key = `file.done:${id}`; emit = (messageId) => { told(); this.emit("file.done", key, { ...fields, messageId }); }; }
    else if (transfer.state === "failed") { const key = `file.failed:${id}:${this.now()}`; emit = (messageId) => { told(); this.emit("file.failed", key, { ...fields, messageId, retry: !!transfer.retry }); }; }
    else if (transfer.stage === "asking" && fields.direction === "in") { const key = `file.offered:${id}:${this.now()}`; emit = (messageId) => this.emit("file.offered", key, { ...fields, messageId, room: transfer.room ?? null }); }
    else if (transfer.stage) {
      const key = `file.stage:${id}:${transfer.stage}:${this.now()}`, stage = { stage: transfer.stage, ...(transfer.pausedBy ? { pausedBy: transfer.pausedBy } : {}) };
      emit = (messageId) => this.emit("file.stage", key, { ...fields, messageId, ...stage });
    }
    if (emit) this.fileEvent(id, emit, chat ?? (group ? `group:${group}` : null));
  }

  /**
   * After the baseline, before the sink is attached: the transfers noted under way that the engine's state no longer
   * shows. A finished file has no transfer there after a restart, only its record (`stored`): one that ended while the
   * daemon stopped is told now. A record gone (the file deleted) drops its note.
   */
  async ended(stored: (fileId: string) => Promise<{ direction?: "in" | "out"; transfer?: FileTransferView } | undefined>): Promise<void> {
    const state = this.state;
    if (!state) return;
    for (const id of [...this.seen.get(UNDERWAY)?.keys() ?? []]) {
      if (state.transfers?.[id]) continue;
      let record;
      try { record = await stored(id); } catch { continue; /* asked again at the next start */ }
      if (!record) {
        this.seen.get(UNDERWAY)?.delete(id);
        this.persist(UNDERWAY, [[id, null]]);
        continue;
      }
      const transfer = record.transfer;
      if (transfer?.state !== "done" && transfer?.state !== "failed") continue;
      this.transferChanged(id, { ...transfer, ...(record.direction ? { direction: record.direction } : {}) }, state, true);
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
      if (before === undefined && cameAt(message) < cutoff) {
        // Came here longer ago than `SEEN_KEEP_MS`, with no note: its note was dropped (or it came, that long ago, while
        // nothing ran). No news, and no note again, unless it was active since: then an edit since is reported, once.
        // Both by this device's clock: a line read a month after its commit, an edit its author's clock dates a month
        // back, came here now.
        if (at < cutoff) continue;
        const noted = noteOf(state, at);
        known.set(message.id, noted);
        changes.push([message.id, noted]);
        const edit = message.edit;
        if (quiet || !edit || editedAt(edit) < cutoff || (message.sender === "me" && edit.restore)) continue;
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
          // The contact's joined line is the row the engine took as it (`joinLine`), as the app draws it: any other row of
          // theirs in those words is a message. Mine by the words.
          const notice = (message.sender === "me" || message.joinLine) ? JOIN_NOTICE.exec(message.text) : null;
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
    // its deletion stays. A group's history gone whole (left, forgotten) takes every message event of the group. A
    // reply to it stays, its quote as history gives it ("Original message deleted"): no text of the original.
    const whole = !!group && !deleted && messages.length === 0 && gone.length > 0, goneIds = new Set(gone);
    const here = (event: GhostlyEvent) => (group ? event.group === group : event.chat === chat);
    this.forget(whole ? [group] : gone, (event) => here(event) && !event.type.endsWith(".deleted") && (whole
      ? "message" in event || "messageId" in event || "replyId" in event
      : goneIds.has(event.messageId as string) || goneIds.has((event.message as { id?: string } | undefined)?.id as string) || goneIds.has(event.replyId as string)),
    (event) => {
      const message = event.message as MessageJson | undefined;
      if (whole || !here(event) || !message?.replyTo || !goneIds.has(message.replyTo.id) || message.replyTo.deleted) return;
      return { ...event, message: { ...message, replyTo: { ...message.replyTo, snippet: "", found: false, deleted: true } } };
    });
    // After the message's own event: what waited for it goes now.
    for (const [fileId, messageId] of files) this.flushFile(fileId, messageId);
  }

  /**
   * A press on a button of a message of mine (WISP 406 · Message Buttons), after the reply's own event: the question
   * (`messageId`), the button, its label, who pressed (`by`: the chat, or a group member's key), `name` (the label this
   * profile gave the chat, as `chat list` gives it; null without one, and in a group) and the reply (`replyId`).
   * `untrusted.name` is the name the person gave themselves, as an agent turn's: theirs to choose, so data, never
   * instructions, and under `untrusted` only. The engine marks a reply a press only while the buttons were open for
   * that person.
   */
  private pressed(chat: string, group: string | null, message: StoredMessage, json: { nick: string | null }): void {
    const press = message.press!;
    const link = group ? undefined : this.state?.links.find((l) => l.id === chat);
    const name = link ? chatJson(link).label : null;
    this.emit("button.pressed", `button.pressed:${group ?? chat}:${message.id}`, {
      ...(group ? { group } : { chat }), messageId: press.messageId, button: press.button, label: press.label,
      by: group ? message.member ?? null : chat, name, replyId: message.id, ...(press.inferred ? { inferred: true } : {}),
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
/** The seen set's notes of the transfers seen under way whose end was not told yet, by file id. */
const UNDERWAY = "files:";

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
/**
 * When a message came here: its place (a received row's is when it was stored here), or for a group's line, whose place
 * is its commit's moment, when this device stored it (`heardAt`; absent on lines stored before it).
 */
function cameAt(message: StoredMessage): number {
  return Math.max(message.timestamp, message.heardAt ?? 0);
}
/** When an edit came here: a contact's or member's is dated by their clock (`at`), and taken here at `heardAt`. */
function editedAt(edit: NonNullable<StoredMessage["edit"]>): number {
  return Math.max(edit.at, edit.heardAt ?? 0);
}
/** The last time a message changed here: it came, it was edited, someone reacted. */
function activityOf(message: StoredMessage): number {
  let at = Math.max(cameAt(message), message.edit ? editedAt(message.edit) : 0);
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
 * a journal grown past what a string can hold (or a trim's bound) is still read, and in bounded time. Lines `forget`
 * blanked are left out.
 */
function journalTail(path: string): { lines: string[]; size: number } {
  const { bytes, start, size } = journalWindow(path);
  return { lines: bytes.toString("utf8", start).split("\n").filter((line) => line.trimStart()), size };
}

/**
 * What opening needs of the journal: its last seq, its number of lines (as `journalTail` counts them) and its size. The
 * lines are counted by their bytes and only the last whole one is made into text.
 */
function journalEnd(path: string): { seq: number; first: number | undefined; lines: number; size: number; tail: JournalTail | undefined } {
  const { bytes, start, size } = journalWindow(path);
  let lines = 0;
  for (let from = start; from < bytes.length;) {
    const end = bytes.indexOf(0x0a, from);
    const stop = end === -1 ? bytes.length : end;
    if (stop > from) lines++;
    from = stop + 1;
  }
  let first: number | undefined;
  for (let from = start; from < bytes.length && first === undefined;) {
    const end = bytes.indexOf(0x0a, from);
    const stop = end === -1 ? bytes.length : end;
    if (stop > from) first = firstSeq([bytes.toString("utf8", from, stop)]);
    from = stop + 1;
  }
  let seq = 0, read = -1;
  for (let stop = bytes.length; stop > start;) {
    const from = Math.max(start, bytes.lastIndexOf(0x0a, stop - 1) + 1);
    if (from < stop) {
      try { seq = (JSON.parse(bytes.toString("utf8", from, stop)) as GhostlyEvent).seq; read = from; break; } catch { /* a torn last line */ }
    }
    stop = from - 1;
  }
  let tail: JournalTail | undefined;
  if (bytes.length > start && bytes[bytes.length - 1] !== 0x0a) {
    const from = Math.max(start, bytes.lastIndexOf(0x0a) + 1);
    // Only the start of a cut line is made into text, for the seq it names.
    const named = /^\{"seq":(\d+)[,}]/.exec(bytes.toString("latin1", from, Math.min(bytes.length, from + 32)))?.[1];
    tail = { at: size - bytes.length + from, whole: read === from, seq: named === undefined ? undefined : Number(named) };
  }
  return { seq, first, lines, size, tail };
}

/** The journal's last line when it has no newline: where it begins, whether it is a whole event, and the seq it names. */
interface JournalTail { at: number; whole: boolean; seq: number | undefined }

/** The seq of the first of these lines that can be read. */
function firstSeq(lines: readonly string[]): number | undefined {
  for (const line of lines) {
    try { const { seq } = JSON.parse(line) as GhostlyEvent; if (typeof seq === "number") return seq; } catch { /* torn */ }
  }
  return undefined;
}

/**
 * The journal's dropped mark (`EventHub.dropped`) or its reserved one (`EventHub.reserved`), or undefined when there is
 * none (a journal from before it).
 */
function readDropped(path: string): number | undefined {
  try {
    const seq = Number(readFileSync(path, "utf8").trim());
    return Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined;
  } catch { return undefined; }
}

/**
 * Writes a mark over the one there, as a line of fixed width (`000…0042`, which `readDropped` reads, v1.10's too): a
 * rewrite never grows the file past its first block, so a full disk takes it, and one cut short leaves the new mark's
 * first digits before the old one's last, never a number below the old one when the mark grows. `create`: a file that
 * is not there is made (a first start).
 */
function writeMark(path: string, seq: number, create: boolean): void {
  const line = Buffer.from(String(seq).padStart(19, "0") + "\n");
  let fd: number;
  try { fd = openSync(path, "r+"); } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    fd = openSync(path, "wx", 0o600);
  }
  try {
    for (let at = 0; at < line.length;) at += writeSync(fd, line, at, line.length - at, at);
  } finally {
    closeSync(fd);
  }
}

/**
 * Appends a line whole or not at all: what a full disk took of it is cut back (as the store's journal does), so the
 * next line, once there is room, starts a line of its own instead of making one no reader can parse with it. Returns
 * where the line begins in the file.
 */
function appendWhole(path: string, line: Buffer): number {
  const fd = openSync(path, "a", 0o600);
  let whole = -1;
  try {
    whole = fstatSync(fd).size;
    for (let at = 0; at < line.length;) at += writeSync(fd, line, at);
  } catch (error) {
    if (whole >= 0) try { ftruncateSync(fd, whole); } catch { /* the next start cuts it (`open`) */ }
    throw error;
  } finally {
    closeSync(fd);
  }
  return whole;
}

/**
 * The ids an event is of, as `forget`'s callers tell what is removed: its chat, its group, its message (`messageId`,
 * `message.id`), the reply that pressed it (`replyId`) and the message it quotes (`message.replyTo.id`).
 */
function namedIn(event: GhostlyEvent): string[] {
  const message = event.message as { id?: unknown; replyTo?: { id?: unknown } } | undefined;
  return [event.chat, event.group, event.messageId, event.replyId, message?.id, message?.replyTo?.id].filter((id): id is string => typeof id === "string");
}

/** The keys whose values `namedIn` reads, as a journal line has them: `id` stands for `message.id` and its quote's. */
const NAMING_KEYS = ['"chat":', '"group":', '"messageId":', '"replyId":', '"id":'].map((key) => Buffer.from(key));

/** FNV-1a of these bytes. */
function hashOf(bytes: Uint8Array, from = 0, to = bytes.length): number {
  let hash = 0x811c9dc5;
  for (let i = from; i < to; i++) hash = Math.imul(hash ^ bytes[i], 0x01000193);
  return hash >>> 0;
}

/** The hash of an id as a journal line writes it (quoted, escaped). */
const hashOfId = (id: string) => hashOf(Buffer.from(JSON.stringify(id)));

/** The bounds in `bytes` of each line from `start` on, its newline left out. */
function linesOf(bytes: Buffer, start: number): [number, number][] {
  const lines: [number, number][] = [];
  for (let from = start; from < bytes.length;) {
    const end = bytes.indexOf(10, from), to = end === -1 ? bytes.length : end;
    if (to > from) lines.push([from, to]);
    from = to + 1;
  }
  return lines;
}

/** The bounds in `bytes` of each line from `start` on that holds one of the needles, in their order, found in the bytes. */
function linesNaming(bytes: Buffer, start: number, needles: readonly string[]): [number, number][] {
  const lines = new Map<number, number>();
  for (const needle of needles) {
    for (let at = bytes.indexOf(needle, start); at !== -1;) {
      const from = Math.max(start, bytes.lastIndexOf(10, at) + 1), end = bytes.indexOf(10, at), to = end === -1 ? bytes.length : end;
      lines.set(from, to);
      at = end === -1 ? -1 : bytes.indexOf(needle, end + 1);
    }
  }
  return [...lines].sort(([a], [b]) => a - b);
}

/**
 * The bytes of the journal's last `JOURNAL_MAX_BYTES`, `start` where its first whole line begins in them, `at` where
 * they begin in the file, and its size. `lineAt`: where a line begins, read from there on when it is within them.
 */
function journalWindow(path: string, lineAt = 0): { bytes: Buffer; start: number; at: number; size: number } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    // From one byte before the cut, so a line that begins exactly at it is kept whole.
    const cut = Math.max(0, size - JOURNAL_MAX_BYTES - 1), from = Math.max(cut, lineAt);
    const buffer = Buffer.alloc(size - from);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, from + read);
      if (!n) break;
      read += n;
    }
    const bytes = buffer.subarray(0, read);
    // The line cut by the window is not whole: it is left out.
    return { bytes, start: from > cut || from === 0 ? 0 : bytes.indexOf(10) + 1 || bytes.length, at: from, size };
  } finally {
    closeSync(fd);
  }
}
