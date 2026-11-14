import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GROUP_FILE_LIMITS, type GroupFileMeta } from "@ghostly/core";
import { CommunityWorld, type Peer } from "./communityWorld";
import { GroupFileDesk, groupFileId, type GroupFileStore, type GroupFileWriter } from "../src/engine/groupFiles";
import type { StoredFile } from "../src/shared/idb";
import type { FileTransferView } from "../src/shared/types";
// covers: groups.files

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("base64url");
const pattern = (size: number, seed: number) => { const out = new Uint8Array(size); for (let i = 0; i < size; i++) out[i] = (i * 31 + seed * 7) & 0xff; return out; };

/** A device's files store and file storage, in memory. */
class MemoryFiles implements GroupFileStore {
  readonly records = new Map<string, StoredFile>();
  readonly bytes = new Map<string, Uint8Array>();
  async list(groupId: string) { return [...this.records.values()].filter(r => r.linkId === `group:${groupId}`).map(r => ({ ...r })); }
  async groups() { return [...new Set([...this.records.values()].map(r => r.linkId.slice("group:".length)))]; }
  async get(id: string) { const record = this.records.get(id); return record && { ...record }; }
  async put(file: StoredFile) { this.records.set(file.id, { ...file }); }
  async patch(id: string, fields: Pick<StoredFile, "transfer" | "group">) { const record = this.records.get(id); if (record) this.records.set(id, { ...record, ...fields }); }
  async remove(id: string) { this.records.delete(id); this.bytes.delete(id); }
  async write(id: string): Promise<GroupFileWriter> {
    const parts: Uint8Array[] = [];
    const keep = () => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } this.bytes.set(id, out); };
    return { offset: 0, append: async b => { parts.push(b.slice()); }, flush: async () => keep(), digest: async () => { keep(); return sha(this.bytes.get(id)!); },
      close: async () => keep(), discard: async () => { parts.length = 0; this.bytes.delete(id); } };
  }
  async read(file: StoredFile, offset: number, length: number) { return this.bytes.get(file.id)!.slice(offset, offset + length); }
  async room() { return null; }
}

/**
 * Senders, and the settings of one more member that sends nothing. That member holds none of the files (automatic
 * downloads off) or serves none (serving off): its edge stays free, yet no file can be asked of it, and it must not send
 * every waiting file back to asking at each file that ends. Nor must a group past 8 senders, whose free edges every
 * waiting file may have asked already.
 */
const cases: [string, number, { autoDownloads?: boolean; serveFiles?: boolean } | undefined][] = [
  ["8 senders", 8, undefined],
  ["8 senders and a member with automatic downloads off", 8, { autoDownloads: false }],
  ["8 senders and a member with serving off", 8, { serveFiles: false }],
  ["12 senders", 12, undefined],
  ["15 senders (a group of 16)", 15, undefined],
  ["14 senders and a member with automatic downloads off", 14, { autoDownloads: false }],
  ["14 senders and a member with serving off", 14, { serveFiles: false }],
];

/**
 * A member back from away in a busy group asks for every file it missed. Each file that ended asked every file still
 * waiting again, each ask going through every want for its edges, and each reported its unchanged row to the engine:
 * 450 small files from 15 members cost the desk 1.1 million asks and 26 s of main-thread time. Here the files' bytes
 * take longer than the catch-up of their announcements, as they do over a network, so they all wait at once.
 */
describe("a member back from away in a busy group", { timeout: 10 * 60_000 }, () => {
  it.each(cases)("asks for the files it missed about once each, and reports each file's row only when it changes: %s", async (_, senders, other) => {
    const world = new CommunityWorld();
    const files = new Map<Peer, { store: MemoryFiles; transfers: Map<string, FileTransferView> }>();
    const add = (name: string) => {
      const f = { store: new MemoryFiles(), transfers: new Map<string, FileTransferView>() };
      const settings = { autoDownloads: true, serveFiles: true, ...(name === "other" && other) };
      const peer = world.add(name, p => ({ groupFiles: { store: f.store, transfers: f.transfers, brief: () => {}, settings: () => settings,
        sendFiles: (linkId, frame) => world.sendFiles(p, linkId, frame) } }));
      files.set(peer, f);
      return peer;
    };
    const each = 30;
    const [admin, ...rest] = ["admin", ...Array.from({ length: senders - 1 }, (_, i) => `m${i}`), ...(other ? ["other"] : []), "zed"].map(add);
    const zed = rest.at(-1)!, members = [admin, ...rest.slice(0, senders - 1)], all = [admin, ...rest];
    const id = await admin.groups.create("Files", "mesh");
    const link = await admin.groups.enableLink(id);
    for (const p of rest) await p.groups.joinByLink(link);
    await world.until(() => all.every(p => world.view(p, id)?.members.length === all.length && world.view(p, id)!.members.every(m => m.online)), 30 * 60_000, 1000);

    // Zed is away while each member sends 30 small files, within the pace the others fetch by themselves.
    zed.online = false;
    await world.run(2_000);
    const sent: string[] = [];
    for (let round = 0; round < each; round++) {
      for (const [i, member] of members.entries()) {
        const store = files.get(member)!.store, fileId = groupFileId(id, "out"), bytes = pattern(2_000, round * 100 + i), d = sha(bytes);
        const meta: GroupFileMeta = { name: `f-${i}-${round}.bin`, mime: "application/octet-stream", size: bytes.length, d };
        store.bytes.set(fileId, bytes);
        await store.put({ id: fileId, linkId: `group:${id}`, direction: "out", digest: d, createdAt: world.now, metadata: { name: meta.name, size: meta.size, mime: meta.mime, timestamp: world.now } });
        const r = await member.groups.sendFile(id, meta.name, meta, fileId);
        expect(r.error).toBeNull();
        sent.push(r.messageId!);
      }
      await world.run(15_000);
    }
    const doneAt = (peer: Peer) => sent.filter(m => { const f = peer.messages.find(x => x.id === m)?.file; return f && files.get(peer)!.transfers.get(f.id)?.state === "done"; }).length;
    await world.until(() => members.every(p => doneAt(p) === sent.length), 30 * 60_000, 1000);

    // From here: Zed's asks, and the changes its desk reports to the engine.
    const proto = GroupFileDesk.prototype as unknown as { ask(...args: unknown[]): unknown };
    const ask = proto.ask;
    let asks = 0, changes = 0;
    proto.ask = function (this: unknown, ...args: unknown[]) { asks++; return ask.apply(this, args); };
    const desk = (zed.groups as unknown as { files: { deps: { changed(): void } } }).files;
    const changed = desk.deps.changed;
    desk.deps.changed = () => { changes++; changed(); };
    try {
      const pending = (world as unknown as { pending: Promise<unknown>[] }).pending;
      const held: { from: Peer; to: Peer; frame: Record<string, unknown> }[] = [];
      let holding = true;
      world.drop = (from, to, frame) => {
        const t = String(frame.t);
        // Files' bytes to and from Zed wait until every announcement is there.
        if (holding && t.startsWith("pf-") && (from === zed || to === zed)) { held.push({ from, to, frame }); return true; }
        // A group frame arrives after its sender's call returns, as over a network, not inside it.
        const edge = t.startsWith("group-") && [...from.links.values()].find(l => l.kind === "edge" && l.g === id && l.peer === world.view(to, id)?.myKey);
        if (!edge) return false;
        queueMicrotask(() => pending.push(to.groups.handleEdgeFrame(edge.g, edge.me, frame)));
        return true;
      };
      world.reopen(zed);
      await world.until(() => sent.every(m => zed.messages.some(x => x.id === m)), 30 * 60_000, 1000);
      holding = false;
      for (const { from, to, frame } of held.splice(0)) world.sendFiles(from, from.host.edges(id).get(world.view(to, id)!.myKey!)!, frame);
      await world.until(() => doneAt(zed) === sent.length, 30 * 60_000, 1000);
    } finally {
      proto.ask = ask;
    }
    expect(files.get(zed)!.store.bytes.size).toBe(sent.length);
    // Each file asked about once when it came and once when an edge freed for it, not once per file that ended before it.
    expect(asks).toBeLessThanOrEqual(3 * sent.length);
    // Its row went from asking to queued, asked, coming, checked and done: a few changes each, not one per ask.
    expect(changes).toBeLessThanOrEqual(8 * sent.length);
  });
});

/**
 * Files whose only holder is their author, away: they wait with nobody to ask. Each file that ended on another edge (or
 * was refused there) asked every one of them again, each ask going through the group's edges and members to find again
 * that nobody could serve it: 300 such files and 50 coming from another member cost about 15,000 asks. A freed edge serves
 * none of them; the author back does.
 */
describe("files waiting for their author, away", { timeout: 10 * 60_000 }, () => {
  it("are not asked again at each other file that ends, and come once their author is back", async () => {
    const limits = GROUP_FILE_LIMITS as { -readonly [K in keyof typeof GROUP_FILE_LIMITS]: number };
    const saved = { ...limits };
    // Sent faster than members may, so the test is short.
    Object.assign(limits, { announcePerMinute: 1_000, announceTaken: 1_000 });
    const proto = GroupFileDesk.prototype as unknown as { ask(...args: unknown[]): unknown };
    const ask = proto.ask;
    try {
      const world = new CommunityWorld();
      const files = new Map<Peer, { store: MemoryFiles; transfers: Map<string, FileTransferView>; settings: { autoDownloads: boolean; serveFiles: boolean } }>();
      const add = (name: string) => {
        const f = { store: new MemoryFiles(), transfers: new Map<string, FileTransferView>(), settings: { autoDownloads: name !== "zed", serveFiles: true } };
        const peer = world.add(name, p => ({ groupFiles: { store: f.store, transfers: f.transfers, brief: () => {}, settings: () => f.settings,
          sendFiles: (linkId, frame) => world.sendFiles(p, linkId, frame) } }));
        files.set(peer, f);
        return peer;
      };
      const send = async (member: Peer, id: string, n: number, seed: number) => {
        const sent: string[] = [];
        for (let i = 0; i < n; i++) {
          const store = files.get(member)!.store, fileId = groupFileId(id, "out"), bytes = pattern(500, seed + i), d = sha(bytes);
          const meta: GroupFileMeta = { name: `f-${seed + i}.bin`, mime: "application/octet-stream", size: bytes.length, d };
          store.bytes.set(fileId, bytes);
          await store.put({ id: fileId, linkId: `group:${id}`, direction: "out", digest: d, createdAt: world.now, metadata: { name: meta.name, size: meta.size, mime: meta.mime, timestamp: world.now } });
          const r = await member.groups.sendFile(id, meta.name, meta, fileId);
          expect(r.error).toBeNull();
          sent.push(r.messageId!);
          // Within what members take of one member's messages (`messagesPerAuthor` in 10 s).
          if (sent.length % 25 === 0) await world.run(10_000);
        }
        return sent;
      };
      const fileOf = (peer: Peer, m: string) => peer.messages.find(x => x.id === m)?.file?.id;
      const done = (peer: Peer, sent: string[]) => sent.filter(m => { const f = fileOf(peer, m); return f && files.get(peer)!.transfers.get(f)?.state === "done"; }).length;

      const [alice, zed, bob] = ["alice", "zed", "bob"].map(add);
      const id = await alice.groups.create("Files", "mesh");
      const link = await alice.groups.enableLink(id);
      await zed.groups.joinByLink(link);
      await world.until(() => [alice, zed].every(p => world.view(p, id)?.members.length === 2 && world.view(p, id)!.members.every(m => m.online)), 30 * 60_000, 1000);
      // Alice's files, before Bob joined: he could not read them, so only Alice can serve them.
      const alices = await send(alice, id, 300, 0);
      await world.until(() => alices.every(m => fileOf(zed, m)), 30 * 60_000, 1000);
      await bob.groups.joinByLink(link);
      const all = [alice, zed, bob];
      await world.until(() => all.every(p => world.view(p, id)?.members.length === 3 && world.view(p, id)!.members.every(m => m.online)), 30 * 60_000, 1000);
      alice.online = false;
      await world.until(() => !world.view(zed, id)!.members.find(m => m.key === world.view(alice, id)!.myKey)?.online, 30 * 60_000, 1000);
      // Zed asks for them: nobody in reach holds them.
      for (const m of alices) await zed.groups.downloadFile(fileOf(zed, m)!);
      await world.run(2_000);
      const z = files.get(zed)!;
      expect(alices.filter(m => z.transfers.get(fileOf(zed, m)!)?.stage === "waiting")).toHaveLength(300);

      // From here: Zed's asks, and its looks at the group's edges, while 50 files of Bob's come (and no new round for
      // the waiting files, which would ask each once more whatever ends).
      limits.wantWaitMs = 30 * 60_000;
      z.settings.autoDownloads = true;
      const desk = (zed.groups as unknown as { files: { deps: { edges(groupId: string): Map<string, string> } } }).files;
      const edges = desk.deps.edges;
      let asks = 0, looks = 0;
      desk.deps.edges = groupId => { looks++; return edges(groupId); };
      proto.ask = function (this: unknown, ...args: unknown[]) { asks++; return ask.apply(this, args); };
      const bobs = await send(bob, id, 50, 1_000);
      await world.until(() => done(zed, bobs) === bobs.length, 30 * 60_000, 1000);
      proto.ask = ask;
      desk.deps.edges = edges;
      // Each of Bob's files asked when it came and when the edge freed for it: not Alice's 300 at each that ended.
      expect(asks).toBeLessThanOrEqual(5 * bobs.length);
      expect(looks).toBeLessThanOrEqual(10 * bobs.length);
      expect(alices.filter(m => z.transfers.get(fileOf(zed, m)!)?.stage === "waiting")).toHaveLength(300);

      // Alice back: her edge comes up, and every file waiting for her comes.
      limits.wantWaitMs = saved.wantWaitMs;
      world.reopen(alice);
      await world.until(() => done(zed, alices) === alices.length, 30 * 60_000, 1000);
      expect(z.store.bytes.size).toBe(alices.length + bobs.length);
    } finally {
      proto.ask = ask;
      Object.assign(limits, saved);
    }
  });
});
