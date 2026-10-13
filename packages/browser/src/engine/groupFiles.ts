import {
  ChatFiles,
  GROUP_FILE_LIMITS,
  GROUP_HAVE_FRAME,
  GROUP_WANT_FRAME,
  GROUP_WANT_NO_FRAME,
  RateWindow,
  fetchesByItself,
  fileMessageText,
  groupFileFallback,
  isGroupMessageId,
  randomBytes,
  readGroupHave,
  readGroupWant,
  readGroupWantNo,
  toBase64Url,
  transferEnded,
  type FileInfo,
  type FileTransferRecord,
  type GroupFileMeta,
  type GroupWantRefusal,
  type IncomingTarget,
  type OfferDecision,
  type OutgoingSource,
} from "@ghostly/core";
import { fileBytes, fileBytesOf } from "../shared/fileBytes";
import { fileStore, type StoredFile } from "../shared/idb";
import { FileAppender, readStored, removeStored } from "../shared/storedFiles";
import type { FileTransferView, MessageFile } from "../shared/types";

/*
 * Files and voice messages in groups (WISP 503 · Group Files), the engine's side. A file is announced as a group message
 * carrying its description (`fl`); each member's app then fetches the bytes from a member that holds them, over
 * `files/3` on the edge between the two (`ChatFiles`, WISP 501): it sends `group-want`, the holder offers the file with
 * `gm` naming the message, and what arrives is checked against the author's digest. Whoever stored it holds it, and says
 * so (`group-have`), so a member away during the announcement gets it later from whoever is there.
 */

/** A group file's local id: its group's and a random part, never anything a member sends. */
export const groupFileId = (groupId: string, direction: "in" | "out", random = toBase64Url(randomBytes(12))) => `group-${groupId}-${direction}-${random}`;
/** The group a local file id names, among `groupIds`. */
export const groupOfFile = (fileId: string, groupIds: Iterable<string>): string | undefined =>
  [...groupIds].find(g => fileId.startsWith(`group-${g}-in-`) || fileId.startsWith(`group-${g}-out-`));

/** What a file's message says: its caption, or (when the author wrote none) the file itself, not the line older apps show. */
export const groupFileText = (text: string, meta: GroupFileMeta): string => text === groupFileFallback(meta) ? fileMessageText(meta) : text;

/** Where a group's files are kept: the profile's file store and file storage (`storedGroupFiles`), or a test's memory. */
export interface GroupFileStore {
  /** The records of a group's files (`linkId` `group:<id>`). */
  list(groupId: string): Promise<StoredFile[]>;
  /** Every group a stored file is of, whether or not this device still has the group. */
  groups(): Promise<string[]>;
  get(id: string): Promise<StoredFile | undefined>;
  put(file: StoredFile): Promise<void>;
  patch(id: string, fields: Pick<StoredFile, "transfer" | "group">): Promise<void>;
  /** The record and its bytes. */
  remove(id: string): Promise<void>;
  /**
   * Writes a file in order: from its first byte (whatever was there goes), or with `resume` after what an earlier
   * transfer stored (the writer's `offset`).
   */
  write(id: string, resume?: boolean): Promise<GroupFileWriter>;
  /** At most `length` bytes of a kept file from `offset`. */
  read(file: StoredFile, offset: number, length: number): Promise<Uint8Array>;
  /** Bytes this device can still take for files, or null when the platform does not say. */
  room(): Promise<number | null>;
}

export interface GroupFileWriter {
  /** Where it writes from: the bytes already stored. */
  offset: number;
  append(bytes: Uint8Array): Promise<void>;
  flush(): Promise<void>;
  /** SHA-256 of what was stored, read back from storage, base64url. */
  digest(): Promise<string>;
  /** Done writing for now: what is stored stays. */
  close(): Promise<void>;
  discard(): Promise<void>;
}

/** The profile's files store and file storage, as a 1:1 chat's files use them. */
export const storedGroupFiles: GroupFileStore = {
  list: groupId => fileStore.listForLink(`group:${groupId}`),
  groups: () => fileStore.groupIds(),
  get: id => fileStore.get(id),
  put: file => fileStore.put(file),
  patch: (id, fields) => fileStore.patch(id, fields),
  remove: id => removeStored(id),
  async write(id, resume = false) {
    const stored = await fileStore.get(id);
    const bytes = (stored?.bytes && await fileBytesOf(stored.bytes)) || await fileBytes();
    const size = await bytes.size(id);
    const offset = resume && size !== null ? size : 0;
    if (size !== null && size !== offset) await bytes.truncate(id, offset);
    if (stored && stored.bytes !== bytes.kind) await fileStore.patch(id, { bytes: bytes.kind });
    const appender = new FileAppender(bytes, id, offset);
    return {
      offset,
      append: chunk => appender.append(chunk),
      flush: () => appender.flush(),
      digest: async () => { await appender.close(); return bytes.digest(id); },
      close: () => appender.close(),
      discard: async () => { await appender.close().catch(() => {}); await bytes.remove(id); },
    };
  },
  read: (file, offset, length) => readStored(file, offset, length),
  room: async () => (await fileBytes()).room(),
};

/** What the engine gives the group files: where they are kept, their views, the profile's settings, an edge's files/3. */
export interface GroupFilesHost {
  store: GroupFileStore;
  transfers: Map<string, FileTransferView>;
  settings(): { autoDownloads: boolean; serveFiles: boolean };
  /** A files/3 frame on an edge's open session; false when it could not go. */
  sendFiles(linkId: string, frame: Record<string, unknown>): boolean;
  /** A file's bytes on an edge, in the form its session agreed (`GhostLink.sendFileData`, files/4). Absent: `pf-data` frames. */
  sendData?(linkId: string, id: string, offset: number, data: Uint8Array): boolean;
  /** Resolves once the edge's session can take another data frame. */
  writable?(linkId: string): Promise<void> | undefined;
}

/** Me in a group I am active in, and who could read one of its messages. */
export interface GroupFileMembership {
  me: string;
  community: boolean;
  inRoster(key: string): boolean;
  /** In the roster of the message's epoch and in the roster now (WISP 503 § Asking). */
  couldRead(key: string, messageId: string): boolean;
}

export interface GroupFileDeps extends GroupFilesHost {
  /** A group frame on an edge; false when it could not go. */
  send(linkId: string, frame: Record<string, unknown>): boolean;
  /** Member key → edge link id, for the group's edges. */
  edges(groupId: string): Map<string, string>;
  /** The edge is up, and the app at its other end announced group files (`GROUP_VERSION_FILES`). */
  ready(linkId: string): boolean;
  membership(groupId: string): GroupFileMembership | undefined;
  /** An application frame to everyone in a community. */
  sendApp(groupId: string, frame: Record<string, unknown>): Promise<void>;
  changed(): void;
  now(): number;
}

/** A group file this device knows of: one it announced, or one a member announced. */
interface Kept {
  id: string;
  groupId: string;
  message: string;
  author: string;
  meta: GroupFileMeta;
  /** I announced it: my copy is its first. */
  mine: boolean;
  /** Fetched without asking: it counts toward the group's automatic limit. */
  auto: boolean;
  /** Its person asked for it (Download). */
  asked: boolean;
  /** Its person paused it: what came stays, and it reads paused after a restart too, until Resume. */
  paused?: boolean;
  /** Every byte is here, checked against the author's digest: this device holds it. */
  held: boolean;
  /** Members said to hold it (`group-have`), or that offered it, newest first. The author is asked whether or not it is here. */
  holders: string[];
  /** A discard of what an earlier transfer stored, which the next one waits for. */
  idle?: Promise<void>;
  /** Bytes a transfer stored here that the next one goes on from, shown while it waits for a holder. */
  stored?: number;
  /** The transfer (its id on the edge) its person cancelled: what it stored is deleted, not kept for the next one. */
  dropped?: string;
  /**
   * The bytes kept from an earlier holder did not check out with the next one's tail: who served the bad part is not
   * known, so the next transfer starts from 0 (`fresh`) and the holder whose tail failed is not counted as damaged
   * (`unclear`, read once by `transferChanged`).
   */
  fresh?: boolean;
  unclear?: boolean;
  /**
   * Holders whose bytes failed the author's digest: not asked again for it, whatever the round, until its person asks
   * for it again (Download). Once every holder known is here, it is fetched no more (`DAMAGED`).
   */
  damaged: Set<string>;
}

/** A file being asked for: of one holder at a time. */
interface Want {
  /** The holder asked now and the edge it was asked on; none while nobody reachable has it. */
  holder?: string;
  linkId?: string;
  at: number;
  /** Holders asked in this round that had nothing to give: the next ask goes to another. */
  tried: Set<string>;
  /** The holder's transfer, once it offered: its id on the edge, and when its bytes last moved. */
  wire?: string;
  moved: number;
  movedAt: number;
  /** What the last holder asked in this round answered, when it was not the file: shown while the want waits. */
  why?: "busy" | "damaged";
  /**
   * Holders that answered `busy` in this round: one of them in reach tells this device when its place frees (its
   * `group-have`), so members never heard of as holders are not asked meanwhile.
   */
  busy?: Set<string>;
}

/** One edge's files/3, both ways. */
interface Edge {
  linkId: string;
  groupId: string;
  peer: string;
  files: ChatFiles;
  /** Transfers this side serves on the edge (their wire id) → the local file. */
  serving: Map<string, string>;
  /** Of each transfer served: the bytes the asker confirmed, and when that last changed. */
  servedMoved: Map<string, { confirmed: number; at: number }>;
  /** Transfers this side takes on the edge (the holder's wire id) → the local file. */
  taking: Map<string, string>;
  /** Transfers that ended on the edge, oldest first: the last `ENDED_KEPT` keep their record, the rest are forgotten. */
  ended: ["in" | "out", string][];
  /** Message ids to say in the next `group-have`, and the frames of it that went lately (`haveFrames` in `haveWindowMs`). */
  have: Set<string>;
  haveSent: RateWindow;
  /** Message ids its member asked for while this device served all it serves at once: said in a `group-have` once a slot frees. */
  busy: Set<string>;
  /** Message ids its member said it does not hold (`gone`): not asked of it again until it says it does, or the edge's session closes or opens. */
  gone: Set<string>;
}

/**
 * Ended transfers an edge keeps the record of. A late frame for one of them is still answered as files/3 says (an abort
 * to an asker going on with a transfer cancelled here); older ones are forgotten, so an edge's records stay few
 * however many transfers it has seen.
 */
const ENDED_KEPT = 8;

/** Why a want waits, as the person reads it (the app shows its own words for each `wait`). */
const WAITING_NOTES = {
  nobody: "Nobody you are connected to has this file yet",
  busy: "Its holders are busy; asking again soon",
  damaged: "It arrived damaged; ask again",
} as const;
/** Why a want stopped: every holder served bytes that are not the author's file. */
const DAMAGED = "Every copy of this file arrived damaged and was deleted. Ask for it again later.";

export class GroupFileDesk {
  private readonly kept = new Map<string, Kept>();
  /** `<group>\n<message id>` → local id. */
  private readonly byMessage = new Map<string, string>();
  private readonly wants = new Map<string, Want>();
  /**
   * The want last asked on each edge (by link id), and its file: whether a file is asked of an edge's member is read here,
   * not by going through every want each time (`askedOf`). An entry the want has moved on from is dropped when read.
   */
  private readonly askedOn = new Map<string, { id: string; want: Want }>();
  private readonly edgesById = new Map<string, Edge>();
  /** My file about to be announced, by `<group>\n<digest>`: the message that announces it takes this local id. */
  private readonly own = new Map<string, string>();
  /** Announcements sent per group, and taken per member of a group (WISP 503 § Rules for both, Pace). */
  private readonly sentPace = new Map<string, RateWindow>();
  private readonly sentTaken = new Map<string, RateWindow>();
  private readonly takenPace = new Map<string, RateWindow>();
  /** `<group>\n<message id>` a `group-have` named before its message came → its holders, newest first. */
  private readonly ahead = new Map<string, string[]>();
  /** A community's ids for its next `group-have`, and when one last went. */
  private readonly communityHave = new Map<string, { ids: Set<string>; at: number }>();
  /** Bytes served today, and the day (UTC days since the epoch). */
  private served = { day: 0, bytes: 0 };

  constructor(private readonly deps: GroupFileDeps) {}

  // -- what the groups hand over -------------------------------------------------------------------------------

  /**
   * At start: each group's files as they were kept. One fetched by itself, or asked for, and not here yet is asked for
   * again; with automatic downloads off, one chosen by itself before waits for a Download instead.
   */
  async load(groupIds: string[]): Promise<void> {
    for (const groupId of groupIds) {
      for (const file of await this.deps.store.list(groupId).catch(() => [])) {
        if (!file.group || !file.metadata || !file.digest || this.kept.has(file.id)) continue;
        const { name, size, mime, voice, video, image } = file.metadata;
        const kept: Kept = { id: file.id, groupId, message: file.group.message, author: file.group.author,
          meta: { name, size, mime, d: file.digest, ...(voice && { voice }), ...(video && { video }), ...(image && { image }) },
          mine: file.direction === "out", auto: !!file.group.auto, asked: !!file.group.asked, held: file.transfer?.state === "done", holders: [], damaged: new Set() };
        this.add(kept);
        // All here: it shows no transfer (a file with none reads as finished; its record says done). A view for each
        // would go into every state the engine builds, so each state would cost more with every file the groups ever had.
        if (kept.held) continue;
        // Every holder served it damaged: it waits for its person to ask again, not fetched again by itself.
        if (file.transfer?.state === "failed") this.show(kept, { state: "failed", transferred: 0, size, direction: "in", retry: true, error: file.transfer.error ?? DAMAGED });
        // Paused by its person: still paused, with the bytes that came (what the next transfer goes on from).
        else if (file.group.paused) {
          kept.paused = true;
          kept.stored = await this.keptBytes(kept.id);
          this.show(kept, { state: "transferring", stage: "paused", pausedBy: "me", transferred: kept.stored, size, direction: "in" });
        }
        else if (kept.asked || (kept.auto && this.deps.settings().autoDownloads)) this.wants.set(kept.id, this.newWant());
        else if (kept.auto) await this.stop(kept, false);
        else this.show(kept, { state: "transferring", stage: "asking", transferred: 0, size, direction: "in" });
      }
    }
    for (const [id] of this.wants) this.ask(this.kept.get(id)!);
    this.deps.changed();
  }

  /**
   * At start, once every group was read: the files of a group this device no longer has (`groupIds` are the groups it
   * has, a tombstone or a join under way among them) go, with their bytes. A group left before Leave took its files
   * left them behind, where nothing lists them.
   */
  async sweep(groupIds: string[]): Promise<void> {
    const here = new Set(groupIds);
    for (const groupId of await this.deps.store.groups().catch(() => [])) {
      if (here.has(groupId)) continue;
      for (const file of await this.deps.store.list(groupId).catch(() => [])) await this.deps.store.remove(file.id).catch(() => {});
    }
  }

  /**
   * The person stops a file that is coming, or that this device would fetch (Cancel, Decline): nobody is asked for it
   * any more, the transfer under way ends, what came of it is deleted, and it waits for a Download. Paused (`keep`),
   * what came stays, and Resume (`download`) goes on from there.
   */
  async halt(fileId: string, keep = false): Promise<void> {
    const kept = this.kept.get(fileId);
    if (!kept) throw new Error("No such file");
    // Only a file that is coming pauses: one waiting for a Download has nothing to go on with.
    if (keep && !this.wants.has(fileId)) return;
    await this.stop(kept, keep);
  }

  /** Automatic downloads were turned off: files chosen by themselves and not here yet stop coming, and wait for a Download. */
  async autoDownloadsOff(): Promise<void> {
    for (const kept of [...this.kept.values()]) if (kept.auto && !kept.asked && this.wants.has(kept.id)) await this.stop(kept, false);
  }

  private async stop(kept: Kept, keep: boolean): Promise<void> {
    if (kept.held || kept.mine) return;
    const want = this.wants.get(kept.id);
    // Gone first: the transfer's end below asks nobody else (`transferChanged`), and a late offer is refused.
    this.wants.delete(kept.id);
    const edge = want?.wire && want.linkId ? this.edgesById.get(want.linkId) : undefined;
    const record = edge?.files.get("in", want!.wire!);
    const { size } = kept.meta;
    if (!keep) { kept.stored = 0; kept.fresh = true; }
    if (edge && record && !transferEnded(record)) {
      // The transfer's own writer deletes what it stored (`openTarget`), or keeps it when paused.
      if (!keep) kept.dropped = record.id;
      edge.files.cancel("in", record.id);
      edge.taking.delete(record.id);
    } else if (!keep) {
      // No transfer under way: what an earlier one stored goes, before the next one writes.
      kept.idle = (kept.idle ?? Promise.resolve()).then(() => this.deps.store.write(kept.id)).then(writer => writer.discard()).catch(() => {});
    }
    this.show(kept, keep
      ? { state: "transferring", stage: "paused", pausedBy: "me", transferred: kept.stored ?? 0, size, direction: "in" }
      : { state: "transferring", stage: "asking", transferred: 0, size, direction: "in" });
    // Not fetched by itself any more, nor asked for: it stays stopped (or paused) after a restart, and counts toward no limit.
    const wasPaused = !!kept.paused;
    kept.paused = keep;
    if (kept.auto || kept.asked || wasPaused !== keep) {
      kept.auto = kept.asked = false;
      await this.deps.store.patch(kept.id, { group: this.groupField(kept) }).catch(() => {});
    }
  }

  /**
   * An error when this group took as many announcements of mine as it takes in a minute, or as its members take from
   * one member in `announceWindowMs` (past that they would not fetch the file by themselves); null when one may go now.
   */
  mayAnnounce(groupId: string): string | null {
    const wait = Math.max(...this.sentPaces(groupId).map(pace => pace.wait()));
    if (!wait) return null;
    const minutes = Math.ceil(wait / 60_000);
    return `You sent many files to this group just now. Wait ${minutes > 1 ? `${minutes} minutes` : "a minute"}.`;
  }

  /** My file, stored under `fileId` with the author's digest, is about to be announced in the group: its message takes it. */
  outgoing(groupId: string, fileId: string, meta: GroupFileMeta): void {
    this.own.set(`${groupId}\n${meta.d}`, fileId);
  }
  /** The announcement did not go: the file is not this group's after all. */
  notSent(groupId: string, meta: GroupFileMeta): void { this.own.delete(`${groupId}\n${meta.d}`); }

  /**
   * A message of the group announces a file (mine, or a member's): the file its row shows. A member's is kept here
   * unfetched, and fetched now when it is one this device takes by itself and the member announced no more than the
   * group fetches that way. The same message again (a catch-up, a whole copy) is the same file.
   */
  async announced(groupId: string, m: { id: string; sender: string; file: GroupFileMeta }, me: string): Promise<MessageFile | undefined> {
    const known = this.byMessage.get(`${groupId}\n${m.id}`);
    if (known) return messageFile(this.kept.get(known)!);
    const ownId = m.sender === me ? this.own.get(`${groupId}\n${m.file.d}`) : undefined;
    if (ownId) {
      this.own.delete(`${groupId}\n${m.file.d}`);
      for (const pace of this.sentPaces(groupId)) pace.take();
      const kept: Kept = { id: ownId, groupId, message: m.id, author: me, meta: m.file, mine: true, auto: false, asked: false, held: true, holders: [], damaged: new Set() };
      this.add(kept);
      const transfer = { state: "done" as const, transferred: m.file.size, size: m.file.size };
      await this.deps.store.patch(ownId, { group: { message: m.id, author: me }, transfer }).catch(() => {});
      this.show(kept, { ...transfer, direction: "out" });
      this.queueHave(kept);
      return messageFile(kept);
    }
    // More from one member than a group fetches by itself: past it, the file is kept and waits for a Download (WISP 503,
    // Pace). Counted as they come, so a catch-up of files sent over hours is one burst: none of them is lost to it.
    const paced = this.pace(this.takenPace, `${groupId}\n${m.sender}`, GROUP_FILE_LIMITS.announceTaken, GROUP_FILE_LIMITS.announceWindowMs).take();
    const id = groupFileId(groupId, "in");
    const auto = paced && this.deps.settings().autoDownloads && fetchesByItself(m.file, this.keptAutomatically(groupId));
    const holders = this.ahead.get(`${groupId}\n${m.id}`) ?? [];
    this.ahead.delete(`${groupId}\n${m.id}`);
    const kept: Kept = { id, groupId, message: m.id, author: m.sender, meta: m.file, mine: false, auto, asked: false, held: false, holders, damaged: new Set() };
    const { name, size, mime, voice, video, image } = m.file;
    // Known at once: the same message coming again meanwhile (another copy of it) is this file.
    this.add(kept);
    // No bytes yet: where they go is decided when they come (`GroupFileStore.write`).
    await this.deps.store.put({ id, linkId: `group:${groupId}`, direction: "in", digest: m.file.d, createdAt: this.deps.now(),
      metadata: { name, size, mime, timestamp: this.deps.now(), voice, video, image },
      transfer: { state: "transferring", transferred: 0, size }, group: { message: m.id, author: m.sender, ...(auto && { auto: true }) } });
    if (auto) { this.wants.set(id, this.newWant()); this.ask(kept); }
    else this.show(kept, { state: "transferring", stage: "asking", transferred: 0, size, direction: "in" });
    return messageFile(kept);
  }

  /** The person asks for a file this device did not fetch by itself (Download), or for one that stopped coming. */
  async download(fileId: string): Promise<void> {
    const kept = this.kept.get(fileId);
    if (!kept) throw new Error("No such file");
    if (kept.held) return;
    const room = await this.deps.store.room().catch(() => null);
    if (room !== null && kept.meta.size > room) throw new Error("Not enough space on this device for this file");
    if (!kept.asked || kept.paused) {
      kept.asked = true; kept.paused = false;
      await this.deps.store.patch(kept.id, { group: this.groupField(kept) }).catch(() => {});
    }
    // Asked again: every holder is worth asking again, one that served it damaged too.
    kept.damaged.clear();
    if (this.deps.transfers.get(kept.id)?.state === "failed") {
      await this.deps.store.patch(kept.id, { transfer: { state: "transferring", transferred: 0, size: kept.meta.size } }).catch(() => {});
    }
    const want = this.wants.get(kept.id);
    if (!want) this.wants.set(kept.id, this.newWant());
    else if (!want.wire) { want.tried.clear(); want.why = want.busy = undefined; }
    this.ask(kept);
  }

  /** The group is gone from this device: its files go too. */
  async drop(groupId: string): Promise<void> {
    for (const kept of [...this.kept.values()].filter(k => k.groupId === groupId)) {
      this.kept.delete(kept.id);
      this.byMessage.delete(`${groupId}\n${kept.message}`);
      this.wants.delete(kept.id);
      this.deps.transfers.delete(kept.id);
      await this.deps.store.remove(kept.id).catch(() => {});
    }
    for (const [linkId, edge] of this.edgesById) if (edge.groupId === groupId) { edge.files.detach(); this.edgesById.delete(linkId); }
    for (const key of [...this.ahead.keys()]) if (key.startsWith(`${groupId}\n`)) this.ahead.delete(key);
    this.communityHave.delete(groupId);
    this.deps.changed();
  }

  // -- edges ---------------------------------------------------------------------------------------------------

  /** An edge's files/3 session opened (both sides agreed it) or closed. */
  session(groupId: string, peer: string, linkId: string, open: boolean): void {
    const edge = this.edge(groupId, peer, linkId);
    if (open) edge.files.attach(); else edge.files.detach();
    // Another session, or none: its member may have fetched since what it did not hold, and is asked again.
    edge.gone.clear();
    if (open) this.retry(groupId);
  }

  /** An edge came up and both sides said where they are: what this device holds goes to it, and wants waiting for a holder go. */
  edgeReady(groupId: string, peer: string, linkId: string): void {
    if (!this.deps.ready(linkId)) return;
    const edge = this.edge(groupId, peer, linkId);
    if (this.deps.settings().serveFiles) {
      const held = [...this.kept.values()].filter(k => k.groupId === groupId && k.held).map(k => k.message).slice(-GROUP_FILE_LIMITS.haveIds);
      if (held.length) this.sendHave(edge, held);
    }
    this.retry(groupId);
  }

  /** A `group-want`, `group-want-no` or `group-have` on an edge, from the member it is pinned to. */
  async frame(groupId: string, peer: string, linkId: string, frame: Record<string, unknown>): Promise<void> {
    if (frame.t === GROUP_WANT_FRAME) {
      const want = readGroupWant(frame, groupId);
      if (want) await this.serve(this.edge(groupId, peer, linkId), want.id);
    } else if (frame.t === GROUP_WANT_NO_FRAME) {
      const no = readGroupWantNo(frame, groupId);
      if (no) this.refused(groupId, peer, linkId, no.id, no.why);
    } else if (frame.t === GROUP_HAVE_FRAME) {
      const ids = readGroupHave(frame, groupId);
      if (ids) this.heard(groupId, peer, ids);
    }
  }

  /** A community's `group-have`, an application frame its signer sent the group. */
  communityApp(groupId: string, sender: string, frame: Record<string, unknown>): void {
    const ids = readGroupHave(frame);
    if (ids) this.heard(groupId, sender, ids);
  }

  /**
   * A files/3 frame on an edge. An offer is taken only for a file this device asked that member for (`gm` naming the
   * message): nobody can push a file into another's storage. What it brings belongs to the group's message, not to the
   * edge as a chat.
   */
  filesFrame(groupId: string, peer: string, linkId: string, frame: Record<string, unknown>): Promise<void> {
    const edge = this.edge(groupId, peer, linkId);
    if (frame.t === "pf-offer" && typeof frame.id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(frame.id) && !edge.taking.has(frame.id)) {
      const kept = isGroupMessageId(frame.gm) ? this.kept.get(this.byMessage.get(`${groupId}\n${frame.gm}`) ?? "") : undefined;
      const want = kept && this.wants.get(kept.id);
      if (!kept || kept.held || !want || want.linkId !== linkId || want.wire) {
        this.deps.sendFiles(linkId, { t: "pf-refuse", id: frame.id, why: "invalid" });
        return Promise.resolve();
      }
      edge.taking.set(frame.id, kept.id);
      // It offers the file: it holds it, whether or not it ever said so.
      kept.holders = newestHolder(peer, kept.holders);
      want.wire = frame.id;
      want.why = undefined;
      want.movedAt = this.deps.now();
    }
    return edge.files.handle(frame);
  }

  /** Wants that waited too long for an offer, or for bytes, go to the next holder; `group-have`s gathered go. */
  tick(): void {
    const now = this.deps.now();
    for (const [id, want] of this.wants) {
      const kept = this.kept.get(id);
      if (!kept) { this.wants.delete(id); continue; }
      if (now - (want.wire ? want.movedAt : want.at) < GROUP_FILE_LIMITS.wantWaitMs) continue;
      if (want.wire) {
        // A holder that stalls is left: the transfer ends here, and the next holder is asked (`transferChanged`).
        const edge = want.linkId ? this.edgesById.get(want.linkId) : undefined;
        if (edge?.files.get("in", want.wire) && !transferEnded(edge.files.get("in", want.wire)!)) { edge.files.cancel("in", want.wire); continue; }
        want.wire = undefined;
      }
      if (want.holder) want.tried.add(want.holder);
      // Everyone asked in turn: a new round, as holders come and go.
      else { want.tried.clear(); want.why = want.busy = undefined; }
      this.ask(kept);
    }
    this.letGo();
    for (const edge of this.edgesById.values()) {
      if (edge.have.size && this.deps.ready(edge.linkId)) this.sendHave(edge, [...edge.have]);
    }
    for (const [groupId, have] of this.communityHave) {
      if (!have.ids.size || now - have.at < GROUP_FILE_LIMITS.communityHaveEveryMs) continue;
      const ids = [...have.ids].slice(-GROUP_FILE_LIMITS.haveIds);
      have.ids.clear();
      have.at = now;
      void this.deps.sendApp(groupId, { t: GROUP_HAVE_FRAME, ids }).catch(() => {});
    }
  }

  // -- asking --------------------------------------------------------------------------------------------------

  private newWant(): Want { return { at: this.deps.now(), tried: new Set(), moved: 0, movedAt: 0 }; }

  /**
   * Wants of this group that wait for a holder: asked now (an edge came up or freed, or a member said it holds
   * something). One queued behind an edge's file is asked only while an edge of the group is free to take it: once every
   * edge has a file asked of it, it would only queue again. So a file that ends asks the few wants it frees an edge for,
   * not every want waiting (a member back from away with hundreds of files to fetch asked each of them once per file).
   */
  private retry(groupId: string): void {
    let free: boolean | undefined;
    for (const [id, want] of this.wants) {
      const kept = this.kept.get(id);
      if (kept?.groupId !== groupId || want.holder) continue;
      if (this.deps.transfers.get(id)?.stage === "queued" && !(free ??= this.edgeFree(groupId))) continue;
      this.ask(kept);
      // That ask may have taken the last free edge.
      free = undefined;
    }
  }

  /** An edge of the group is up, its files/3 live, and no file is asked of its member: a want could be asked on it. */
  private edgeFree(groupId: string): boolean {
    for (const linkId of this.deps.edges(groupId).values()) {
      if (this.deps.ready(linkId) && this.edgesById.get(linkId)?.files.live && !this.askedOf(linkId)) return true;
    }
    return false;
  }

  /**
   * Asks the next holder for a file: the author first while its edge is up, then the holders whose edge is up, then every
   * other member whose edge is up and that could read its message. Who holds what is heard, not kept: a holder names few
   * of its files to an edge that opens, and none it was told of is known after a restart here, so a member in reach is
   * asked whether or not it said so (one that does not hold it answers `gone`, and is not asked again). Only over an
   * edge this device has. (A private group past 16 members, or a community, reaches a holder it has no edge with
   * over a file session of the two members, WISP 503 § The file session; that session is not built yet, so such a
   * holder is not asked, and the file waits for one that is reachable.)
   */
  private ask(kept: Kept): void {
    const want = this.wants.get(kept.id);
    if (!want || kept.held || want.wire) return;
    const membership = this.deps.membership(kept.groupId);
    const edges = this.deps.edges(kept.groupId);
    const known = [kept.author, ...kept.holders.filter(key => key !== kept.author)]
      .filter(key => membership && key !== membership.me && membership.inRoster(key));
    // Every holder known served it damaged: asking again would fetch the same bytes, all of them, round after round.
    if (known.length && known.every(key => kept.damaged.has(key))) { this.stopDamaged(kept); return; }
    // A known holder that answered busy, or the author whose edge another file of this device's is asked of, its edge up,
    // serves when its place frees: the others are asked only when no known holder is worth waiting for (none in reach, or
    // every one gone), as after a restart here. Only the author's edge holds them back while it is asked of: any member
    // can say it holds files, and one that serves the file asked of it slowly would keep every other file it named here.
    const waitForBusy = known.some(key => {
      const linkId = edges.get(key) ?? "";
      return this.deps.ready(linkId) && (want.busy?.has(key) || (key === kept.author && this.askedOf(linkId, want)));
    });
    const others = waitForBusy ? [] : [...edges.keys()].filter(key => !known.includes(key) && membership && key !== membership.me && membership.couldRead(key, kept.message));
    const order = [...known, ...others].filter(key => !want.tried.has(key) && !kept.damaged.has(key) && !this.edgesById.get(edges.get(key) ?? "")?.gone.has(kept.message));
    let behind = false;
    for (const key of order) {
      const linkId = edges.get(key);
      if (!linkId || !this.deps.ready(linkId) || !this.edgesById.get(linkId)?.files.live) continue;
      // A holder serves this device one file at a time (WISP 503 § Serving limits): asked now, it would answer `busy`.
      // This one waits its turn, and is asked when the file before it ends (`transferChanged`).
      if (this.askedOf(linkId, want)) { behind = true; continue; }
      // Asked of it before the frame goes: its answer is this want's, however soon it comes.
      Object.assign(want, { holder: key, linkId, at: this.deps.now() });
      this.askedOn.set(linkId, { id: kept.id, want });
      if (!this.deps.send(linkId, { t: GROUP_WANT_FRAME, g: kept.groupId, id: kept.message })) { want.tried.add(key); continue; }
      if (want.holder === key) this.show(kept, { state: "transferring", stage: "queued", transferred: kept.stored ?? 0, size: kept.meta.size, direction: "in" });
      return;
    }
    Object.assign(want, { holder: undefined, linkId: undefined, at: this.deps.now() });
    if (behind) { this.show(kept, { state: "transferring", stage: "queued", transferred: kept.stored ?? 0, size: kept.meta.size, direction: "in" }); return; }
    // Why it waits: a holder busy, bytes that came damaged (its person can ask again), or nobody in reach has it.
    const wait = want.why ?? "nobody";
    this.show(kept, { state: "transferring", stage: "waiting", transferred: kept.stored ?? 0, size: kept.meta.size, direction: "in",
      wait, note: WAITING_NOTES[wait], ...(wait === "damaged" && { stalled: true }) });
  }

  /**
   * Another file is asked of, or coming from, the member at the other end of this edge. A want gets its edge only in
   * `ask`, which notes it in `askedOn`, and one edge has one want at a time: the want noted there is it, while it still
   * waits and is still on that edge.
   */
  private askedOf(linkId: string, except?: Want): boolean {
    const on = this.askedOn.get(linkId);
    if (!on || on.want === except) return false;
    if (on.want.linkId === linkId && this.wants.get(on.id) === on.want) return true;
    this.askedOn.delete(linkId);
    return false;
  }

  /** No holder serves the author's bytes: the want stops, and stays stopped after a restart, until Download. */
  private stopDamaged(kept: Kept): void {
    this.wants.delete(kept.id);
    const { size } = kept.meta;
    void this.deps.store.patch(kept.id, { transfer: { state: "failed", transferred: 0, size, error: DAMAGED } }).catch(() => {});
    this.show(kept, { state: "failed", transferred: 0, size, direction: "in", retry: true, error: DAMAGED });
  }

  /** A holder's no: the next one is asked. One that deleted the file is no holder any more. */
  private refused(groupId: string, peer: string, linkId: string, messageId: string, why: GroupWantRefusal): void {
    const kept = this.kept.get(this.byMessage.get(`${groupId}\n${messageId}`) ?? "");
    const want = kept && this.wants.get(kept.id);
    if (!kept || !want || want.linkId !== linkId || want.wire) return;
    if (why === "gone") {
      kept.holders = kept.holders.filter(key => key !== peer);
      this.edgesById.get(linkId)?.gone.add(messageId);
    }
    if (why === "busy") { want.why = "busy"; (want.busy ??= new Set()).add(peer); }
    want.tried.add(peer);
    want.holder = want.linkId = undefined;
    this.ask(kept);
    // The edge is free for a file waiting its turn there.
    this.retry(groupId);
  }

  /** A member says it holds these files: remembered as a holder of each (newest first), and asked when a want waits. */
  private heard(groupId: string, from: string, ids: string[]): void {
    const membership = this.deps.membership(groupId);
    if (!membership || from === membership.me || !membership.inRoster(from)) return;
    const newest = (holders: string[]) => newestHolder(from, holders);
    const edge = this.edgesById.get(this.deps.edges(groupId).get(from) ?? "");
    for (const message of ids) {
      const key = `${groupId}\n${message}`, kept = this.kept.get(this.byMessage.get(key) ?? "");
      if (!kept) {
        // Its message has not come yet (it is on its way in a catch-up): who holds it is kept for when it does.
        this.ahead.set(key, newest(this.ahead.get(key) ?? []));
        if (this.ahead.size > GROUP_FILE_LIMITS.heardAhead) this.ahead.delete(this.ahead.keys().next().value!);
        continue;
      }
      if (kept.mine) continue;
      kept.holders = newest(kept.holders);
      edge?.gone.delete(message);
      const want = this.wants.get(kept.id);
      if (!want) continue;
      want.tried.delete(from);
      want.busy?.delete(from);
      if (!want.holder) this.ask(kept);
    }
  }

  // -- serving -------------------------------------------------------------------------------------------------

  /** A member asks for a file: offered over files/3 on its edge, or a `group-want-no` saying why not. */
  private async serve(edge: Edge, messageId: string): Promise<void> {
    const kept = this.kept.get(this.byMessage.get(`${edge.groupId}\n${messageId}`) ?? "");
    const here = !!kept?.held && !!(await this.deps.store.get(kept.id).catch(() => undefined));
    // Decided and offered in one step: two wants at once never both find the last free place.
    const why = this.mayServe(edge, messageId, here ? kept : undefined);
    if (why || !kept) { this.deps.send(edge.linkId, { t: GROUP_WANT_NO_FRAME, g: edge.groupId, id: messageId, why: why ?? "gone" }); return; }
    const wire = toBase64Url(randomBytes(12));
    edge.serving.set(wire, kept.id);
    edge.servedMoved.set(wire, { confirmed: 0, at: this.deps.now() });
    const { name, mime, size, voice, video, image } = kept.meta;
    const file: FileInfo = { id: wire, name, mime, size, timestamp: this.deps.now(), ...(voice && { voice }), ...(video && { video }), ...(image && { image }) };
    edge.files.offer(file, kept.meta.d);
  }

  /**
   * Why this device does not serve a file now, or null when it does (WISP 503 § Asking, Serving limits): `refused` to
   * someone who could not read the announcement, `gone` when it is not here (`kept` undefined), `busy` when serving is
   * off or full.
   */
  private mayServe(edge: Edge, messageId: string, kept: Kept | undefined): GroupWantRefusal | null {
    const membership = this.deps.membership(edge.groupId);
    if (!membership || !membership.couldRead(edge.peer, messageId)) return "refused";
    if (!kept) return "gone";
    if (!this.deps.settings().serveFiles || !edge.files.live) return "busy";
    this.letGo();
    const active = this.servingNow();
    if (active.length >= GROUP_FILE_LIMITS.serveAtOnce) { edge.busy.add(messageId); return "busy"; }
    // One that has all its bytes waits only for the member's word that its check passed, which may come after this want.
    if (active.some(a => a.peer === edge.peer && a.sending)) return "busy";
    const today = Math.floor(this.deps.now() / 86_400_000);
    if (this.served.day !== today) this.served = { day: today, bytes: 0 };
    const reserved = active.reduce((sum, a) => sum + a.size, 0);
    return this.served.bytes + reserved + kept.meta.size > GROUP_FILE_LIMITS.serveBytesPerDay ? "busy" : null;
  }

  /**
   * Transfers served now, all groups together: to whom, what each takes of the day (its size, or what it sent when that
   * is more), and whether bytes are still to go.
   */
  private servingNow(): { peer: string; size: number; sending: boolean }[] {
    const active: { peer: string; size: number; sending: boolean }[] = [];
    for (const edge of this.edgesById.values()) for (const wire of edge.serving.keys()) {
      const record = edge.files.get("out", wire);
      if (record && !transferEnded(record)) {
        active.push({ peer: edge.peer, size: Math.max(record.file.size, edge.files.sent(wire)), sending: record.confirmed < record.file.size });
      }
    }
    return active;
  }

  /**
   * An asker has a served transfer send parts again (WISP 503 § Serving limits): every byte sent counts toward the day,
   * so it goes on only while the day has room for it.
   */
  private mayResend(): boolean {
    const today = Math.floor(this.deps.now() / 86_400_000);
    if (this.served.day !== today) this.served = { day: today, bytes: 0 };
    return this.served.bytes + this.servingNow().reduce((sum, a) => sum + a.size, 0) < GROUP_FILE_LIMITS.serveBytesPerDay;
  }

  /**
   * Served transfers that no longer count end, their places free for others (WISP 503 § Serving limits): the asker's
   * session closed, it is not in the roster any more, or its bytes have not moved for `wantWaitMs` (the asker has moved
   * on by then).
   */
  private letGo(): void {
    const now = this.deps.now();
    for (const edge of this.edgesById.values()) for (const wire of [...edge.serving.keys()]) {
      const record = edge.files.get("out", wire);
      if (!record || transferEnded(record)) continue;
      let moved = edge.servedMoved.get(wire);
      if (!moved || moved.confirmed !== record.confirmed) edge.servedMoved.set(wire, (moved = { confirmed: record.confirmed, at: now }));
      const gone = !edge.files.live || !this.deps.membership(edge.groupId)?.inRoster(edge.peer);
      if (gone || now - moved.at >= GROUP_FILE_LIMITS.wantWaitMs) edge.files.cancel("out", wire);
    }
  }

  /**
   * Says on an edge which files this device holds, as many frames as the edge takes now (`haveFrames` in
   * `haveWindowMs`); the ids past that, and those of a frame that could not go, wait for the next tick with room.
   */
  private sendHave(edge: Edge, ids: string[]): void {
    for (const id of ids) edge.have.add(id);
    for (let i = 0; i < ids.length; i += GROUP_FILE_LIMITS.haveIds) {
      const frame = ids.slice(i, i + GROUP_FILE_LIMITS.haveIds);
      if (edge.haveSent.wait() || !this.deps.send(edge.linkId, { t: GROUP_HAVE_FRAME, g: edge.groupId, ids: frame })) return;
      edge.haveSent.take();
      for (const id of frame) edge.have.delete(id);
    }
  }

  /**
   * This device holds a new file: the group hears it with the next `group-have`, which gathers what there is to say
   * until the next tick.
   */
  private queueHave(kept: Kept): void {
    if (!this.deps.settings().serveFiles) return;
    if (this.deps.membership(kept.groupId)?.community) {
      let have = this.communityHave.get(kept.groupId);
      if (!have) this.communityHave.set(kept.groupId, (have = { ids: new Set(), at: 0 }));
      have.ids.add(kept.message);
      return;
    }
    for (const [key, linkId] of this.deps.edges(kept.groupId)) this.edge(kept.groupId, key, linkId).have.add(kept.message);
  }

  // -- files/3 on an edge --------------------------------------------------------------------------------------

  private edge(groupId: string, peer: string, linkId: string): Edge {
    const known = this.edgesById.get(linkId);
    if (known) return known;
    const edge: Edge = { linkId, groupId, peer, files: undefined as unknown as ChatFiles, serving: new Map(), servedMoved: new Map(), taking: new Map(), ended: [], have: new Set(),
      haveSent: new RateWindow(GROUP_FILE_LIMITS.haveFrames, GROUP_FILE_LIMITS.haveWindowMs, () => this.deps.now()), busy: new Set(), gone: new Set() };
    edge.files = new ChatFiles({
      // An offer names the group message it serves (`gm`), which a 1:1 chat never carries.
      send: frame => {
        const kept = frame.t === "pf-offer" ? this.kept.get(edge.serving.get(frame.id as string) ?? "") : undefined;
        return this.deps.sendFiles(linkId, kept ? { ...frame, gm: kept.message } : frame);
      },
      decide: file => this.decide(edge, file),
      openTarget: record => this.openTarget(edge, record),
      openSource: record => this.openSource(edge, record),
      changed: (record, transferred) => this.transferChanged(edge, record, transferred),
      room: () => this.deps.store.room(),
      ...(this.deps.sendData && { sendData: (id: string, offset: number, data: Uint8Array) => this.deps.sendData!(linkId, id, offset, data) }),
      writable: () => this.deps.writable?.(linkId),
      resend: record => !edge.serving.has(record.id) || this.mayResend(),
    });
    this.edgesById.set(linkId, edge);
    return edge;
  }

  /** An offer that answers my want (`filesFrame` checked that): taken, unless it is not the file announced or there is no room. */
  private async decide(edge: Edge, file: FileInfo): Promise<OfferDecision> {
    const kept = this.kept.get(edge.taking.get(file.id) ?? ""), want = kept && this.wants.get(kept.id);
    if (!kept || kept.held || want?.linkId !== edge.linkId || want.wire !== file.id || file.size !== kept.meta.size) return { refuse: "invalid" };
    const room = await this.deps.store.room().catch(() => null);
    return room !== null && file.size > room ? { refuse: "no-room", room } : "accept";
  }

  private async openTarget(edge: Edge, record: FileTransferRecord): Promise<IncomingTarget> {
    const kept = this.kept.get(edge.taking.get(record.id) ?? "");
    if (!kept) throw new Error("No such file");
    // What an earlier holder's transfer stored stays, and this one goes on from there (WISP 503: the asker accepts from
    // the offset it stored): every holder serves the author's bytes, and the whole file is checked at the end.
    await kept.idle;
    const writer = await this.deps.store.write(kept.id, !kept.fresh);
    kept.fresh = false;
    const resumed = writer.offset > 0;
    let damaged = false;
    return {
      offset: writer.offset,
      append: bytes => writer.append(bytes),
      flush: () => writer.flush(),
      // Against the author's digest, read back from storage, not the holder's word: a holder can withhold a file, never
      // serve another one.
      verify: async () => {
        damaged = (await writer.digest()) !== kept.meta.d;
        const want = this.wants.get(kept.id);
        if (damaged && want) want.why = "damaged";
        return !damaged;
      },
      // Only damaged bytes go, and those of a file its person cancelled. Left with a holder that stalled or stopped, what
      // came is kept for the next holder.
      discard: () => {
        // Whole from this holder and damaged: its bytes are not the author's, and it is not asked for them again.
        if (damaged) { kept.stored = 0; if (resumed) kept.fresh = kept.unclear = true; else kept.damaged.add(edge.peer); }
        return (kept.idle = (damaged || kept.dropped === record.id ? writer.discard() : writer.close()).catch(() => {}));
      },
    };
  }

  private async openSource(edge: Edge, record: FileTransferRecord): Promise<OutgoingSource> {
    const kept = this.kept.get(edge.serving.get(record.id) ?? "");
    const stored = kept && await this.deps.store.get(kept.id);
    if (!kept || !stored) throw new Error("The file is gone");
    return { read: (offset, length) => this.deps.store.read(stored, offset, length), digest: async () => kept.meta.d };
  }

  /** A transfer on the edge ended: its record stays among the last `ENDED_KEPT`, and the oldest past that is forgotten. */
  private transferOver(edge: Edge, record: FileTransferRecord): void {
    if (edge.ended.some(([direction, id]) => direction === record.direction && id === record.id)) return;
    edge.ended.push([record.direction, record.id]);
    while (edge.ended.length > ENDED_KEPT) edge.files.forget(...edge.ended.shift()!);
  }

  private transferChanged(edge: Edge, record: FileTransferRecord, transferred: number): void {
    if (transferEnded(record)) this.transferOver(edge, record);
    if (record.direction === "out") {
      if (transferEnded(record) && edge.serving.has(record.id)) {
        // What was sent to a member counts toward the day's serving, done or not, and whatever it confirmed.
        const today = Math.floor(this.deps.now() / 86_400_000);
        if (this.served.day !== today) this.served = { day: today, bytes: 0 };
        this.served.bytes += edge.files.sent(record.id);
        edge.serving.delete(record.id);
        edge.servedMoved.delete(record.id);
        // A slot is free: those turned away as busy hear this device holds their file (with the next `group-have`), and
        // ask it again rather than wait out their round.
        const serving = this.deps.settings().serveFiles;
        for (const other of this.edgesById.values()) {
          if (serving) for (const id of other.busy) other.have.add(id);
          other.busy.clear();
        }
      }
      return;
    }
    const kept = this.kept.get(edge.taking.get(record.id) ?? ""), want = kept && this.wants.get(kept.id);
    // A transfer this device moved on from (the holder stalled, then went on) changes nothing.
    if (!kept || !want || want.wire !== record.id || want.linkId !== edge.linkId) return;
    if (transferred !== want.moved) { want.moved = transferred; want.movedAt = this.deps.now(); }
    if (record.state !== "failed" && record.state !== "declined" && record.state !== "cancelled") kept.stored = transferred;
    const { size } = kept.meta;
    switch (record.state) {
      case "done": {
        kept.held = true;
        this.wants.delete(kept.id);
        edge.taking.delete(record.id);
        void this.deps.store.patch(kept.id, { transfer: { state: "done", transferred: size, size } }).catch(() => {});
        this.show(kept, { state: "done", transferred: size, size, direction: "in" });
        this.queueHave(kept);
        // The holder is free for the next file this device waits for.
        this.retry(kept.groupId);
        return;
      }
      case "failed": case "declined": case "cancelled":
        // Damaged (refused, its bytes deleted), stopped by the holder or left here: the next holder is asked.
        edge.taking.delete(record.id);
        // A resumed file that failed its check may owe its bad bytes to the earlier holder: this one is asked again, from 0.
        if (want.holder && !kept.unclear) want.tried.add(want.holder);
        kept.unclear = false;
        Object.assign(want, { wire: undefined, holder: undefined, linkId: undefined, moved: 0 });
        this.ask(kept);
        this.retry(kept.groupId);
        return;
      case "verifying":
        this.show(kept, { state: "transferring", stage: "verifying", transferred, size, direction: "in" });
        return;
      default:
        this.show(kept, { state: "transferring", transferred, size, direction: "in" });
    }
  }

  // -- bookkeeping ---------------------------------------------------------------------------------------------

  private add(kept: Kept): void {
    this.kept.set(kept.id, kept);
    this.byMessage.set(`${kept.groupId}\n${kept.message}`, kept.id);
  }

  /** Bytes this device fetched by itself from the group and keeps (or is fetching): what `autoBytesPerGroup` bounds. */
  private keptAutomatically(groupId: string): number {
    let sum = 0;
    for (const kept of this.kept.values()) if (kept.groupId === groupId && kept.auto && !kept.mine) sum += kept.meta.size;
    return sum;
  }

  private groupField(kept: Kept): NonNullable<StoredFile["group"]> {
    return { message: kept.message, author: kept.author, ...(kept.auto && { auto: true }), ...(kept.asked && { asked: true }), ...(kept.paused && { paused: true }) };
  }

  /** The bytes of a file kept here from transfers that did not finish. */
  private async keptBytes(id: string): Promise<number> {
    const writer = await this.deps.store.write(id, true).catch(() => undefined);
    if (!writer) return 0;
    await writer.close().catch(() => {});
    return writer.offset;
  }

  private pace(windows: Map<string, RateWindow>, key: string, limit: number, ms: number): RateWindow {
    let window = windows.get(key);
    if (!window) windows.set(key, (window = new RateWindow(limit, ms, () => this.deps.now())));
    return window;
  }

  /** My announcements in a group, in a minute and in the window the members count them over. */
  private sentPaces(groupId: string): RateWindow[] {
    return [this.pace(this.sentPace, groupId, GROUP_FILE_LIMITS.announcePerMinute, 60_000),
      this.pace(this.sentTaken, groupId, GROUP_FILE_LIMITS.announceTaken, GROUP_FILE_LIMITS.announceWindowMs)];
  }

  /** A file's row shows `view`; the engine hears of it only when that is not what the row shows already. */
  private show(kept: Kept, view: FileTransferView): void {
    if (sameView(this.deps.transfers.get(kept.id), view)) return;
    this.deps.transfers.set(kept.id, view);
    this.deps.changed();
  }
}

/** Two views of a transfer that say the same: their fields are all plain values. */
function sameView(a: FileTransferView | undefined, b: FileTransferView): boolean {
  if (!a) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof FileTransferView)[]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

/** A file's holders with `key` the newest of them, the `holders` newest kept. */
const newestHolder = (key: string, holders: string[]): string[] => [key, ...holders.filter(other => other !== key)].slice(0, GROUP_FILE_LIMITS.holders);

function messageFile(kept: Kept): MessageFile {
  const { name, size, mime, voice, video, image } = kept.meta;
  return { id: kept.id, name, size, mime, ...(voice && { voice }), ...(video && { video }), ...(image && { image }) };
}
