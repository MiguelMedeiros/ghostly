import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { GroupFileMeta } from "@ghostly/core";
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
