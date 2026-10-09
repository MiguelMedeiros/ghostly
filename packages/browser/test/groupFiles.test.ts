import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { GROUP_FILE_LIMITS, fileMessageText, groupFileFallback, type GroupFileMeta } from "@ghostly/core";
import { CommunityWorld, type Peer } from "./communityWorld";
import { groupFileId, type GroupFileStore, type GroupFileWriter } from "../src/engine/groupFiles";
import type { StoredFile } from "../src/shared/idb";
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

interface Files { store: MemoryFiles; transfers: Map<string, FileTransferView>; settings: { autoDownloads: boolean; serveFiles: boolean } }

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

  add(name: string): Peer {
    const files: Files = { store: new MemoryFiles(), transfers: new Map(), settings: { autoDownloads: true, serveFiles: true } };
    const peer = this.world.add(name, p => ({ groupFiles: { store: files.store, transfers: files.transfers, settings: () => files.settings, sendFiles: (linkId, frame) => this.world.sendFiles(p, linkId, frame) } }));
    this.files.set(peer, files);
    return peer;
  }

  /** A private group of `names`, the first its admin, everyone's edges up. */
  async mesh(names: string[]): Promise<{ peers: Peer[]; id: string }> {
    const [admin, ...rest] = names.map(name => this.add(name));
    const id = await admin.groups.create("Files", "mesh");
    const link = await admin.groups.enableLink(id);
    for (const p of rest) await p.groups.joinByLink(link);
    const peers = [admin, ...rest];
    await this.world.until(() => peers.every(p => this.world.view(p, id)?.members.length === peers.length && this.world.view(p, id)!.members.every(m => m.online)), 20 * 60_000, 1000);
    return { peers, id };
  }

  key(peer: Peer, id: string): string { return this.world.view(peer, id)!.myKey!; }

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

  /** The file a member's history shows for a message, its transfer here, and the bytes it stored. */
  got(peer: Peer, groupId: string, messageId: string) {
    const message = peer.messages.find(m => m.linkId === `group:${groupId}` && m.id === messageId);
    const files = this.files.get(peer)!, id = message?.file?.id;
    return { message, transfer: id ? files.transfers.get(id) : undefined, bytes: id ? files.store.bytes.get(id) : undefined };
  }

  done(peer: Peer, groupId: string, messageId: string): boolean { return this.got(peer, groupId, messageId).transfer?.state === "done"; }

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

  it("a caption is the text under it; a voice message is fetched whatever its size", async () => {
    const t = new FilesWorld();
    const { peers: [alice, bob], id } = await t.mesh(["alice", "bob"]);
    const voice = { duration: 4_000, peaks: [0, 120, 255, 40] };
    const { messageId } = await t.send(alice, id, pattern(40_000, 3), { name: "voice.webm", mime: "audio/webm", voice }, "Listen to this");
    await t.world.until(() => t.done(bob, id, messageId), 60_000);
    expect(t.got(bob, id, messageId).message).toMatchObject({ text: "Listen to this", file: { voice } });
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

  const serving = (p: Peer) => (p.groups.files as unknown as { servingNow(): { peer: string; size: number }[] }).servingNow();

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
});
