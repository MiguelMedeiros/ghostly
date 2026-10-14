import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { GROUP_FILE_LIMITS, fileMessageText, groupFileFallback, type GroupFileMeta } from "@ghostly/core";
import { CommunityWorld, type Peer } from "./communityWorld";
import { groupFileId, type GroupFileStore, type GroupFileWriter } from "../src/engine/groupFiles";
import type { StoredFile } from "../src/shared/idb";
import { waitingGroupFile } from "../src/shared/storedFiles";
import type { FileTransferView } from "../src/shared/types";
// covers: groups.files, groups.files.wire

/**
 * Files in groups on headless engines (WISP 503 · Group Files): a file announced in a group reaches every member's
 * device from whoever holds it, over files/3 on their edges, checked against the author's digest. Each peer keeps its
 * files in memory; the world carries the edges' files/3 frames as it carries the group's.
 */

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("base64url");
const concat = (parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const pattern = (size: number, seed = 1) => { const out = new Uint8Array(size); for (let i = 0; i < size; i++) out[i] = (i * 31 + seed * 7 + (i >>> 11)) & 0xff; return out; };

/** A device's files store and file storage, in memory. */
class MemoryFiles implements GroupFileStore {
  readonly records = new Map<string, StoredFile>();
  readonly bytes = new Map<string, Uint8Array>();
  /** Its copies went bad: what it serves is not what it stored. */
  corrupt = false;
  async list(groupId: string) { return [...this.records.values()].filter(r => r.linkId === `group:${groupId}`).map(r => ({ ...r })); }
  async groups() { return [...new Set([...this.records.values()].filter(r => r.linkId.startsWith("group:")).map(r => r.linkId.slice("group:".length)))]; }
  async get(id: string) { const record = this.records.get(id); return record && { ...record }; }
  async put(file: StoredFile) { this.records.set(file.id, { ...file }); }
  async patch(id: string, fields: Pick<StoredFile, "transfer" | "group">) { const record = this.records.get(id); if (record) this.records.set(id, { ...record, ...fields }); }
  async remove(id: string) { this.records.delete(id); this.bytes.delete(id); }
  async write(id: string, resume = false): Promise<GroupFileWriter> {
    const before = resume ? this.bytes.get(id) : undefined;
    const parts: Uint8Array[] = before ? [before] : [];
    this.bytes.delete(id);
    const keep = () => this.bytes.set(id, concat(parts));
    return {
      offset: before?.length ?? 0,
      append: async bytes => { parts.push(bytes.slice()); },
      flush: async () => { keep(); },
      digest: async () => { keep(); return sha(this.bytes.get(id)!); },
      close: async () => { keep(); },
      discard: async () => { parts.length = 0; this.bytes.delete(id); },
    };
  }
  async read(file: StoredFile, offset: number, length: number) {
    const bytes = this.bytes.get(file.id);
    if (!bytes) throw new Error("The file is gone");
    const part = bytes.slice(offset, offset + length);
    if (this.corrupt && offset === 0 && part.length) part[0] ^= 0xff;
    return part;
  }
  async room() { return null; }
}

/** `brief`: views that go in the next state the engine sends, and then away (as the engine's `dropBriefViews`, `sent`). */
interface Files { store: MemoryFiles; transfers: Map<string, FileTransferView>; brief: Map<string, FileTransferView>; settings: { autoDownloads: boolean; serveFiles: boolean } }

/** Frames on the edges, as they went: who to whom, and the frame. */
type Seen = { from: string; to: string; frame: Record<string, unknown> }[];

const limits = GROUP_FILE_LIMITS as { -readonly [K in keyof typeof GROUP_FILE_LIMITS]: number };
const saved = { ...limits };
afterEach(() => { Object.assign(limits, saved); });

class FilesWorld {
  readonly world = new CommunityWorld();
  readonly files = new Map<Peer, Files>();
  readonly seen: Seen = [];
  /** Holds files/3 frames on their way (a slow network) while it says so; `release` delivers them. */
  hold: ((from: Peer, to: Peer, frame: Record<string, unknown>) => boolean) | null = null;
  private held: { from: Peer; to: Peer; frame: Record<string, unknown> }[] = [];

  constructor() {
    this.world.drop = (from, to, frame) => {
      this.seen.push({ from: from.name, to: to.name, frame });
      if (!this.hold?.(from, to, frame)) return false;
      this.held.push({ from, to, frame });
      return true;
    };
  }

  release(groupId: string): void {
    this.hold = null;
    for (const { from, to, frame } of this.held.splice(0)) this.world.sendFiles(from, from.host.edges(groupId).get(this.key(to, groupId))!, frame);
  }

  /** `binary`: its edges agreed files/4, so what it serves goes as binary messages. */
  add(name: string, binary = false): Peer {
    const files: Files = { store: new MemoryFiles(), transfers: new Map(), brief: new Map(), settings: { autoDownloads: true, serveFiles: true } };
    const brief = (id: string) => { const view = files.transfers.get(id); if (view) files.brief.set(id, view); };
    const peer = this.world.add(name, p => ({ groupFiles: { store: files.store, transfers: files.transfers, brief, settings: () => files.settings, sendFiles: (linkId, frame) => this.world.sendFiles(p, linkId, frame),
      ...(binary && { sendData: (linkId: string, id: string, offset: number, data: Uint8Array) => this.world.sendData(p, linkId, id, offset, data) }) } }));
    this.files.set(peer, files);
    return peer;
  }

  /** A private group of `names`, the first its admin, everyone's edges up. */
  async mesh(names: string[], binary = false): Promise<{ peers: Peer[]; id: string }> {
    const [admin, ...rest] = names.map(name => this.add(name, binary));
    const id = await admin.groups.create("Files", "mesh");
    const link = await admin.groups.enableLink(id);
    for (const p of rest) await p.groups.joinByLink(link);
    const peers = [admin, ...rest];
    await this.world.until(() => peers.every(p => this.world.view(p, id)?.members.length === peers.length && this.world.view(p, id)!.members.every(m => m.online)), 20 * 60_000, 1000);
    return { peers, id };
  }

  key(peer: Peer, id: string): string { return this.world.view(peer, id)!.myKey!; }

  /**
   * A member's app starts again on what it kept: its new engine holds no transfer yet, and hears its edges' sessions
   * open, as an app's does.
   */
  async restart(peer: Peer): Promise<void> {
    this.files.get(peer)!.transfers.clear();
    this.files.get(peer)!.brief.clear();
    await this.world.restart(peer);
    for (const edge of peer.links.values()) edge.announced = false;
  }

  /** As the app's composer and the CLI do: the bytes kept under a local id with their digest, then the announcement. */
  async send(peer: Peer, groupId: string, bytes: Uint8Array, meta: Partial<GroupFileMeta> = {}, caption?: string): Promise<{ messageId: string; fileId: string; meta: GroupFileMeta }> {
    const store = this.files.get(peer)!.store, fileId = groupFileId(groupId, "out"), d = sha(bytes);
    const file: GroupFileMeta = { name: "notes.bin", mime: "application/octet-stream", size: bytes.length, d, ...meta };
    store.bytes.set(fileId, bytes);
    await store.put({ id: fileId, linkId: `group:${groupId}`, direction: "out", digest: d, createdAt: this.world.now,
      metadata: { name: file.name, size: file.size, mime: file.mime, timestamp: this.world.now, voice: file.voice } });
    const sent = await peer.groups.sendFile(groupId, caption ?? groupFileFallback(file), file, fileId);
    expect(sent.error).toBeNull();
    return { messageId: sent.messageId!, fileId, meta: file };
  }

  /** The engine sent a state: the brief views it carried go. */
  sent(peer: Peer): void {
    const { transfers, brief } = this.files.get(peer)!;
    for (const [id, view] of brief) if (transfers.get(id) === view) transfers.delete(id);
    brief.clear();
  }

  /**
   * The file a member's history shows for a message, its transfer here (as its bubble reads it: one that shows none
   * and is not here waits for a Download, its record says), and the bytes it stored.
   */
  got(peer: Peer, groupId: string, messageId: string) {
    const message = peer.messages.find(m => m.linkId === `group:${groupId}` && m.id === messageId);
    const files = this.files.get(peer)!, id = message?.file?.id;
    const transfer = id ? files.transfers.get(id) ?? waitingGroupFile(files.store.records.get(id)) ?? undefined : undefined;
    return { message, transfer, bytes: id ? files.store.bytes.get(id) : undefined };
  }

  /** All here: its transfer says so, or (one that shows none, as after a start) its record. */
  done(peer: Peer, groupId: string, messageId: string): boolean {
    const { message, transfer } = this.got(peer, groupId, messageId);
    const record = message?.file && this.files.get(peer)!.store.records.get(message.file.id);
    return (transfer ?? record?.transfer)?.state === "done";
  }

  /** A frame one member's app sends another over their edge, as its app would. */
  say(from: Peer, to: Peer, groupId: string, frame: Record<string, unknown>): void {
    from.host.sendOnLink(from.host.edges(groupId).get(this.key(to, groupId))!, frame);
  }
}

describe("a file in a private group", { timeout: 120_000 }, () => {
  it("reaches both other members of a group of three, each copy checked against the author's digest", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob, carol], id } = await t.mesh(["alice", "bob", "carol"]);
    const bytes = pattern(300_000);
    const { messageId, fileId, meta } = await t.send(alice, id, bytes, { name: "report.pdf", mime: "application/pdf" });
    // Mine at once: held here, shown as the file, not as the line older apps show.
    expect(t.got(alice, id, messageId)).toMatchObject({ message: { file: { id: fileId, name: "report.pdf" }, text: fileMessageText(meta) }, transfer: { state: "done", direction: "out" } });
    await t.world.until(() => t.done(bob, id, messageId) && t.done(carol, id, messageId), 60_000);
    for (const member of [bob, carol]) {
      const got = t.got(member, id, messageId);
      expect(got.message).toMatchObject({ text: fileMessageText(meta), file: { name: "report.pdf", size: bytes.length, mime: "application/pdf" } });
      expect(got.message!.file!.id).toMatch(new RegExp(`^group-${id}-in-`));
      expect(sha(got.bytes!)).toBe(meta.d);
      expect(t.files.get(member)!.store.records.get(got.message!.file!.id)).toMatchObject({ transfer: { state: "done" }, group: { message: messageId, auto: true } });
    }
    // Asked of the author, its offers naming the message; no chat of the edge took a byte.
    expect(t.seen.filter(s => s.frame.t === "group-want").map(s => s.to).sort()).toEqual(["alice", "alice"]);
    expect(t.seen.filter(s => s.frame.t === "pf-offer").every(s => s.from === "alice" && s.frame.gm === messageId)).toBe(true);
  });

  it("over edges that agreed files/4 the bytes go as binary messages, and each copy is checked against the author's digest", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob, carol], id } = await t.mesh(["alice", "bob", "carol"], true);
    const bytes = pattern(5 * 16 * 1024 + 99, 4);
    const { messageId } = await t.send(alice, id, bytes);
    await t.world.until(() => t.done(bob, id, messageId) && t.done(carol, id, messageId), 5 * 60_000, 500);
    expect(t.got(bob, id, messageId).bytes).toEqual(bytes);
    expect(t.got(carol, id, messageId).bytes).toEqual(bytes);
    const data = t.seen.filter(s => s.frame.t === "pf-data");
    expect(data.length).toBeGreaterThanOrEqual(12);
    expect(data.every(s => s.frame.data instanceof Uint8Array)).toBe(true);
  });

  it("the pace and not being in the group are known before the bytes are copied in, as the announcement answers them", async () => {
    limits.announcePerMinute = 1;
    const t = new FilesWorld();
    const { peers: [alice], id } = await t.mesh(["alice", "bob"]);
    expect(alice.groups.fileCheck(id)).toEqual({ error: null });
    await t.send(alice, id, pattern(1_000));
    const paced = "You sent many files to this group just now. Wait a minute.";
    expect(alice.groups.fileCheck(id)).toEqual({ error: paced });
    const fileId = groupFileId(id, "out");
    expect(await alice.groups.sendFile(id, "again", { name: "a.bin", mime: "application/octet-stream", size: 1, d: sha(new Uint8Array(1)) }, fileId)).toEqual({ error: paced });
    expect(alice.groups.fileCheck("no-such-group")).toEqual({ error: "You are not in this group yet" });
  });

  it("a caption is the text under it; a voice message is fetched by itself", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob], id } = await t.mesh(["alice", "bob"]);
    const voice = { duration: 4_000, peaks: [0, 120, 255, 40] };
    const { messageId } = await t.send(alice, id, pattern(40_000, 3), { name: "voice.webm", mime: "audio/webm", voice }, "Listen to this");
    await t.world.until(() => t.done(bob, id, messageId), 60_000);
    expect(t.got(bob, id, messageId).message).toMatchObject({ text: "Listen to this", file: { voice } });
  });

  it("a voice message past the automatic size, or past what the group fetches by itself, waits for a Download", async () => {
    Object.assign(limits, { autoBytes: 50_000, autoBytesPerGroup: 100_000 });
    const t = new FilesWorld();
    const { peers: [alice, bob], id } = await t.mesh(["alice", "bob"]);
    const voice = { duration: 1_000, peaks: [1, 2, 3] };
    const big = await t.send(alice, id, pattern(60_000, 7), { name: "big.webm", mime: "audio/webm", voice });
    const sent = [];
    for (let i = 0; i < 3; i++) sent.push(await t.send(alice, id, pattern(40_000, 70 + i), { name: `v${i}.webm`, mime: "audio/webm", voice }));
    await t.world.until(() => sent.slice(0, 2).every(({ messageId }) => t.done(bob, id, messageId)), 60_000);
    await t.world.run(5_000);
    for (const { messageId } of [big, sent[2]]) expect(t.got(bob, id, messageId)).toMatchObject({ transfer: { state: "transferring", stage: "asking" }, bytes: undefined });
    expect(t.seen.filter(s => s.frame.t === "group-want").map(s => s.frame.id)).toEqual(sent.slice(0, 2).map(s => s.messageId));
    await bob.groups.downloadFile(t.got(bob, id, big.messageId).message!.file!.id);
    await t.world.until(() => t.done(bob, id, big.messageId), 60_000);
    expect(sha(t.got(bob, id, big.messageId).bytes!)).toBe(big.meta.d);
  });

  it("a member away during the announcement gets it later from a member that is not the author, the author gone", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob, carol], id } = await t.mesh(["alice", "bob", "carol"]);
    carol.online = false;
    await t.world.run(2_000);
    const bytes = pattern(200_000, 5);
    const { messageId, meta } = await t.send(alice, id, bytes);
    await t.world.until(() => t.done(bob, id, messageId), 60_000);
    alice.online = false;
    await t.world.run(2_000);
    t.world.reopen(carol);
    await t.world.until(() => t.done(carol, id, messageId), 5 * 60_000);
    expect(sha(t.got(carol, id, messageId).bytes!)).toBe(meta.d);
    expect(t.seen.filter(s => s.to === "carol" && s.frame.t === "pf-offer").map(s => s.from)).toEqual(["bob"]);
  });

  it("a member back from away gets every file a connected member holds, its app started again and the authors gone, past what one group-have names", async () => {
    const t = new FilesWorld();
    limits.haveIds = 2;
    const { peers: [alice, bob, carol], id } = await t.mesh(["alice", "bob", "carol"]);
    carol.online = false;
    await t.world.run(2_000);
    const sent = [];
    for (let i = 0; i < 5; i++) sent.push(await t.send(alice, id, pattern(20_000, 20 + i), { name: `alice-${i}.bin` }));
    await t.world.until(() => sent.every(s => t.done(bob, id, s.messageId)), 5 * 60_000);
    // Bob's app starts again: what it queued to say is gone, and on an edge that opens it names a few of its files.
    await t.restart(bob);
    alice.online = false;
    await t.world.run(2_000);
    t.world.reopen(carol);
    await t.world.until(() => sent.every(s => t.done(carol, id, s.messageId)), 5 * 60_000);
    for (const s of sent) expect(sha(t.got(carol, id, s.messageId).bytes!)).toBe(s.meta.d);
    expect(new Set(t.seen.filter(s => s.to === "carol" && s.frame.t === "pf-offer").map(s => s.from))).toEqual(new Set(["bob"]));
  });

  it("a Download of an older file, the asker's app started again and the author gone, comes from a connected member that holds it", async () => {
    const t = new FilesWorld();
    limits.haveIds = 1;
    const { peers: [alice, bob, carol], id } = await t.mesh(["alice", "bob", "carol"]);
    t.files.get(carol)!.settings.autoDownloads = false;
    const sent = [];
    for (let i = 0; i < 3; i++) sent.push(await t.send(alice, id, pattern(20_000, 30 + i), { name: `alice-${i}.bin` }));
    await t.world.until(() => sent.every(s => t.done(bob, id, s.messageId)) && sent.every(s => !!t.got(carol, id, s.messageId).message?.file), 5 * 60_000);
    alice.online = false;
    await t.restart(carol);
    await t.world.run(20_000);
    for (const s of sent) {
      await carol.groups.downloadFile(t.got(carol, id, s.messageId).message!.file!.id);
      await t.world.until(() => t.done(carol, id, s.messageId), 2 * 60_000);
      expect(sha(t.got(carol, id, s.messageId).bytes!)).toBe(s.meta.d);
    }
  });

  it("a connected member that does not hold a file is asked for it once, then again when its edge opens again", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob, carol], id } = await t.mesh(["alice", "bob", "carol"]);
    t.files.get(bob)!.settings.autoDownloads = false;
    // Alice's offer to carol never comes, and she goes: carol is left with bob, who did not fetch it.
    t.hold = (from, to, frame) => from === alice && to === carol && frame.t === "pf-offer";
    const { messageId, meta } = await t.send(alice, id, pattern(20_000, 40));
    await t.world.until(() => !!t.got(bob, id, messageId).message?.file && t.seen.some(s => s.from === "carol" && s.to === "alice" && s.frame.t === "group-want"), 60_000);
    alice.online = false;
    const asked = () => t.seen.filter(s => s.from === "carol" && s.to === "bob" && s.frame.t === "group-want").length;
    await t.world.until(() => asked() === 1 && t.got(carol, id, messageId).transfer?.wait === "nobody", 5 * 60_000);
    expect(t.seen.filter(s => s.from === "bob" && s.to === "carol" && s.frame.t === "group-want-no").map(s => s.frame.why)).toEqual(["gone"]);
    // Round after round, bob is not asked again: he said he does not have it.
    await t.world.run(4 * GROUP_FILE_LIMITS.wantWaitMs);
    expect(asked()).toBe(1);
    expect(t.got(carol, id, messageId).transfer).toMatchObject({ state: "transferring", stage: "waiting", wait: "nobody" });
    // His edge opens again: he may have fetched it meanwhile, so he is asked once more.
    bob.online = false;
    await t.world.run(2_000);
    t.world.reopen(bob);
    await t.world.until(() => asked() === 2, 5 * 60_000);
    await t.world.run(4 * GROUP_FILE_LIMITS.wantWaitMs);
    expect(asked()).toBe(2);
    // The author is back: the file comes.
    t.hold = null;
    t.world.reopen(alice);
    await t.world.until(() => t.done(carol, id, messageId), 5 * 60_000);
    expect(sha(t.got(carol, id, messageId).bytes!)).toBe(meta.d);
  });

  it("a holder serving other bytes is refused as damaged, and the next holder is asked", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob, carol], id } = await t.mesh(["alice", "bob", "carol"]);
    carol.online = false;
    await t.world.run(2_000);
    const { messageId, meta } = await t.send(alice, id, pattern(150_000, 9));
    await t.world.until(() => t.done(bob, id, messageId), 60_000);
    // The author's copy goes bad: what it serves no longer matches the digest it signed.
    t.files.get(alice)!.store.corrupt = true;
    t.world.reopen(carol);
    await t.world.until(() => t.done(carol, id, messageId), 5 * 60_000);
    expect(sha(t.got(carol, id, messageId).bytes!)).toBe(meta.d);
    expect(t.seen.some(s => s.from === "carol" && s.to === "alice" && s.frame.t === "pf-refuse" && s.frame.why === "damaged")).toBe(true);
    expect(t.seen.filter(s => s.to === "carol" && s.frame.t === "pf-offer").map(s => s.from)).toEqual(["alice", "bob"]);
  });

  it("a file every holder serves damaged is fetched once, then shows it arrived damaged until Download asks again", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob], id } = await t.mesh(["alice", "bob"]);
    // The author's copy (or the author) serves bytes that do not match the digest it signed, and nobody else holds it.
    t.files.get(alice)!.store.corrupt = true;
    const { messageId, meta } = await t.send(alice, id, pattern(200_000, 3));
    await t.world.run(10 * 60_000);
    const damaged = () => t.seen.filter(s => s.from === "bob" && s.frame.t === "pf-refuse" && s.frame.why === "damaged").length;
    expect(damaged()).toBe(1);
    const { message, transfer } = t.got(bob, id, messageId);
    expect(transfer).toMatchObject({ state: "failed", direction: "in", retry: true, error: expect.stringContaining("damaged") });
    // Kept so: a restart does not fetch it again by itself.
    expect(t.files.get(bob)!.store.records.get(message!.file!.id)!.transfer).toMatchObject({ state: "failed" });
    // Cancelled, it waits for a Download as any other, its record too: it shows no transfer once a state carried that.
    await bob.groups.haltFile(message!.file!.id);
    t.sent(bob);
    expect(t.files.get(bob)!.transfers.has(message!.file!.id)).toBe(false);
    expect(t.got(bob, id, messageId).transfer).toMatchObject({ state: "transferring", stage: "asking" });
    // Download asks every holder again: the author's copy is good now.
    t.files.get(alice)!.store.corrupt = false;
    await bob.groups.downloadFile(message!.file!.id);
    await t.world.until(() => t.done(bob, id, messageId), 60_000);
    expect(sha(t.got(bob, id, messageId).bytes!)).toBe(meta.d);
    expect(damaged()).toBe(1);
  });

  it("a file that cannot come says why: its only holder busy, or its bytes damaged (with Ask again)", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob], id } = await t.mesh(["alice", "bob"]);
    // Alice's edge is up and she answers: busy, serving turned off.
    t.files.get(alice)!.settings.serveFiles = false;
    const one = await t.send(alice, id, pattern(50_000, 1));
    await t.world.until(() => t.seen.some(s => s.from === "alice" && s.to === "bob" && s.frame.t === "group-want-no"), 60_000);
    await t.world.run(1_000);
    expect(t.got(bob, id, one.messageId).transfer).toMatchObject({ state: "transferring", stage: "waiting", wait: "busy" });
    expect(t.got(bob, id, one.messageId).transfer!.stalled).toBeUndefined();
    // Her copy goes bad: what she serves fails the author's digest.
    t.files.get(alice)!.settings.serveFiles = true;
    t.files.get(alice)!.store.corrupt = true;
    const two = await t.send(alice, id, pattern(50_000, 2));
    await t.world.until(() => t.seen.some(s => s.from === "bob" && s.frame.t === "pf-refuse" && s.frame.why === "damaged"), 60_000);
    await t.world.run(1_000);
    // Nobody else holds it: it is fetched no more, and its person can ask again.
    expect(t.got(bob, id, two.messageId).transfer).toMatchObject({ state: "failed", retry: true, error: expect.stringContaining("damaged") });
    // Nobody else in reach: the line for that, not a stale cause.
    alice.online = false;
    await t.world.run(GROUP_FILE_LIMITS.wantWaitMs + 2_000);
    expect(t.got(bob, id, one.messageId).transfer).toMatchObject({ stage: "waiting", wait: "nobody" });
  });

  it("a damaged copy, its other holder out of reach, waits as damaged with Ask again, then as nobody having it", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob, carol], id } = await t.mesh(["alice", "bob", "carol"]);
    carol.online = false;
    await t.world.run(2_000);
    const { messageId } = await t.send(alice, id, pattern(150_000, 9));
    await t.world.until(() => t.done(bob, id, messageId), 60_000);
    t.files.get(alice)!.store.corrupt = true;
    // Bob's copy is known here, and his offer of it never comes.
    t.hold = (from, to, frame) => from === bob && to === carol && frame.t === "pf-offer";
    t.world.reopen(carol);
    await t.world.until(() => t.seen.some(s => s.from === "carol" && s.to === "alice" && s.frame.t === "pf-refuse" && s.frame.why === "damaged"), 5 * 60_000);
    await t.world.until(() => t.got(carol, id, messageId).transfer?.wait === "damaged", GROUP_FILE_LIMITS.wantWaitMs + 2_000);
    expect(t.got(carol, id, messageId).transfer).toMatchObject({ state: "transferring", stage: "waiting", wait: "damaged", stalled: true });
    bob.online = false;
    await t.world.run(2 * GROUP_FILE_LIMITS.wantWaitMs + 2_000);
    expect(t.got(carol, id, messageId).transfer).toMatchObject({ state: "transferring", stage: "waiting", wait: "nobody" });
  });

  it("a holder that stalls mid-way is left, and the next holder goes on from the bytes stored here", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob, carol], id } = await t.mesh(["alice", "bob", "carol"]);
    carol.online = false;
    await t.world.run(2_000);
    const size = 600_000, cut = 256 * 1024;
    const { messageId, meta } = await t.send(alice, id, pattern(size, 11));
    await t.world.until(() => t.done(bob, id, messageId), 60_000);
    // Alice's bytes to Carol stop coming past the first 256 KiB, as when her app is killed mid-way.
    t.hold = (from, to, frame) => from === alice && to === carol && frame.t === "pf-data" && (frame.offset as number) >= cut;
    t.world.reopen(carol);
    await t.world.until(() => t.seen.some(s => s.from === "carol" && s.to === "bob" && s.frame.t === "pf-accept"), 5 * 60_000);
    const accepted = t.seen.find(s => s.from === "carol" && s.to === "bob" && s.frame.t === "pf-accept")!.frame;
    expect(accepted.offset).toBe(cut);
    await t.world.until(() => t.done(carol, id, messageId), 5 * 60_000);
    expect(sha(t.got(carol, id, messageId).bytes!)).toBe(meta.d);
    const fromBob = t.seen.filter(s => s.from === "bob" && s.to === "carol" && s.frame.t === "pf-data").map(s => s.frame.offset as number);
    expect(Math.min(...fromBob)).toBe(cut);
  });

  it("a holder serving bad bytes then stalling does not get the next holder blamed", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob, carol], id } = await t.mesh(["alice", "bob", "carol"]);
    carol.online = false;
    await t.world.run(2_000);
    const size = 600_000, cut = 256 * 1024;
    const { messageId, meta } = await t.send(alice, id, pattern(size, 11));
    await t.world.until(() => t.done(bob, id, messageId), 60_000);
    // Alice's first byte goes bad, then her bytes to Carol stop past the first 256 KiB.
    t.files.get(alice)!.store.corrupt = true;
    t.hold = (from, to, frame) => from === alice && to === carol && frame.t === "pf-data" && (frame.offset as number) >= cut;
    t.world.reopen(carol);
    await t.world.until(() => t.done(carol, id, messageId), 10 * 60_000);
    expect(sha(t.got(carol, id, messageId).bytes!)).toBe(meta.d);
    // Bob's tail on Alice's bad prefix failed the check: Bob was asked again from 0, never refused as damaged twice.
    const toBob = t.seen.filter(s => s.from === "carol" && s.to === "bob" && s.frame.t === "pf-accept").map(s => s.frame.offset);
    expect(toBob).toEqual([cut, 0]);
  });

  it("a holder that served damaged bytes is not asked again however often it says it holds the file", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob, carol], id } = await t.mesh(["alice", "bob", "carol"]);
    carol.online = false;
    await t.world.run(2_000);
    const size = 200_000;
    const { messageId } = await t.send(alice, id, pattern(size, 12));
    await t.world.until(() => t.done(bob, id, messageId), 60_000);
    alice.online = false;
    t.files.get(bob)!.store.corrupt = true;
    t.world.reopen(carol);
    const damaged = () => t.seen.filter(s => s.from === "carol" && s.to === "bob" && s.frame.t === "pf-refuse" && s.frame.why === "damaged").length;
    await t.world.until(() => damaged() === 1, 5 * 60_000);
    for (let i = 0; i < 30; i++) { t.say(bob, carol, id, { t: "group-have", g: id, ids: [messageId] }); await t.world.run(2_000); }
    expect(damaged()).toBe(1);
    const data = t.seen.filter(s => s.from === "bob" && s.to === "carol" && s.frame.t === "pf-data").length;
    expect(data * 16 * 1024).toBeLessThanOrEqual(2 * size);
  });

  it("a holder whose damaged bytes come in two parts, the first stalled, is not asked for the file again and again", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob, carol], id } = await t.mesh(["alice", "bob", "carol"]);
    carol.online = false;
    await t.world.run(2_000);
    const size = 600_000, cut = 256 * 1024;
    const { messageId } = await t.send(alice, id, pattern(size, 13));
    await t.world.until(() => t.done(bob, id, messageId), 60_000);
    alice.online = false;
    // Bob's copy is bad, and what he serves from 0 stops past the first 256 KiB; what he serves from there comes whole.
    t.files.get(bob)!.store.corrupt = true;
    const from = new Map<unknown, unknown>();
    t.hold = (sender, to, frame) => {
      if (sender === carol && frame.t === "pf-accept") from.set(frame.id, frame.offset);
      return sender === bob && to === carol && frame.t === "pf-data" && from.get(frame.id) === 0 && (frame.offset as number) >= cut;
    };
    t.world.reopen(carol);
    await t.world.run(10 * GROUP_FILE_LIMITS.wantWaitMs);
    const damaged = t.seen.filter(s => s.from === "carol" && s.to === "bob" && s.frame.t === "pf-refuse" && s.frame.why === "damaged").length;
    expect(damaged).toBe(1);
    expect(t.seen.filter(s => s.from === "carol" && s.to === "bob" && s.frame.t === "pf-accept").length).toBe(2);
  });

  it(`a member's group-have is taken at most ${GROUP_FILE_LIMITS.haveFrames} times in ${GROUP_FILE_LIMITS.haveWindowMs / 1000} seconds on an edge`, async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob, carol], id } = await t.mesh(["alice", "bob", "carol"]);
    t.files.get(bob)!.settings.autoDownloads = false;
    t.hold = (from, to, frame) => from === alice && to === carol && frame.t === "pf-offer";
    const { messageId } = await t.send(alice, id, pattern(20_000, 14));
    await t.world.until(() => !!t.got(bob, id, messageId).message?.file && t.seen.some(s => s.from === "carol" && s.to === "alice" && s.frame.t === "group-want"), 60_000);
    alice.online = false;
    const asked = () => t.seen.filter(s => s.from === "carol" && s.to === "bob" && s.frame.t === "group-want").length;
    await t.world.until(() => asked() === 1 && t.got(carol, id, messageId).transfer?.wait === "nobody", 5 * 60_000);
    // Bob says he holds it, again and again, and answers `gone` each time he is asked.
    for (let i = 0; i < 50; i++) { t.say(bob, carol, id, { t: "group-have", g: id, ids: [messageId] }); await t.world.run(100, 100); }
    expect(asked()).toBeLessThanOrEqual(1 + GROUP_FILE_LIMITS.haveFrames);
  });

  it("an offer nobody asked for is refused, and nothing is stored", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob], id } = await t.mesh(["alice", "bob"]);
    t.files.get(bob)!.settings.autoDownloads = false;
    const { messageId, meta } = await t.send(alice, id, pattern(50_000));
    await t.world.run(3_000);
    expect(t.got(bob, id, messageId).transfer).toMatchObject({ state: "transferring", stage: "asking" });
    // Alice pushes the file at Bob without his asking: refused, whatever message it names.
    const edge = alice.host.edges(id).get(t.key(bob, id))!;
    t.world.sendFiles(alice, edge, { t: "pf-offer", id: "pushed-file-0001", name: meta.name, mime: meta.mime, size: meta.size, ts: Date.now(), gm: messageId });
    await t.world.run(2_000);
    expect(t.seen.some(s => s.from === "bob" && s.frame.t === "pf-refuse" && s.frame.id === "pushed-file-0001" && s.frame.why === "invalid")).toBe(true);
    expect(t.got(bob, id, messageId).bytes).toBeUndefined();
    expect(t.got(bob, id, messageId).transfer).toMatchObject({ stage: "asking" });
  });

  it("a holder keeps the records of an edge's last few ended transfers only, however many it offered", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob], id } = await t.mesh(["alice", "bob"]);
    const { messageId } = await t.send(alice, id, pattern(4_096));
    await t.world.until(() => t.done(bob, id, messageId), 60_000);
    const records = (p: Peer) => [...(p.groups.files as unknown as { edgesById: Map<string, { files: { records(): { state: string }[] } }> }).edgesById.values()].flatMap(e => e.files.records());
    const offers = () => t.seen.filter(s => s.from === "alice" && s.frame.t === "pf-offer").length;
    const refusals = () => t.seen.filter(s => s.from === "bob" && s.frame.t === "pf-refuse").length;
    // Bob asks for the file again and again; his app holds it, so each offer is refused there.
    for (let i = 0; i < 40; i++) {
      t.say(bob, alice, id, { t: "group-want", g: id, id: messageId });
      await t.world.until(() => refusals() === i + 1, 10_000);
    }
    expect(offers()).toBe(41);
    expect(records(alice).length).toBeLessThanOrEqual(8);
    expect(records(bob).length).toBeLessThanOrEqual(8);
    expect(serving(alice)).toEqual([]);
    // The file is still served to whoever asks.
    t.say(bob, alice, id, { t: "group-want", g: id, id: messageId });
    await t.world.until(() => offers() === 42, 10_000);
  });

  it("a member let in after the announcement is refused it", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob], id } = await t.mesh(["alice", "bob"]);
    const { messageId } = await t.send(alice, id, pattern(20_000));
    await t.world.until(() => t.done(bob, id, messageId), 60_000);
    const dave = t.add("dave");
    await dave.groups.joinByLink(await alice.groups.enableLink(id));
    await t.world.until(() => t.world.view(alice, id)!.members.length === 3 && t.world.view(dave, id)?.members.every(m => m.online) === true, 20 * 60_000);
    // Dave never saw the message; naming it, he is refused by whoever he asks.
    for (const holder of [alice, bob]) t.say(dave, holder, id, { t: "group-want", g: id, id: messageId });
    await t.world.run(2_000);
    const answers = t.seen.filter(s => s.to === "dave" && (s.frame.t === "group-want-no" || s.frame.t === "pf-offer"));
    expect(answers.map(s => [s.from, s.frame.t, s.frame.why]).sort()).toEqual([["alice", "group-want-no", "refused"], ["bob", "group-want-no", "refused"]]);
  });

  it("serving is busy when turned off, past one transfer per member, and past the day's bytes", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob, carol], id } = await t.mesh(["alice", "bob", "carol"]);
    for (const p of [bob, carol]) t.files.get(p)!.settings.autoDownloads = false;
    const one = await t.send(alice, id, pattern(100_000, 1)), two = await t.send(alice, id, pattern(100_000, 2));
    await t.world.run(2_000);
    const answers = (to: string) => t.seen.filter(s => s.from === "alice" && s.to === to && (s.frame.t === "group-want-no" || s.frame.t === "pf-offer")).map(s => s.frame.t === "pf-offer" ? "offer" : s.frame.why);
    // Serving turned off: busy.
    t.files.get(alice)!.settings.serveFiles = false;
    t.say(bob, alice, id, { t: "group-want", g: id, id: one.messageId });
    await t.world.run(1_000);
    expect(answers("bob")).toEqual(["busy"]);
    t.files.get(alice)!.settings.serveFiles = true;
    // Two at once from one member, the first offer still on its way: the second waits its turn.
    t.hold = (_from, _to, frame) => frame.t === "pf-offer";
    t.say(bob, alice, id, { t: "group-want", g: id, id: one.messageId });
    t.say(bob, alice, id, { t: "group-want", g: id, id: two.messageId });
    await t.world.run(1_000);
    expect(answers("bob")).toEqual(["busy", "offer", "busy"]);
    // That offer answers no want of Bob's app: refused there. Bob then downloads the first file, 100 kB served today.
    t.release(id);
    await t.world.run(1_000);
    await bob.groups.downloadFile(t.got(bob, id, one.messageId).message!.file!.id);
    await t.world.until(() => t.done(bob, id, one.messageId), 60_000);
    // Another 100 kB would pass a day of 150 kB.
    limits.serveBytesPerDay = 150_000;
    t.say(carol, alice, id, { t: "group-want", g: id, id: two.messageId });
    await t.world.run(1_000);
    expect(answers("carol")).toEqual(["busy"]);
  });

  it(`a member's app sends at most ${GROUP_FILE_LIMITS.announceTaken} files in ${GROUP_FILE_LIMITS.announceWindowMs / 60_000} minutes, so every one it sends reaches the others as a file`, async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob], id } = await t.mesh(["alice", "bob"]);
    t.files.get(bob)!.settings.autoDownloads = false;
    const store = t.files.get(alice)!.store, sent: string[] = [], refused: string[] = [];
    // 7.5 a minute, within the minute's pace: the window of 10 minutes is what stops the 31st.
    for (let i = 0; i < GROUP_FILE_LIMITS.announceTaken + 2; i++) {
      const bytes = pattern(1_000 + i, i), fileId = groupFileId(id, "out");
      const meta: GroupFileMeta = { name: `n${i}.txt`, mime: "text/plain", size: bytes.length, d: sha(bytes) };
      store.bytes.set(fileId, bytes);
      await store.put({ id: fileId, linkId: `group:${id}`, direction: "out", digest: meta.d, createdAt: t.world.now, metadata: { name: meta.name, size: meta.size, mime: meta.mime, timestamp: t.world.now } });
      const r = await alice.groups.sendFile(id, groupFileFallback(meta), meta, fileId);
      if (r.error) refused.push(r.error); else sent.push(r.messageId!);
      await t.world.run(8_000);
    }
    expect(sent).toHaveLength(GROUP_FILE_LIMITS.announceTaken);
    expect(refused[0]).toMatch(/^You sent many files to this group just now\. Wait \d+ minutes\.$/);
    await t.world.run(5_000);
    expect(sent.filter(m => !t.got(bob, id, m).message?.file)).toEqual([]);
  });

  it(`a member back from away keeps every file one member sent meanwhile: past ${GROUP_FILE_LIMITS.announceTaken} they wait for a Download`, async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob, carol], id } = await t.mesh(["alice", "bob", "carol"]);
    carol.online = false;
    await t.world.run(2_000);
    // 2.4 a minute for 15 minutes: a pace Alice's own app allows, and Bob gets every one as a file.
    const count = GROUP_FILE_LIMITS.announceTaken + 6, sent: { messageId: string; meta: GroupFileMeta }[] = [];
    for (let i = 0; i < count; i++) {
      sent.push(await t.send(alice, id, pattern(1_000 + i, i), { name: `photo-${i}.jpg`, mime: "image/jpeg" }));
      await t.world.run(25_000);
    }
    await t.world.until(() => sent.every(s => t.done(bob, id, s.messageId)), 60_000);
    // Carol's catch-up brings them together: what one member's announcements may make her app fetch by itself stays bounded.
    t.world.reopen(carol);
    await t.world.until(() => sent.every(s => t.got(carol, id, s.messageId).message), 5 * 60_000);
    await t.world.run(5 * 60_000);
    const got = sent.map(s => t.got(carol, id, s.messageId));
    expect(got.filter(g => !g.message!.file).map(g => g.message!.text)).toEqual([]);
    expect(got.filter(g => g.transfer?.state === "done")).toHaveLength(GROUP_FILE_LIMITS.announceTaken);
    const waiting = sent.filter(s => t.got(carol, id, s.messageId).transfer?.state !== "done");
    for (const s of waiting) {
      expect(t.got(carol, id, s.messageId)).toMatchObject({ message: { text: fileMessageText(s.meta) }, transfer: { state: "transferring", stage: "asking" }, bytes: undefined });
    }
    // Nobody was asked for them; their person asks, and they come.
    expect(t.seen.filter(s => s.from === "carol" && s.frame.t === "group-want")).toHaveLength(GROUP_FILE_LIMITS.announceTaken);
    for (const s of waiting) await carol.groups.downloadFile(t.got(carol, id, s.messageId).message!.file!.id);
    await t.world.until(() => sent.every(s => t.done(carol, id, s.messageId)), 5 * 60_000);
    for (const s of waiting) expect(sha(t.got(carol, id, s.messageId).bytes!)).toBe(s.meta.d);
    // After a restart they are still files.
    await t.restart(carol);
    expect(sent.filter(s => !t.got(carol, id, s.messageId).message?.file)).toEqual([]);
  });

  it("a member refused as busy is told when the holder's slot frees, and asks it again before the round is over", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob, carol], id } = await t.mesh(["alice", "bob", "carol"]);
    // Alice serves one at a time; Bob and Carol serve nobody, so whoever she turns away has only her to ask.
    limits.serveAtOnce = 1;
    for (const p of [bob, carol]) t.files.get(p)!.settings.serveFiles = false;
    const start = t.world.now;
    const { messageId, meta } = await t.send(alice, id, pattern(100_000, 13));
    await t.world.until(() => t.done(bob, id, messageId) && t.done(carol, id, messageId), 60_000, 500);
    const refusals = t.seen.filter(s => s.from === "alice" && s.frame.t === "group-want-no" && s.frame.why === "busy");
    const refused = refusals[0].to;
    expect(refusals.every(s => s.to === refused)).toBe(true);
    // Asked again once her slot freed (her next group-have to that edge), not after the 30 s round.
    expect(t.world.now - start).toBeLessThan(GROUP_FILE_LIMITS.wantWaitMs - 10_000);
    const told = t.seen.slice(t.seen.indexOf(refusals.at(-1)!)).some(s => s.from === "alice" && s.to === refused && s.frame.t === "group-have" && (s.frame.ids as string[]).includes(messageId));
    expect(told).toBe(true);
    expect(sha(t.got(refused === "bob" ? bob : carol, id, messageId).bytes!)).toBe(meta.d);
  });

  it("members the author turns away as busy wait for a holder's word, and do not ask members never heard of as holders", async () => {
    const t = new FilesWorld();
    const { peers: [alice, ...others], id } = await t.mesh(Array.from({ length: 10 }, (_, i) => `m${i}`));
    const { messageId, meta } = await t.send(alice, id, pattern(100_000, 5));
    await t.world.until(() => others.every(p => t.done(p, id, messageId)), 60_000, 500);
    const wants = t.seen.filter(s => s.frame.t === "group-want");
    const gone = t.seen.filter(s => s.frame.t === "group-want-no" && s.frame.why === "gone");
    // Each of the 9 copies costs its ask of the author, an ask again when a place frees, and few others: before, each
    // member turned away asked every other member, and nearly all of them answered gone.
    expect(wants.length).toBeLessThanOrEqual(3 * others.length);
    expect(gone.length).toBeLessThanOrEqual(others.length);
    for (const p of others) expect(sha(t.got(p, id, messageId).bytes!)).toBe(meta.d);
  });

  it("files a holder named wait on it only behind the author's edge: one it is slow to serve does not hold back the rest, which another member in reach serves", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob, carol, dave], id } = await t.mesh(["alice", "bob", "carol", "dave"]);
    t.files.get(bob)!.settings.autoDownloads = false;
    // Carol's word that she holds them never reaches Bob (lost, or older than what she names); Dave's does.
    t.hold = (from, to, frame) => from === carol && to === bob && frame.t === "group-have";
    const sent = [];
    for (let i = 0; i < 6; i++) sent.push(await t.send(alice, id, pattern(64 * 1024, 50 + i), { name: `alice-${i}.bin` }));
    const named = (p: Peer) => sent.every(s => t.seen.some(x => x.from === p.name && x.to === "bob" && x.frame.t === "group-have" && (x.frame.ids as string[]).includes(s.messageId)));
    await t.world.until(() => sent.every(s => t.done(carol, id, s.messageId) && t.done(dave, id, s.messageId)) && named(dave), 5 * 60_000);
    alice.online = false;
    await t.world.run(2_000);
    // Dave offers what Bob asks him for, and its bytes never come.
    t.hold = (from, to, frame) => (from === carol && to === bob && frame.t === "group-have") || (from === dave && to === bob && frame.t === "pf-data");
    for (const s of sent) await bob.groups.downloadFile(t.got(bob, id, s.messageId).message!.file!.id);
    // Before, every file Dave named waited its turn behind the one he was asked for, and Carol was never asked.
    await t.world.run(GROUP_FILE_LIMITS.wantWaitMs - 5_000);
    expect(sent.filter(s => t.done(bob, id, s.messageId)).length).toBeGreaterThanOrEqual(5);
    expect(t.seen.some(s => s.from === "bob" && s.to === "carol" && s.frame.t === "group-want")).toBe(true);
    await t.world.until(() => sent.every(s => t.done(bob, id, s.messageId)), 5 * 60_000);
    for (const s of sent) expect(sha(t.got(bob, id, s.messageId).bytes!)).toBe(s.meta.d);
  });

  it.each([2, 6])("%i files sent together reach a group of 16 as fast as its edges carry them, with no wait for the next group-have", async count => {
    const t = new FilesWorld();
    const { peers: [alice, ...others], id } = await t.mesh(Array.from({ length: 16 }, (_, i) => `m${i}`));
    const sent = await Promise.all(Array.from({ length: count }, (_, i) => t.send(alice, id, pattern(50_000, i + 1), { name: `photo-${i}.jpg` })));
    const start = t.world.now, at: number[] = [];
    // An edge here carries a whole file within a second: what takes longer is a member waiting to hear whom to ask.
    while (!others.every(p => sent.every(s => t.done(p, id, s.messageId))) && t.world.now - start < 120_000) {
      await t.world.run(1000);
      at.push(others.reduce((n, p) => n + sent.filter(s => t.done(p, id, s.messageId)).length, 0));
    }
    expect(at.at(-1)).toBe(15 * count);
    // A second with nothing arriving is a member that was turned away as busy, or waits for a holder, and was not told.
    expect(at.filter((n, i) => n === (at[i - 1] ?? 0))).toEqual([]);
    // A file waiting behind another on the author's edge waits for it, or for a holder's word: before, each member asked
    // every other member for the second and later files, and they all answered gone (1,050 for six files).
    const gone = t.seen.filter(s => s.frame.t === "group-want-no" && s.frame.why === "gone");
    expect(gone.length).toBeLessThanOrEqual(others.length);
    for (const p of others) for (const s of sent) expect(sha(t.got(p, id, s.messageId).bytes!)).toBe(s.meta.d);
  });

  it("an edge takes a few group-have frames in a window, and what is past them is said when it has room again", async () => {
    // Set before the edges are: an edge counts its frames from when it is made.
    Object.assign(limits, { haveFrames: 2, haveIds: 1 });
    const t = new FilesWorld();
    const { peers: [alice, bob], id } = await t.mesh(["alice", "bob"]);
    // Bob fetches nothing by itself: what goes on the edge is what Alice says she holds.
    t.files.get(bob)!.settings.autoDownloads = false;
    const sent = await Promise.all([1, 2, 3, 4, 5].map(seed => t.send(alice, id, pattern(1000, seed))));
    const said = () => t.seen.filter(s => s.from === "alice" && s.frame.t === "group-have").flatMap(s => s.frame.ids as string[]);
    const start = t.world.now;
    await t.world.run(GROUP_FILE_LIMITS.haveWindowMs - 1000);
    expect(said()).toHaveLength(2);
    await t.world.until(() => said().length === 5, 60_000);
    // Each file said once, the last of them two windows on.
    expect(said().sort()).toEqual(sent.map(s => s.messageId).sort());
    expect(t.world.now - start).toBeGreaterThan(2 * GROUP_FILE_LIMITS.haveWindowMs);
  });

  const serving = (p: Peer) => (p.groups.files as unknown as { servingNow(): { peer: string; size: number }[] }).servingNow();

  it("what a holder sends counts toward its day whatever the asker confirms, and an asker cannot have it sent past the day", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob, carol], id } = await t.mesh(["alice", "bob", "carol"]);
    for (const p of [bob, carol]) t.files.get(p)!.settings.autoDownloads = false;
    const size = 200_000;
    limits.serveBytesPerDay = 1_000_000;
    const { messageId } = await t.send(alice, id, pattern(size, 3));
    await t.world.run(2_000);
    // Bob's side of files/3 is not the app here: it confirms every byte, and answers each `pf-sum` with `pf-accept
    // {offset: 0}` (the file again from the start) `again` times, then leaves with nothing confirmed.
    const edge = bob.host.edges(id).get(t.key(alice, id))!;
    let again = 0, sent = 0, sums = 0, aborts = 0;
    t.world.drop = (from, to, frame) => {
      if (frame.t !== "pf-data") t.seen.push({ from: from.name, to: to.name, frame });
      if (from !== alice || to !== bob || typeof frame.t !== "string" || !frame.t.startsWith("pf-")) return false;
      // Answered once Alice's app is done sending the frame, as over a network.
      const answer = (reply: Record<string, unknown>) => queueMicrotask(() => t.world.sendFiles(bob, edge, { ...reply, id: frame.id }));
      if (frame.t === "pf-offer") answer({ t: "pf-accept", offset: 0 });
      else if (frame.t === "pf-data") { const bytes = Buffer.from(frame.data as string, "base64url").length; sent += bytes; answer({ t: "pf-got", offset: (frame.offset as number) + bytes }); }
      else if (frame.t === "pf-sum") { sums++; answer({ t: "pf-accept", offset: 0 }); if (sums > again) answer({ t: "pf-refuse", why: "invalid" }); }
      else if (frame.t === "pf-abort") aborts++;
      return true;
    };
    const answers = (to: string) => t.seen.filter(s => s.from === "alice" && s.to === to && (s.frame.t === "group-want-no" || s.frame.t === "pf-offer")).map(s => s.frame.t === "pf-offer" ? "offer" : s.frame.why);
    // The file three times in one transfer, ended with nothing confirmed: 600 kB of the day's 1 MB went.
    again = 2;
    t.say(bob, alice, id, { t: "group-want", g: id, id: messageId });
    await t.world.until(() => sums === 3 && !serving(alice).length, 60_000);
    expect(sent).toBeGreaterThanOrEqual(3 * size);
    const first = sent;
    // Asked again, with no end to it: Alice stops at the day's bytes and says so.
    again = 40;
    t.say(bob, alice, id, { t: "group-want", g: id, id: messageId });
    await t.world.until(() => aborts > 0 || sums > 40, 10 * 60_000);
    expect(aborts).toBe(1);
    expect(sent).toBeGreaterThan(first);
    expect(sent).toBeLessThanOrEqual(limits.serveBytesPerDay + 2 * 16 * 1024);
    expect(serving(alice)).toEqual([]);
    // The day is spent: nobody else is served either.
    for (const p of [bob, carol]) t.say(p, alice, id, { t: "group-want", g: id, id: messageId });
    await t.world.run(1_000);
    expect(answers("bob")).toEqual(["offer", "offer", "busy"]);
    expect(answers("carol")).toEqual(["busy"]);
  });

  const servedToday = (p: Peer) => (p.groups.files as unknown as { served: { bytes: number } }).served.bytes;

  it("an asker that says it has the whole file costs the holder none of its day, and the next member is served", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob, carol], id } = await t.mesh(["alice", "bob", "carol"]);
    for (const p of [bob, carol]) t.files.get(p)!.settings.autoDownloads = false;
    const size = 100_000;
    limits.serveBytesPerDay = 10 * size;
    const { messageId, meta } = await t.send(alice, id, pattern(size, 5));
    await t.world.run(2_000);
    // Bob's side of files/3 is not the app here: it accepts each offer from the file's end, so no data comes, and
    // refuses the file at its `pf-sum`.
    const edge = bob.host.edges(id).get(t.key(alice, id))!;
    let data = 0, sums = 0;
    t.world.drop = (from, to, frame) => {
      t.seen.push({ from: from.name, to: to.name, frame });
      if (from !== alice || to !== bob || typeof frame.t !== "string" || !frame.t.startsWith("pf-")) return false;
      const answer = (reply: Record<string, unknown>) => queueMicrotask(() => t.world.sendFiles(bob, edge, { ...reply, id: frame.id }));
      if (frame.t === "pf-offer") answer({ t: "pf-accept", offset: size });
      else if (frame.t === "pf-data") data++;
      else if (frame.t === "pf-sum") { sums++; answer({ t: "pf-refuse", why: "no-room" }); }
      return true;
    };
    // One more time than the day holds the file.
    for (let i = 1; i <= 11; i++) {
      t.say(bob, alice, id, { t: "group-want", g: id, id: messageId });
      await t.world.until(() => sums === i && !serving(alice).length, 60_000);
    }
    expect(data).toBe(0);
    expect(servedToday(alice)).toBe(0);
    // Carol, on the app, gets the file from Alice (Bob holds none of it).
    await carol.groups.downloadFile(t.got(carol, id, messageId).message!.file!.id);
    await t.world.until(() => t.done(carol, id, messageId), 5 * 60_000);
    expect(sha(t.got(carol, id, messageId).bytes!)).toBe(meta.d);
    expect(servedToday(alice)).toBe(size);
  });

  it("a member holds one serving place, and a transfer that only goes back and forth is let go", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob, carol], id } = await t.mesh(["alice", "bob", "carol"]);
    for (const p of [bob, carol]) t.files.get(p)!.settings.autoDownloads = false;
    const tiny = await t.send(alice, id, pattern(1_000, 7)), report = await t.send(alice, id, pattern(100_000, 8));
    await t.world.run(2_000);
    // Bob's side of files/3 is not the app here: it accepts each offer from the file's end, never says `pf-done`, and
    // every 10 seconds accepts again one byte back or forth.
    const edge = bob.host.edges(id).get(t.key(alice, id))!;
    const wires: string[] = [];
    t.world.drop = (from, to, frame) => {
      t.seen.push({ from: from.name, to: to.name, frame });
      if (from !== alice || to !== bob || typeof frame.t !== "string" || !frame.t.startsWith("pf-")) return false;
      if (frame.t === "pf-offer") {
        wires.push(frame.id as string);
        queueMicrotask(() => t.world.sendFiles(bob, edge, { t: "pf-accept", id: frame.id, offset: 1_000 }));
      }
      return true;
    };
    const answers = (to: string) => t.seen.filter(s => s.from === "alice" && s.to === to && (s.frame.t === "group-want-no" || s.frame.t === "pf-offer")).map(s => s.frame.t === "pf-offer" ? "offer" : s.frame.why);
    for (let i = 0; i < 3; i++) {
      t.say(bob, alice, id, { t: "group-want", g: id, id: tiny.messageId });
      await t.world.run(300);
    }
    // One done but for its `pf-done` (which the next want may overtake), and one more: never all three places.
    expect(answers("bob")).toEqual(["offer", "offer", "busy"]);
    await carol.groups.downloadFile(t.got(carol, id, report.messageId).message!.file!.id);
    for (let i = 0; i < 6; i++) {
      await t.world.run(10_000);
      for (const wire of wires) t.world.sendFiles(bob, edge, { t: "pf-accept", id: wire, offset: i % 2 ? 1_000 : 999 });
    }
    expect(t.done(carol, id, report.messageId)).toBe(true);
    // A minute of going back and forth is no progress: Bob's transfers were let go, and he is served again.
    t.say(bob, alice, id, { t: "group-want", g: id, id: tiny.messageId });
    await t.world.run(300);
    expect(answers("bob").slice(3)).toEqual(["offer"]);
    expect(serving(alice).filter(a => a.peer === t.key(bob, id))).toHaveLength(1);
  });

  it("a holder that serves the rest of a file counts that rest toward its day, not the whole file", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob, carol], id } = await t.mesh(["alice", "bob", "carol"]);
    carol.online = false;
    await t.world.run(2_000);
    const size = 600_000, cut = 512 * 1024;
    const { messageId, meta } = await t.send(alice, id, pattern(size, 12));
    await t.world.until(() => t.done(bob, id, messageId), 60_000);
    // Alice's bytes to Carol stop coming past the first 512 KiB; Carol goes on with Bob from what she has.
    t.hold = (from, to, frame) => from === alice && to === carol && frame.t === "pf-data" && (frame.offset as number) >= cut;
    t.world.reopen(carol);
    await t.world.until(() => t.done(carol, id, messageId) && !serving(bob).length, 10 * 60_000);
    expect(sha(t.got(carol, id, messageId).bytes!)).toBe(meta.d);
    expect(t.seen.filter(s => s.from === "carol" && s.to === "bob" && s.frame.t === "pf-accept").map(s => s.frame.offset)).toEqual([cut]);
    expect(servedToday(bob)).toBe(size - cut);
  });

  it("askers that go away mid-download free the holder's places, and the next member is served", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob, carol, dave, erin], id } = await t.mesh(["alice", "bob", "carol", "dave", "erin"]);
    for (const p of [bob, carol, dave, erin]) t.files.get(p)!.settings.autoDownloads = false;
    const { messageId, meta } = await t.send(alice, id, pattern(3 * 1024 * 1024, 7), { name: "big.bin" });
    await t.world.run(2_000);
    const fileOf = (p: Peer) => t.got(p, id, messageId).message!.file!.id;
    for (const p of [bob, carol, dave]) await p.groups.downloadFile(fileOf(p));
    await t.world.until(() => [bob, carol, dave].every(p => (t.files.get(p)!.transfers.get(fileOf(p))?.transferred ?? 0) > 0), 5 * 60_000);
    // All three go (phone asleep, app closed) and do not come back.
    for (const p of [bob, carol, dave]) p.online = false;
    await t.world.run(2 * GROUP_FILE_LIMITS.wantWaitMs, 1_000);
    expect(serving(alice)).toEqual([]);
    await erin.groups.downloadFile(fileOf(erin));
    await t.world.until(() => t.done(erin, id, messageId), 10 * 60_000, 1_000);
    expect(sha(t.got(erin, id, messageId).bytes!)).toBe(meta.d);
  });

  it("a member removed mid-download frees the holder's place", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob, carol], id } = await t.mesh(["alice", "bob", "carol"]);
    for (const p of [bob, carol]) t.files.get(p)!.settings.autoDownloads = false;
    const { messageId } = await t.send(alice, id, pattern(3 * 1024 * 1024, 8), { name: "big.bin" });
    await t.world.run(2_000);
    const fileId = t.got(carol, id, messageId).message!.file!.id;
    await carol.groups.downloadFile(fileId);
    await t.world.until(() => (t.files.get(carol)!.transfers.get(fileId)?.transferred ?? 0) > 0, 5 * 60_000);
    expect(serving(alice)).toHaveLength(1);
    await alice.groups.remove(id, t.key(carol, id));
    await t.world.run(5_000, 1_000);
    expect(serving(alice)).toEqual([]);
  });

  it("files announced together come one after another from their author, not a busy answer and a wait each", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob], id } = await t.mesh(["alice", "bob"]);
    const sent = await Promise.all([1, 2, 3, 4, 5].map(seed => t.send(alice, id, pattern(20_000, seed), { name: `voice-${seed}.webm` })));
    const start = t.world.now;
    // Each is a few round trips: well within a want's wait (`wantWaitMs`), which a busy answer would cost.
    await t.world.until(() => sent.every(s => t.done(bob, id, s.messageId)), 60_000);
    expect(t.world.now - start).toBeLessThan(GROUP_FILE_LIMITS.wantWaitMs / 2);
    for (const s of sent) expect(sha(t.got(bob, id, s.messageId).bytes!)).toBe(s.meta.d);
    // Bob's app asked Alice for the next file only once the one before had come.
    expect(t.seen.filter(s => s.from === "alice" && s.to === "bob" && s.frame.t === "group-want-no")).toEqual([]);
    expect(t.seen.filter(s => s.from === "bob" && s.frame.t === "group-want")).toHaveLength(5);
  });

  it("the next file's ask that overtakes the word that the last one checked out is not answered busy", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob], id } = await t.mesh(["alice", "bob"]);
    const sent = await Promise.all([1, 2, 3].map(seed => t.send(alice, id, pattern(20_000, seed), { name: `voice-${seed}.webm` })));
    // Bob's `pf-done` reaches Alice half a second late (files/3 and the group's frames are two channels): his next
    // `group-want` comes while her transfer still waits for it.
    const late = (from: Peer, _to: Peer, frame: Record<string, unknown>) => from === bob && frame.t === "pf-done";
    const start = t.world.now;
    t.hold = late;
    while (!sent.every(s => t.done(bob, id, s.messageId)) && t.world.now - start < 60_000) {
      await t.world.run(500);
      t.release(id);
      t.hold = late;
    }
    expect(t.world.now - start).toBeLessThan(GROUP_FILE_LIMITS.wantWaitMs / 2);
    expect(t.seen.filter(s => s.from === "alice" && s.to === "bob" && s.frame.t === "group-want-no")).toEqual([]);
  });

  it(`a file over ${GROUP_FILE_LIMITS.autoBytes / 1024 / 1024} MiB waits for a Download, then comes; a smaller one comes by itself`, async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob], id } = await t.mesh(["alice", "bob"]);
    const big = await t.send(alice, id, pattern(GROUP_FILE_LIMITS.autoBytes + 1, 4), { name: "film.bin" });
    const small = await t.send(alice, id, pattern(GROUP_FILE_LIMITS.autoBytes, 6), { name: "photo.bin" });
    // A few round trips a simulated second here: 8 MiB takes a few simulated minutes.
    await t.world.until(() => t.done(bob, id, small.messageId), 10 * 60_000);
    expect(t.got(bob, id, big.messageId)).toMatchObject({ transfer: { state: "transferring", stage: "asking" }, bytes: undefined });
    expect(t.seen.filter(s => s.frame.t === "group-want").map(s => s.frame.id)).toEqual([small.messageId]);
    await bob.groups.downloadFile(t.got(bob, id, big.messageId).message!.file!.id);
    await t.world.until(() => t.done(bob, id, big.messageId), 10 * 60_000);
    expect(sha(t.got(bob, id, big.messageId).bytes!)).toBe(big.meta.d);
    // Asked for, it does not count toward what the group fetches by itself.
    expect(t.files.get(bob)!.store.records.get(t.got(bob, id, big.messageId).message!.file!.id)!.group).toMatchObject({ asked: true });
  });

  it("a member who leaves keeps none of the group's files: they go with its history, not when the admin has heard", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob, carol], id } = await t.mesh(["alice", "bob", "carol"]);
    const theirs = await t.send(alice, id, pattern(40_000, 2), { name: "plans.bin" });
    const mine = await t.send(bob, id, pattern(30_000, 3), { name: "reply.bin" });
    await t.world.until(() => [alice, bob, carol].every(p => t.done(p, id, theirs.messageId) && t.done(p, id, mine.messageId)), 5 * 60_000);
    const { store, transfers } = t.files.get(bob)!;
    expect(store.bytes.size).toBe(2);
    // The admin is away: its commit taking bob out does not come back, and the leave waits for it for a week.
    alice.online = false;
    await t.world.run(5_000);
    await bob.groups.leave(id);
    await t.world.run(60_000);
    expect(bob.messages.filter(m => m.linkId === `group:${id}`)).toEqual([]);
    expect([...store.records.keys()]).toEqual([]);
    expect([...store.bytes.keys()]).toEqual([]);
    expect([...transfers.keys()]).toEqual([]);
  });

  it.each([
    ["every byte of a picture is here and its sum has not come", 200_000, (frame: Record<string, unknown>) => frame.t === "pf-sum"],
    ["the first 64 KiB of a file are here", 600_000, (frame: Record<string, unknown>) => frame.t === "pf-data" && (frame.offset as number) >= 64 * 1024],
  ])("a member who leaves while a file is coming keeps none of its bytes: %s", async (_, size, held) => {
    const t = new FilesWorld();
    const { peers: [alice, bob], id } = await t.mesh(["alice", "bob", "carol"]);
    t.hold = (from, to, frame) => from === alice && to === bob && held(frame);
    const { messageId } = await t.send(alice, id, pattern(size, 21), { name: "picture.jpg" });
    const here = Math.min(size, 64 * 1024);
    await t.world.until(() => (t.got(bob, id, messageId).transfer?.transferred ?? 0) >= here, 60_000);
    const { store } = t.files.get(bob)!;
    await bob.groups.leave(id);
    await t.world.run(60_000);
    expect([...store.records.keys()]).toEqual([]);
    expect([...store.bytes.keys()]).toEqual([]);
  });

  it("a file that is coming is cancelled: nobody is asked for it again, what came is deleted, and a Download brings it whole", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob], id } = await t.mesh(["alice", "bob"]);
    const size = 600_000, cut = 256 * 1024;
    // The bytes stop past the first 256 KiB: the transfer is under way when its person cancels it.
    t.hold = (from, to, frame) => from === alice && to === bob && frame.t === "pf-data" && (frame.offset as number) >= cut;
    const { messageId, meta } = await t.send(alice, id, pattern(size, 13));
    await t.world.until(() => (t.got(bob, id, messageId).transfer?.transferred ?? 0) >= cut, 60_000);
    const fileId = t.got(bob, id, messageId).message!.file!.id, files = t.files.get(bob)!;
    expect(files.store.records.get(fileId)!.group).toMatchObject({ auto: true });
    await bob.groups.haltFile(fileId);
    expect(files.transfers.get(fileId)).toEqual({ state: "transferring", stage: "asking", transferred: 0, size, direction: "in" });
    expect(t.seen.filter(s => s.from === "bob" && s.frame.t === "pf-refuse").map(s => s.frame.why)).toEqual(["cancelled"]);
    const wants = () => t.seen.filter(s => s.from === "bob" && s.frame.t === "group-want").length;
    expect(wants()).toBe(1);
    t.release(id);
    await t.world.run(3 * 60_000);
    // It stays stopped: nothing asked, nothing stored, and not counted as fetched by itself.
    expect(wants()).toBe(1);
    expect(t.got(bob, id, messageId)).toMatchObject({ transfer: { state: "transferring", stage: "asking" }, bytes: undefined });
    expect(files.store.records.get(fileId)!.group).toEqual({ message: messageId, author: t.key(alice, id) });
    // After a restart too.
    await t.restart(bob);
    await t.world.run(3 * 60_000);
    expect(wants()).toBe(1);
    expect(t.got(bob, id, messageId)).toMatchObject({ transfer: { state: "transferring", stage: "asking" }, bytes: undefined });
    await bob.groups.downloadFile(fileId);
    await t.world.until(() => t.done(bob, id, messageId), 5 * 60_000);
    expect(sha(t.got(bob, id, messageId).bytes!)).toBe(meta.d);
    expect(t.seen.filter(s => s.from === "bob" && s.frame.t === "pf-accept").at(-1)!.frame.offset).toBe(0);
  });

  it("a file that is coming is paused: what came stays, and Resume goes on from there", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob], id } = await t.mesh(["alice", "bob"]);
    const size = 600_000, cut = 256 * 1024;
    t.hold = (from, to, frame) => from === alice && to === bob && frame.t === "pf-data" && (frame.offset as number) >= cut;
    const { messageId, meta } = await t.send(alice, id, pattern(size, 17));
    await t.world.until(() => (t.got(bob, id, messageId).transfer?.transferred ?? 0) >= cut, 60_000);
    const fileId = t.got(bob, id, messageId).message!.file!.id;
    await bob.groups.haltFile(fileId, true);
    expect(t.files.get(bob)!.transfers.get(fileId)).toEqual({ state: "transferring", stage: "paused", pausedBy: "me", transferred: cut, size, direction: "in" });
    t.release(id);
    await t.world.run(3 * 60_000);
    expect(t.seen.filter(s => s.from === "bob" && s.frame.t === "group-want").length).toBe(1);
    expect(t.got(bob, id, messageId).transfer).toMatchObject({ stage: "paused" });
    expect(t.got(bob, id, messageId).bytes!.length).toBe(cut);
    await bob.groups.downloadFile(fileId);
    await t.world.until(() => t.done(bob, id, messageId), 5 * 60_000);
    expect(sha(t.got(bob, id, messageId).bytes!)).toBe(meta.d);
    expect(t.seen.filter(s => s.from === "bob" && s.frame.t === "pf-accept").at(-1)!.frame.offset).toBe(cut);
    // Cancel and pause leave a file that is all here alone.
    await bob.groups.haltFile(fileId);
    expect(t.done(bob, id, messageId)).toBe(true);
  });

  it("a paused file still reads paused after a restart, with what came, and Resume goes on from there", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob], id } = await t.mesh(["alice", "bob"]);
    const size = 600_000, cut = 256 * 1024;
    t.hold = (from, to, frame) => from === alice && to === bob && frame.t === "pf-data" && (frame.offset as number) >= cut;
    const { messageId, meta } = await t.send(alice, id, pattern(size, 18));
    await t.world.until(() => (t.got(bob, id, messageId).transfer?.transferred ?? 0) >= cut, 60_000);
    const fileId = t.got(bob, id, messageId).message!.file!.id;
    await bob.groups.haltFile(fileId, true);
    t.release(id);
    await t.restart(bob);
    await t.world.run(60_000);
    const paused = { state: "transferring", stage: "paused", pausedBy: "me", transferred: cut, size, direction: "in" };
    expect(t.files.get(bob)!.transfers.get(fileId)).toEqual(paused);
    expect(t.got(bob, id, messageId).bytes!.length).toBe(cut);
    // Nothing is asked for it meanwhile, after the restart either.
    const wants = () => t.seen.filter(s => s.from === "bob" && s.frame.t === "group-want").length;
    const asked = wants();
    await t.world.run(3 * 60_000);
    expect(wants()).toBe(asked);
    await bob.groups.downloadFile(fileId);
    await t.world.until(() => t.done(bob, id, messageId), 5 * 60_000);
    expect(sha(t.got(bob, id, messageId).bytes!)).toBe(meta.d);
    expect(t.seen.filter(s => s.from === "bob" && s.frame.t === "pf-accept").at(-1)!.frame.offset).toBe(cut);
    // Resumed, it is no longer paused after another restart.
    await t.restart(bob);
    expect(t.done(bob, id, messageId)).toBe(true);
  });

  it("after a start, files all here show no transfer, so the engine's state does not grow with them; one still coming does", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob], id } = await t.mesh(["alice", "bob"]);
    const held = [];
    for (let i = 0; i < 3; i++) held.push(await t.send(alice, id, pattern(20_000, 30 + i), { name: `h${i}.bin` }));
    await t.world.until(() => held.every(({ messageId }) => t.done(bob, id, messageId)), 60_000);
    // Alice's device serves nothing for now: the next file is still coming to Bob's when both apps start again.
    t.files.get(alice)!.settings.serveFiles = false;
    const coming = await t.send(alice, id, pattern(20_000, 40), { name: "late.bin" });
    await t.world.run(5_000);
    await t.restart(alice);
    await t.restart(bob);
    const late = t.got(bob, id, coming.messageId).message!.file!.id;
    expect([...t.files.get(alice)!.transfers.keys()]).toEqual([]);
    expect([...t.files.get(bob)!.transfers.keys()]).toEqual([late]);
    for (const { messageId } of held) {
      expect(t.got(bob, id, messageId).transfer).toBeUndefined();
      expect(t.done(bob, id, messageId)).toBe(true);
    }
    t.files.get(alice)!.settings.serveFiles = true;
    await t.world.until(() => t.done(bob, id, coming.messageId), 3 * 60_000);
    expect(sha(t.got(bob, id, coming.messageId).bytes!)).toBe(coming.meta.d);
    expect([...t.files.get(bob)!.transfers.keys()]).toEqual([late]);
  });

  it("a file fetched or sent in this run is said done in one state, then shows no transfer: its record says it is done", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob], id } = await t.mesh(["alice", "bob"]);
    const sent = [];
    for (let i = 0; i < 3; i++) sent.push(await t.send(alice, id, pattern(20_000, 70 + i), { name: `d${i}.bin` }));
    await t.world.until(() => sent.every(({ messageId }) => t.done(bob, id, messageId)), 60_000);
    // Done in the next state each engine sends (the CLI's `file.done`); none in the states after it.
    for (const peer of [alice, bob]) {
      const files = t.files.get(peer)!;
      expect([...files.brief.values()].map(view => view.state)).toEqual(["done", "done", "done"]);
      t.sent(peer);
      expect([...files.transfers.keys()]).toEqual([]);
    }
    for (const { messageId, meta } of sent) {
      expect(t.got(bob, id, messageId).transfer).toBeUndefined();
      expect(t.files.get(bob)!.store.records.get(t.got(bob, id, messageId).message!.file!.id)!.transfer).toMatchObject({ state: "done" });
      expect(sha(t.got(bob, id, messageId).bytes!)).toBe(meta.d);
    }
  });

  it("a file that waits for a Download is said in one state, then shows no transfer, nor after a start: its record says it waits", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob], id } = await t.mesh(["alice", "bob"]);
    const files = t.files.get(bob)!;
    files.settings.autoDownloads = false;
    const sent = [];
    for (let i = 0; i < 5; i++) sent.push(await t.send(alice, id, pattern(20_000, 50 + i), { name: `w${i}.bin` }));
    await t.world.run(5_000);
    const ids = sent.map(({ messageId }) => t.got(bob, id, messageId).message!.file!.id);
    // The next state the engine sends says each waits (the CLI's `file.offered`); the states after it carry none of them.
    expect([...files.brief.keys()].sort()).toEqual([...ids].sort());
    t.sent(bob);
    expect([...files.transfers.keys()]).toEqual([]);
    for (const { messageId } of sent) expect(t.got(bob, id, messageId)).toMatchObject({ transfer: { state: "transferring", stage: "asking" }, bytes: undefined });
    await t.restart(bob);
    await t.world.run(5_000);
    expect([...files.transfers.keys()]).toEqual([]);
    expect(files.brief.size).toBe(0);
    for (const { messageId } of sent) expect(t.got(bob, id, messageId)).toMatchObject({ transfer: { state: "transferring", stage: "asking" }, bytes: undefined });
    // Each still comes when its person asks: then it shows how it comes, as before.
    await bob.groups.downloadFile(ids[0]);
    expect(files.transfers.get(ids[0])).toMatchObject({ state: "transferring" });
    await t.world.until(() => t.done(bob, id, sent[0].messageId), 60_000);
    expect(sha(t.got(bob, id, sent[0].messageId).bytes!)).toBe(sent[0].meta.d);
  });

  it("a file past what the group fetches by itself shows no transfer once a state carried it, nor after a start", async () => {
    limits.autoBytesPerGroup = 50_000;
    const t = new FilesWorld();
    const { peers: [alice, bob], id } = await t.mesh(["alice", "bob"]);
    const files = t.files.get(bob)!;
    const sent = [];
    for (let i = 0; i < 4; i++) sent.push(await t.send(alice, id, pattern(20_000, 60 + i), { name: `p${i}.bin` }));
    await t.world.until(() => sent.slice(0, 2).every(({ messageId }) => t.done(bob, id, messageId)), 60_000);
    t.sent(bob);
    const over = sent.slice(2).map(({ messageId }) => t.got(bob, id, messageId).message!.file!.id);
    expect([...files.transfers.keys()].filter(key => over.includes(key))).toEqual([]);
    for (const { messageId } of sent.slice(2)) expect(t.got(bob, id, messageId)).toMatchObject({ transfer: { stage: "asking" }, bytes: undefined });
    await t.restart(bob);
    await t.world.run(5_000);
    expect([...files.transfers.keys()]).toEqual([]);
    for (const { messageId } of sent.slice(2)) expect(t.got(bob, id, messageId)).toMatchObject({ transfer: { stage: "asking" }, bytes: undefined });
  });

  for (const restart of [false, true]) {
    it(`automatic downloads turned off stop the files chosen by themselves that are not here yet${restart ? ", after a restart too" : ""}`, async () => {
      const t = new FilesWorld();
      const { peers: [alice, bob], id } = await t.mesh(["alice", "bob"]);
      // Alice's device serves nothing for now: Bob's waits for a holder.
      t.files.get(alice)!.settings.serveFiles = false;
      const sent = [];
      for (let i = 0; i < 3; i++) sent.push(await t.send(alice, id, pattern(64 * 1024, 20 + i), { name: `n${i}.bin` }));
      await t.world.run(5_000);
      for (const { messageId } of sent) expect(t.got(bob, id, messageId).transfer).toMatchObject({ state: "transferring", stage: "waiting" });
      t.files.get(bob)!.settings.autoDownloads = false;
      // Turned off in the running app (the engine tells the groups), or off when the app starts on what it kept.
      if (restart) await t.restart(bob); else await bob.groups.autoDownloadsOff();
      t.files.get(alice)!.settings.serveFiles = true;
      await t.world.run(3 * 60_000);
      for (const { messageId } of sent) {
        const { message, transfer, bytes } = t.got(bob, id, messageId);
        expect(transfer).toEqual({ state: "transferring", stage: "asking", transferred: 0, size: 64 * 1024, direction: "in" });
        expect(bytes).toBeUndefined();
        expect(t.files.get(bob)!.store.records.get(message!.file!.id)!.group).toEqual({ message: messageId, author: t.key(alice, id) });
      }
      // Each still comes when its person asks.
      await bob.groups.downloadFile(t.got(bob, id, sent[0].messageId).message!.file!.id);
      await t.world.until(() => t.done(bob, id, sent[0].messageId), 60_000);
      expect(t.done(bob, id, sent[1].messageId)).toBe(false);
    });
  }
});

describe("the files of a group this device no longer has", { timeout: 120_000 }, () => {
  /** A file of `groupId` as an earlier run kept it: its record and its bytes. */
  const leftOver = async (store: MemoryFiles, groupId: string) => {
    const id = groupFileId(groupId, "in"), bytes = pattern(4_000, 9);
    store.bytes.set(id, bytes);
    await store.put({ id, linkId: `group:${groupId}`, direction: "in", digest: sha(bytes), createdAt: 1,
      metadata: { name: "old.bin", size: bytes.length, mime: "application/octet-stream", timestamp: 1 },
      transfer: { state: "done", transferred: bytes.length, size: bytes.length }, group: { message: "m1", author: "someone" } });
    return id;
  };

  it("go at start with their bytes, and the files of the groups it has stay", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob], id } = await t.mesh(["alice", "bob"]);
    const { messageId, meta } = await t.send(alice, id, pattern(50_000, 4));
    await t.world.until(() => t.done(bob, id, messageId), 60_000);
    const store = t.files.get(bob)!.store, here = t.got(bob, id, messageId).message!.file!.id;
    // A community left on a version whose Leave kept its files: no group stored here names them.
    const gone = await leftOver(store, "gone-community");
    await t.restart(bob);
    expect(store.records.has(gone)).toBe(false);
    expect(store.bytes.has(gone)).toBe(false);
    expect(sha(store.bytes.get(here)!)).toBe(meta.d);
    expect(t.done(bob, id, messageId)).toBe(true);
  });

  it("stay for a group it was removed from, whose history is kept", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob], id } = await t.mesh(["alice", "bob"]);
    const { messageId, meta } = await t.send(alice, id, pattern(50_000, 5));
    await t.world.until(() => t.done(bob, id, messageId), 60_000);
    await alice.groups.remove(id, t.key(bob, id));
    await t.world.until(() => t.world.view(bob, id)?.status === "removed", 60_000);
    await t.restart(bob);
    expect(t.world.view(bob, id)?.status).toBe("removed");
    const { message, bytes } = t.got(bob, id, messageId);
    expect(t.files.get(bob)!.store.records.has(message!.file!.id)).toBe(true);
    expect(sha(bytes!)).toBe(meta.d);
    expect(t.done(bob, id, messageId)).toBe(true);
  });

  it("stay on a copy that must stay as it is (limited mode)", async () => {
    const t = new FilesWorld();
    const { peers: [, bob] } = await t.mesh(["alice", "bob"]);
    const store = t.files.get(bob)!.store, gone = await leftOver(store, "gone-community");
    await bob.groups.load(true);
    expect(store.records.has(gone)).toBe(true);
    expect(store.bytes.has(gone)).toBe(true);
  });
});

describe("a file in a community", { timeout: 120_000 }, () => {
  it("goes from its author to the hubs, which hold it and serve the members with no edge to the author", async () => {
    const t = new FilesWorld();
    const admin = t.add("admin");
    const id = await admin.groups.create("Open door");
    const link = await admin.groups.enableLink(id);
    const others = Array.from({ length: 5 }, (_, i) => t.add(`p${i}`));
    for (const p of others) await p.groups.joinByLink(`https://app.ghostly.tools/#/join/${link}`);
    await t.world.until(() => others.every(p => t.world.member(p, id)), 10 * 60_000);
    await t.world.run(30_000);
    const everyone = [admin, ...others], hubs = everyone.filter(p => p.groups.communities.isHub(id)), members = everyone.filter(p => !hubs.includes(p));
    expect(members.length).toBeGreaterThanOrEqual(2);
    const [author, ...readers] = members;
    const { messageId, meta } = await t.send(author, id, pattern(120_000, 8), { name: "minutes.txt", mime: "text/plain" });
    await t.world.until(() => everyone.every(p => t.done(p, id, messageId)), 5 * 60_000);
    for (const p of everyone) expect(sha(t.got(p, id, messageId).bytes!)).toBe(meta.d);
    // A member's edges go to hubs only: what it got came from a hub, never over an edge it does not have.
    for (const reader of readers) {
      const from = t.seen.filter(s => s.to === reader.name && s.frame.t === "pf-offer").map(s => s.from);
      expect(from.length).toBeGreaterThan(0);
      expect(from.every(name => hubs.some(h => h.name === name))).toBe(true);
    }
  });

  it("a member who leaves keeps none of the community's files, and none is left after the app starts again", async () => {
    const t = new FilesWorld();
    const admin = t.add("admin");
    const id = await admin.groups.create("Open door");
    const link = await admin.groups.enableLink(id);
    const others = Array.from({ length: 3 }, (_, i) => t.add(`p${i}`));
    for (const p of others) await p.groups.joinByLink(`https://app.ghostly.tools/#/join/${link}`);
    await t.world.until(() => others.every(p => t.world.member(p, id)), 10 * 60_000);
    await t.world.run(30_000);
    const [author, reader] = others;
    const theirs = await t.send(author, id, pattern(40_000, 5), { name: "minutes.bin" });
    const mine = await t.send(reader, id, pattern(30_000, 6), { name: "answer.bin" });
    await t.world.until(() => t.done(reader, id, theirs.messageId) && t.done(reader, id, mine.messageId), 5 * 60_000);
    const { store, transfers } = t.files.get(reader)!;
    expect(store.bytes.size).toBe(2);
    await reader.groups.leave(id);
    await t.world.run(60_000);
    expect(t.world.view(reader, id)).toBeUndefined();
    expect(reader.messages.filter(m => m.linkId === `group:${id}`)).toEqual([]);
    expect([...store.records.keys()]).toEqual([]);
    expect([...store.bytes.keys()]).toEqual([]);
    expect([...transfers.keys()]).toEqual([]);
    await t.world.restart(reader);
    expect([...store.records.keys()]).toEqual([]);
  });
});
