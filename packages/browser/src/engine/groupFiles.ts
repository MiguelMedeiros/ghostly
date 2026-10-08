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
  get(id: string): Promise<StoredFile | undefined>;
  put(file: StoredFile): Promise<void>;
  patch(id: string, fields: Pick<StoredFile, "transfer" | "group">): Promise<void>;
  /** The record and its bytes. */
  remove(id: string): Promise<void>;
  /** Writes a file from its first byte (whatever was there goes), in order. */
  write(id: string): Promise<GroupFileWriter>;
  /** At most `length` bytes of a kept file from `offset`. */
  read(file: StoredFile, offset: number, length: number): Promise<Uint8Array>;
  /** Bytes this device can still take for files, or null when the platform does not say. */
  room(): Promise<number | null>;
}

export interface GroupFileWriter {
  append(bytes: Uint8Array): Promise<void>;
  flush(): Promise<void>;
  /** SHA-256 of what was stored, read back from storage, base64url. */
  digest(): Promise<string>;
  discard(): Promise<void>;
}

/** The profile's files store and file storage, as a 1:1 chat's files use them. */
export const storedGroupFiles: GroupFileStore = {
  list: groupId => fileStore.listForLink(`group:${groupId}`),
  get: id => fileStore.get(id),
  put: file => fileStore.put(file),
  patch: (id, fields) => fileStore.patch(id, fields),
  remove: id => removeStored(id),
  async write(id) {
    const stored = await fileStore.get(id);
    const bytes = (stored?.bytes && await fileBytesOf(stored.bytes)) || await fileBytes();
    if ((await bytes.size(id)) !== null) await bytes.truncate(id, 0);
    if (stored && stored.bytes !== bytes.kind) await fileStore.patch(id, { bytes: bytes.kind });
    const appender = new FileAppender(bytes, id, 0);
    return {
      append: chunk => appender.append(chunk),
      flush: () => appender.flush(),
      digest: async () => { await appender.close(); return bytes.digest(id); },
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
  /** Every byte is here, checked against the author's digest: this device holds it. */
  held: boolean;
  /** Members said to hold it (`group-have`), newest first. The author is asked whether or not it is here. */
  holders: string[];
  /** A discard of what an earlier transfer stored, which the next one waits for. */
  idle?: Promise<void>;
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
}

/** One edge's files/3, both ways. */
interface Edge {
  linkId: string;
  groupId: string;
  peer: string;
  files: ChatFiles;
  /** Transfers this side serves on the edge (their wire id) → the local file. */
  serving: Map<string, string>;
  /** Transfers this side takes on the edge (the holder's wire id) → the local file. */
  taking: Map<string, string>;
  /** Message ids to say in the next `group-have`, and when one last went. */
  have: Set<string>;
  haveAt: number;
}

/** Why a want waits, as the person reads it. */
const NOBODY_CONNECTED = "Nobody you are connected to has this file yet";

export class GroupFileDesk {
  private readonly kept = new Map<string, Kept>();
  /** `<group>\n<message id>` → local id. */
  private readonly byMessage = new Map<string, string>();
  private readonly wants = new Map<string, Want>();
  private readonly edgesById = new Map<string, Edge>();
  /** My file about to be announced, by `<group>\n<digest>`: the message that announces it takes this local id. */
  private readonly own = new Map<string, string>();
  /** Announcements sent per group, and taken per member of a group (WISP 503 § Rules for both, Pace). */
  private readonly sentPace = new Map<string, RateWindow>();
  private readonly takenPace = new Map<string, RateWindow>();
  /** `<group>\n<message id>` a `group-have` named before its message came → its holders, newest first. */
  private readonly ahead = new Map<string, string[]>();
  /** A community's ids for its next `group-have`, and when one last went. */
  private readonly communityHave = new Map<string, { ids: Set<string>; at: number }>();
  /** Bytes served today, and the day (UTC days since the epoch). */
  private served = { day: 0, bytes: 0 };

  constructor(private readonly deps: GroupFileDeps) {}

  // -- what the groups hand over -------------------------------------------------------------------------------

  /** At start: each group's files as they were kept. One fetched by itself, or asked for, and not here yet is asked for again. */
  async load(groupIds: string[]): Promise<void> {
    for (const groupId of groupIds) {
      for (const file of await this.deps.store.list(groupId).catch(() => [])) {
        if (!file.group || !file.metadata || !file.digest || this.kept.has(file.id)) continue;
        const { name, size, mime, voice, video, image } = file.metadata;
        const kept: Kept = { id: file.id, groupId, message: file.group.message, author: file.group.author,
          meta: { name, size, mime, d: file.digest, ...(voice && { voice }), ...(video && { video }), ...(image && { image }) },
          mine: file.direction === "out", auto: !!file.group.auto, asked: !!file.group.asked, held: file.transfer?.state === "done", holders: [] };
        this.add(kept);
        if (kept.held) this.show(kept, { state: "done", transferred: size, size, direction: kept.mine ? "out" : "in" });
        else if (kept.auto || kept.asked) this.wants.set(kept.id, this.newWant());
        else this.show(kept, { state: "transferring", stage: "asking", transferred: 0, size, direction: "in" });
      }
    }
    for (const [id] of this.wants) this.ask(this.kept.get(id)!);
    this.deps.changed();
  }

  /** An error when this group took as many announcements of mine as it takes in a minute; null when one may go now. */
  mayAnnounce(groupId: string): string | null {
    const pace = this.pace(this.sentPace, groupId, GROUP_FILE_LIMITS.announcePerMinute, 60_000);
    return pace.wait() ? "You sent many files to this group just now. Wait a minute." : null;
  }

  /** My file, stored under `fileId` with the author's digest, is about to be announced in the group: its message takes it. */
  outgoing(groupId: string, fileId: string, meta: GroupFileMeta): void {
    this.own.set(`${groupId}\n${meta.d}`, fileId);
  }
  /** The announcement did not go: the file is not this group's after all. */
  notSent(groupId: string, meta: GroupFileMeta): void { this.own.delete(`${groupId}\n${meta.d}`); }

  /**
   * A message of the group announces a file (mine, or a member's): the file its row shows, or none when the member
   * announced more than the group takes (its text shows). A member's is kept here unfetched, and fetched now when it is
   * one this device takes by itself. The same message again (a catch-up, a whole copy) is the same file.
   */
  async announced(groupId: string, m: { id: string; sender: string; file: GroupFileMeta }, me: string): Promise<MessageFile | undefined> {
    const known = this.byMessage.get(`${groupId}\n${m.id}`);
    if (known) return messageFile(this.kept.get(known)!);
    const ownId = m.sender === me ? this.own.get(`${groupId}\n${m.file.d}`) : undefined;
    if (ownId) {
      this.own.delete(`${groupId}\n${m.file.d}`);
      this.pace(this.sentPace, groupId, GROUP_FILE_LIMITS.announcePerMinute, 60_000).take();
      const kept: Kept = { id: ownId, groupId, message: m.id, author: me, meta: m.file, mine: true, auto: false, asked: false, held: true, holders: [] };
      this.add(kept);
      const transfer = { state: "done" as const, transferred: m.file.size, size: m.file.size };
      await this.deps.store.patch(ownId, { group: { message: m.id, author: me }, transfer }).catch(() => {});
      this.show(kept, { ...transfer, direction: "out" });
      this.queueHave(kept);
      return messageFile(kept);
    }
    // More from one member than a group takes: past it, the text shows and nothing is fetched (WISP 503, Pace).
    if (!this.pace(this.takenPace, `${groupId}\n${m.sender}`, GROUP_FILE_LIMITS.announceTaken, GROUP_FILE_LIMITS.announceWindowMs).take()) return undefined;
    const id = groupFileId(groupId, "in");
    const auto = this.deps.settings().autoDownloads && fetchesByItself(m.file, this.keptAutomatically(groupId));
    const holders = this.ahead.get(`${groupId}\n${m.id}`) ?? [];
    this.ahead.delete(`${groupId}\n${m.id}`);
    const kept: Kept = { id, groupId, message: m.id, author: m.sender, meta: m.file, mine: false, auto, asked: false, held: false, holders };
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
    if (!kept.asked) {
      kept.asked = true;
      await this.deps.store.patch(kept.id, { group: this.groupField(kept) }).catch(() => {});
    }
    const want = this.wants.get(kept.id);
    // Asked again: every holder is worth asking again.
    if (!want) this.wants.set(kept.id, this.newWant());
    else if (!want.wire) want.tried.clear();
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
      want.wire = frame.id;
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
      else want.tried.clear();
      this.ask(kept);
    }
    for (const edge of this.edgesById.values()) {
      if (!edge.have.size || now - edge.haveAt < GROUP_FILE_LIMITS.haveEveryMs || !this.deps.ready(edge.linkId)) continue;
      this.sendHave(edge, [...edge.have]);
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

  /** Wants of this group that wait for a holder: asked now (an edge came up, or a member said it holds something). */
  private retry(groupId: string): void {
    for (const [id, want] of this.wants) {
      const kept = this.kept.get(id);
      if (kept?.groupId === groupId && !want.holder) this.ask(kept);
    }
  }

  /**
   * Asks the next holder for a file: the author first while its edge is up, then the holders whose edge is up. Only over
   * an edge this device has. (A private group past 16 members, or a community, reaches a holder it has no edge with
   * over a file session of the two members, WISP 503 § The file session; that session is not built yet, so such a
   * holder is not asked, and the file waits for one that is reachable.)
   */
  private ask(kept: Kept): void {
    const want = this.wants.get(kept.id);
    if (!want || kept.held || want.wire) return;
    const membership = this.deps.membership(kept.groupId);
    const edges = this.deps.edges(kept.groupId);
    const order = [kept.author, ...kept.holders.filter(key => key !== kept.author)]
      .filter(key => membership && key !== membership.me && membership.inRoster(key) && !want.tried.has(key));
    for (const key of order) {
      const linkId = edges.get(key);
      if (!linkId || !this.deps.ready(linkId) || !this.edgesById.get(linkId)?.files.live) continue;
      if (!this.deps.send(linkId, { t: GROUP_WANT_FRAME, g: kept.groupId, id: kept.message })) { want.tried.add(key); continue; }
      Object.assign(want, { holder: key, linkId, at: this.deps.now() });
      this.show(kept, { state: "transferring", stage: "queued", transferred: 0, size: kept.meta.size, direction: "in" });
      return;
    }
    Object.assign(want, { holder: undefined, linkId: undefined, at: this.deps.now() });
    this.show(kept, { state: "transferring", stage: "waiting", transferred: 0, size: kept.meta.size, direction: "in", note: NOBODY_CONNECTED });
  }

  /** A holder's no: the next one is asked. One that deleted the file is no holder any more. */
  private refused(groupId: string, peer: string, linkId: string, messageId: string, why: GroupWantRefusal): void {
    const kept = this.kept.get(this.byMessage.get(`${groupId}\n${messageId}`) ?? "");
    const want = kept && this.wants.get(kept.id);
    if (!kept || !want || want.linkId !== linkId || want.wire) return;
    if (why === "gone") kept.holders = kept.holders.filter(key => key !== peer);
    want.tried.add(peer);
    want.holder = want.linkId = undefined;
    this.ask(kept);
  }

  /** A member says it holds these files: remembered as a holder of each (newest first), and asked when a want waits. */
  private heard(groupId: string, from: string, ids: string[]): void {
    const membership = this.deps.membership(groupId);
    if (!membership || from === membership.me || !membership.inRoster(from)) return;
    const newest = (holders: string[]) => [from, ...holders.filter(key => key !== from)].slice(0, GROUP_FILE_LIMITS.holders);
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
      const want = this.wants.get(kept.id);
      if (!want) continue;
      want.tried.delete(from);
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
    const active = this.servingNow();
    if (active.length >= GROUP_FILE_LIMITS.serveAtOnce || active.some(a => a.peer === edge.peer)) return "busy";
    const today = Math.floor(this.deps.now() / 86_400_000);
    if (this.served.day !== today) this.served = { day: today, bytes: 0 };
    const reserved = active.reduce((sum, a) => sum + a.size, 0);
    return this.served.bytes + reserved + kept.meta.size > GROUP_FILE_LIMITS.serveBytesPerDay ? "busy" : null;
  }

  /** Transfers served now, all groups together: to whom, and their size. */
  private servingNow(): { peer: string; size: number }[] {
    const active: { peer: string; size: number }[] = [];
    for (const edge of this.edgesById.values()) for (const wire of edge.serving.keys()) {
      const record = edge.files.get("out", wire);
      if (record && !transferEnded(record)) active.push({ peer: edge.peer, size: record.file.size });
    }
    return active;
  }

  /** Says on an edge which files this device holds. */
  private sendHave(edge: Edge, ids: string[]): void {
    for (let i = 0; i < ids.length; i += GROUP_FILE_LIMITS.haveIds) {
      if (!this.deps.send(edge.linkId, { t: GROUP_HAVE_FRAME, g: edge.groupId, ids: ids.slice(i, i + GROUP_FILE_LIMITS.haveIds) })) return;
    }
    edge.have.clear();
    edge.haveAt = this.deps.now();
  }

  /** This device holds a new file: the group hears it with the next `group-have` (batched, `haveEveryMs` at most on an edge). */
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
    const edge: Edge = { linkId, groupId, peer, files: undefined as unknown as ChatFiles, serving: new Map(), taking: new Map(), have: new Set(), haveAt: 0 };
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
      writable: () => this.deps.writable?.(linkId),
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
    // What an earlier holder's transfer left is gone first.
    await kept.idle;
    const writer = await this.deps.store.write(kept.id);
    return {
      offset: 0,
      append: bytes => writer.append(bytes),
      flush: () => writer.flush(),
      // Against the author's digest, read back from storage, not the holder's word: a holder can withhold a file, never
      // serve another one.
      verify: async () => (await writer.digest()) === kept.meta.d,
      discard: () => (kept.idle = writer.discard().catch(() => {})),
    };
  }

  private async openSource(edge: Edge, record: FileTransferRecord): Promise<OutgoingSource> {
    const kept = this.kept.get(edge.serving.get(record.id) ?? "");
    const stored = kept && await this.deps.store.get(kept.id);
    if (!kept || !stored) throw new Error("The file is gone");
    return { read: (offset, length) => this.deps.store.read(stored, offset, length), digest: async () => kept.meta.d };
  }

  private transferChanged(edge: Edge, record: FileTransferRecord, transferred: number): void {
    if (record.direction === "out") {
      if (transferEnded(record) && edge.serving.has(record.id)) {
        // What a member took counts toward the day's serving, done or not.
        const today = Math.floor(this.deps.now() / 86_400_000);
        if (this.served.day !== today) this.served = { day: today, bytes: 0 };
        this.served.bytes += record.confirmed;
        edge.serving.delete(record.id);
      }
      return;
    }
    const kept = this.kept.get(edge.taking.get(record.id) ?? ""), want = kept && this.wants.get(kept.id);
    // A transfer this device moved on from (the holder stalled, then went on) changes nothing.
    if (!kept || !want || want.wire !== record.id || want.linkId !== edge.linkId) return;
    if (transferred !== want.moved) { want.moved = transferred; want.movedAt = this.deps.now(); }
    const { size } = kept.meta;
    switch (record.state) {
      case "done": {
        kept.held = true;
        this.wants.delete(kept.id);
        edge.taking.delete(record.id);
        void this.deps.store.patch(kept.id, { transfer: { state: "done", transferred: size, size } }).catch(() => {});
        this.show(kept, { state: "done", transferred: size, size, direction: "in" });
        this.queueHave(kept);
        return;
      }
      case "failed": case "declined": case "cancelled":
        // Damaged (refused, its bytes deleted), stopped by the holder or left here: the next holder is asked.
        edge.taking.delete(record.id);
        if (want.holder) want.tried.add(want.holder);
        Object.assign(want, { wire: undefined, holder: undefined, linkId: undefined, moved: 0 });
        this.ask(kept);
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
    return { message: kept.message, author: kept.author, ...(kept.auto && { auto: true }), ...(kept.asked && { asked: true }) };
  }

  private pace(windows: Map<string, RateWindow>, key: string, limit: number, ms: number): RateWindow {
    let window = windows.get(key);
    if (!window) windows.set(key, (window = new RateWindow(limit, ms, () => this.deps.now())));
    return window;
  }

  private show(kept: Kept, view: FileTransferView): void {
    this.deps.transfers.set(kept.id, view);
    this.deps.changed();
  }
}

function messageFile(kept: Kept): MessageFile {
  const { name, size, mime, voice, video, image } = kept.meta;
  return { id: kept.id, name, size, mime, ...(voice && { voice }), ...(video && { video }), ...(image && { image }) };
}
