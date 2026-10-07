import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { GroupSession, type GroupEdgeFrame, type GroupIncomingMessage, type GroupMessageFrame } from "../src/groupSession";
import { CommunitySession, type CommunityFrame, type CommunityIncomingMessage } from "../src/groupCommunity";
import { GROUP_FILE_LIMITS, fetchesByItself, groupFileFallback, isGroupMessageId, readGroupFileMeta, readGroupHave, readGroupWant, readGroupWantNo, type GroupFileMeta } from "../src/groupFiles";
// covers: groups.files.wire

/*
 * Files in groups (WISP 503 · Group Files): a file is announced as a group message whose sealed description rides
 * beside the text, under the author's signature; the text is the caption, or the line an older app shows.
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const DIGEST = "q".repeat(43);
const pdf: GroupFileMeta = { name: "report.pdf", mime: "application/pdf", size: 2_400_000, d: DIGEST };
const voice: GroupFileMeta = { name: "voice.webm", mime: "audio/webm", size: 90_000, d: DIGEST, voice: { duration: 42_000, peaks: [1, 80, 255, 3] } };

describe("a file's description as a reader takes it", () => {
  it("cleans the name and the type, and keeps what holds", () => {
    expect(readGroupFileMeta({ ...pdf, name: "../../etc/passwd" })).toMatchObject({ name: "etcpasswd" });
    expect(readGroupFileMeta({ ...pdf, mime: "not a type" })).toMatchObject({ mime: "application/octet-stream" });
    expect(readGroupFileMeta(voice)).toEqual(voice);
  });

  it("is no file when a field does not hold: no size, past 100 MiB, a digest of another shape, no name", () => {
    for (const bad of [{ ...pdf, size: 0 }, { ...pdf, size: GROUP_FILE_LIMITS.maxBytes + 1 }, { ...pdf, size: 1.5 }, { ...pdf, d: "short" },
      { ...pdf, name: "" }, { ...pdf, name: "x".repeat(256) }, { ...pdf, mime: 7 }, null, [], "file"])
      expect(readGroupFileMeta(bad)).toBeNull();
    expect(readGroupFileMeta({ ...pdf, size: GROUP_FILE_LIMITS.maxBytes })).not.toBeNull();
  });

  it("drops a malformed voice description and keeps the file", () => {
    expect(readGroupFileMeta({ ...voice, voice: { duration: -1, peaks: [] } })).toEqual({ name: voice.name, mime: voice.mime, size: voice.size, d: DIGEST });
  });
});

describe("what an older app shows, and what downloads by itself", () => {
  it("says the file and that it needs an update", () => {
    expect(groupFileFallback(pdf)).toBe("📎 report.pdf (2.3 MB): update Ghostly to get files in groups");
    expect(groupFileFallback(voice)).toBe("🎤 Voice message (0:42): update Ghostly to hear it");
  });

  it("voice always; other files up to 8 MiB while the group's automatic files stay within 256 MiB", () => {
    expect(fetchesByItself(voice, 1e12)).toBe(true);
    expect(fetchesByItself({ size: GROUP_FILE_LIMITS.autoBytes }, 0)).toBe(true);
    expect(fetchesByItself({ size: GROUP_FILE_LIMITS.autoBytes + 1 }, 0)).toBe(false);
    expect(fetchesByItself({ size: 1024 }, GROUP_FILE_LIMITS.autoBytesPerGroup - 1023)).toBe(false);
    expect(fetchesByItself({ size: 1024 }, 0, { autoBytes: 512, autoBytesPerGroup: 1e9 })).toBe(false);
  });
});

describe("asking for a file and saying who holds one", () => {
  const G = "g".repeat(22);
  const mesh = `${"a".repeat(52)}:3:7`, community = `${"b".repeat(52)}:2:0123456789abcdef:4`;

  it("names a message of either profile, and nothing else", () => {
    expect(isGroupMessageId(mesh)).toBe(true);
    expect(isGroupMessageId(community)).toBe(true);
    for (const bad of ["", "x:1:2", `${"a".repeat(52)}:1`, `${"A".repeat(52)}:1:2`, `${"a".repeat(52)}:1:2:3:4`, 7, null]) expect(isGroupMessageId(bad)).toBe(false);
  });

  it("group-want: the group's, with a message id", () => {
    expect(readGroupWant({ t: "group-want", g: G, id: mesh }, G)).toEqual({ id: mesh });
    expect(readGroupWant({ t: "group-want", g: "other", id: mesh }, G)).toBeNull();
    expect(readGroupWant({ t: "group-want", g: G, id: "../x" }, G)).toBeNull();
    expect(readGroupWant({ t: "group-have", g: G, id: mesh }, G)).toBeNull();
  });

  it("group-want-no: gone, busy or refused; a reason it does not know reads as busy", () => {
    for (const why of ["gone", "busy", "refused"]) expect(readGroupWantNo({ t: "group-want-no", g: G, id: mesh, why }, G)).toEqual({ id: mesh, why });
    expect(readGroupWantNo({ t: "group-want-no", g: G, id: mesh, why: "later" }, G)).toEqual({ id: mesh, why: "busy" });
    expect(readGroupWantNo({ t: "group-want-no", g: G, why: "gone" }, G)).toBeNull();
  });

  it(`group-have: 1 to ${GROUP_FILE_LIMITS.haveIds} message ids, each once; on an edge the group's, in a community without g`, () => {
    const ids = Array.from({ length: GROUP_FILE_LIMITS.haveIds }, (_, i) => `${"c".repeat(52)}:1:${i}`);
    expect(readGroupHave({ t: "group-have", g: G, ids }, G)).toEqual(ids);
    expect(readGroupHave({ t: "group-have", ids: [community, community] })).toEqual([community]);
    expect(readGroupHave({ t: "group-have", g: G, ids: [...ids, mesh] }, G)).toBeNull();
    expect(readGroupHave({ t: "group-have", g: G, ids: [] }, G)).toBeNull();
    expect(readGroupHave({ t: "group-have", g: G, ids: [mesh, "nope"] }, G)).toBeNull();
    expect(readGroupHave({ t: "group-have", g: "other", ids: [mesh] }, G)).toBeNull();
  });
});

/** Mesh members wired directly, every edge open. */
function mesh() {
  const sessions = new Map<string, GroupSession>();
  const inbox = new Map<string, GroupIncomingMessage[]>();
  let pending: Promise<unknown>[] = [];
  const add = (state: ReturnType<typeof GroupSession.create>) => {
    const session: GroupSession = new GroupSession(state, {
      save: async () => {},
      send: (to, frame: GroupEdgeFrame) => { const t = sessions.get(to); if (t) pending.push(t.handle(session.myKey, clone(frame))); },
      message: m => { inbox.get(session.myKey)!.push(m); },
      changed: () => {},
    });
    sessions.set(session.myKey, session); inbox.set(session.myKey, []);
    return session;
  };
  const settle = async () => { while (pending.length) { const batch = pending; pending = []; await Promise.all(batch); } };
  const admit = async (admin: GroupSession) => {
    const seed = createIdentity().seedB64;
    const welcome = await admin.admit(identityFromSeedB64(seed).pubKeyZ32);
    const invite = admin.inviteFrame();
    const joined = GroupSession.join({ name: invite.name, admin: invite.admin }, welcome.slice(0, -1), welcome[welcome.length - 1], seed);
    if ("error" in joined) throw new Error(joined.error);
    const session = add(joined.state);
    await settle();
    return session;
  };
  return { admit, add, settle, inbox };
}

describe("a file in a private group", () => {
  it("is sealed in a box of its own (fl), covered by the author's whole signature; every member gets it beside the text", async () => {
    const net = mesh();
    const alice = net.add(GroupSession.create("Ghosts"));
    const bob = await net.admit(alice);
    const sent = await alice.sendText(groupFileFallback(pdf), Date.now(), [], undefined, undefined, undefined, pdf);
    expect(sent).toHaveProperty("id");
    await net.settle();
    expect(net.inbox.get(bob.myKey)!.at(-1)).toMatchObject({ id: (sent as { id: string }).id, text: groupFileFallback(pdf), file: pdf });
    expect(net.inbox.get(alice.myKey)!.at(-1)).toMatchObject({ file: pdf });
    const frame = alice.state.sent.at(-1)!;
    expect(frame.fl).toBeDefined();
    // Sealed: nobody outside the epoch reads the name or the digest.
    expect(JSON.stringify(frame)).not.toContain("report.pdf\"");
    expect(JSON.stringify(frame)).not.toContain(DIGEST);
  });

  it("refuses a description that does not hold, and sends nothing", async () => {
    const net = mesh();
    const alice = net.add(GroupSession.create("Ghosts"));
    await net.admit(alice);
    const before = alice.state.sent.length;
    expect(await alice.sendText("x", Date.now(), [], undefined, undefined, undefined, { ...pdf, size: 0 })).toEqual({ error: "That file cannot go to a group" });
    expect(alice.state.sent.length).toBe(before);
  });

  it("handed on by another member, keeps its file only with the author's signature over it", async () => {
    const net = mesh();
    const alice = net.add(GroupSession.create("Ghosts"));
    const bob = await net.admit(alice), carol = await net.admit(alice);
    const heard: GroupIncomingMessage[] = [];
    const reader = new GroupSession(clone(carol.state), { save: async () => {}, send: () => {}, message: m => { heard.push(m); }, changed: () => {} });
    await alice.sendText("the report", Date.now(), [], undefined, undefined, undefined, pdf);
    await alice.sendText("plain", Date.now());
    await net.settle();
    const [filed, plain] = alice.state.sent.slice(-2).map(clone) as GroupMessageFrame[];
    await reader.handle(bob.myKey, filed);
    // Bob grafts the first message's file onto the second: the signature over the whole frame no longer holds.
    await reader.handle(bob.myKey, { ...plain, fl: filed.fl });
    expect(heard.map(m => [m.text, m.file?.name])).toEqual([["the report", "report.pdf"], ["plain", undefined]]);
  });

  it("an app that drops fl (an older one handing it on) leaves a provisional copy that the whole one completes", async () => {
    const net = mesh();
    const alice = net.add(GroupSession.create("Ghosts"));
    const bob = await net.admit(alice), carol = await net.admit(alice);
    const heard: GroupIncomingMessage[] = [];
    const reader = new GroupSession(clone(carol.state), { save: async () => {}, send: () => {}, message: m => { heard.push(m); }, changed: () => {} });
    await alice.sendText(groupFileFallback(voice), Date.now(), [], undefined, undefined, undefined, voice);
    await net.settle();
    const whole = clone(alice.state.sent.at(-1)!) as GroupMessageFrame;
    const stripped = clone(whole); delete stripped.fl;
    await reader.handle(bob.myKey, stripped);
    expect(heard.at(-1)).toMatchObject({ text: groupFileFallback(voice) });
    expect(heard.at(-1)!.file).toBeUndefined();
    await reader.handle(alice.myKey, whole);
    expect(heard.at(-1)).toMatchObject({ file: voice, completes: true });
  });

  it("could be read by the members of its epoch still in the group: not one let in later, not one removed", async () => {
    const net = mesh();
    const alice = net.add(GroupSession.create("Ghosts"));
    const bob = await net.admit(alice), carol = await net.admit(alice);
    const { id } = await alice.sendText("the report", Date.now(), [], undefined, undefined, undefined, pdf) as { id: string };
    await net.settle();
    const dave = await net.admit(alice);
    expect(alice.couldRead(bob.myKey, id)).toBe(true);
    expect(alice.couldRead(dave.myKey, id)).toBe(false);
    await alice.remove(carol.myKey);
    await net.settle();
    expect(alice.couldRead(carol.myKey, id)).toBe(false);
    expect(bob.couldRead(alice.myKey, id)).toBe(true);
  });
});

/** Community members on one network where every broadcast reaches everyone. */
function community() {
  const members: CommunitySession[] = [];
  const inbox = new Map<string, CommunityIncomingMessage[]>();
  let pending: Promise<unknown>[] = [];
  const hooks = (get: () => CommunitySession) => {
    const deliver = (to: CommunitySession | undefined, frame: CommunityFrame) => { if (to && to !== get()) pending.push(to.handle(get().myKey, clone(frame))); };
    return {
      save: async () => {},
      broadcast: (frame: CommunityFrame) => { for (const m of members) deliver(m, frame); },
      direct: (to: string, frame: CommunityFrame) => deliver(members.find(m => m.myKey === to), frame),
      addressed: (to: string, frame: CommunityFrame) => deliver(members.find(m => m.myKey === to), frame),
      message: (m: CommunityIncomingMessage) => { inbox.get(get().myKey)!.push(m); },
      changed: () => {},
    };
  };
  const settle = async () => { for (let i = 0; i < 200 && pending.length; i++) { const batch = pending; pending = []; await Promise.all(batch); } };
  const push = (state: ReturnType<typeof CommunitySession.create>) => {
    let session: CommunitySession;
    // eslint-disable-next-line prefer-const
    session = new CommunitySession(state, hooks(() => session));
    members.push(session); inbox.set(session.myKey, []);
    return session;
  };
  const admit = async (by: CommunitySession) => {
    const seedB64 = createIdentity().seedB64;
    const frames = await by.admit(identityFromSeedB64(seedB64).pubKeyZ32);
    await settle();
    const joined = CommunitySession.join({ g: by.id, host: by.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seedB64);
    if ("error" in joined) throw new Error(joined.error);
    return push(joined.state);
  };
  return { push, admit, settle, inbox };
}

describe("a file in a community", () => {
  it("rides inside the sealed payload as fl beside the text; a description that does not hold is left out, the text shows", async () => {
    const net = community();
    const alice = net.push(CommunitySession.create("Ghosts"));
    const bob = await net.admit(alice);
    await net.settle();
    const sent = await bob.sendText(groupFileFallback(voice), "Bot", Date.now(), [], undefined, undefined, undefined, voice) as { id: string };
    await net.settle();
    expect(net.inbox.get(alice.myKey)!.at(-1)).toMatchObject({ id: sent.id, text: groupFileFallback(voice), file: voice });
    expect(await bob.sendText("x", "Bot", Date.now(), [], undefined, undefined, undefined, { ...voice, d: "bad" })).toEqual({ error: "That file cannot go to a group" });
  });

  it("could be read by the members of its epoch still in the group, not by one let in later", async () => {
    const net = community();
    const alice = net.push(CommunitySession.create("Ghosts"));
    const bob = await net.admit(alice);
    await net.settle();
    const { id } = await alice.sendText("the report", "Alice", Date.now(), [], undefined, undefined, undefined, pdf) as { id: string };
    await net.settle();
    const carol = await net.admit(alice);
    await net.settle();
    expect(alice.couldRead(bob.myKey, id)).toBe(true);
    expect(alice.couldRead(carol.myKey, id)).toBe(false);
    expect(alice.couldRead(bob.myKey, `${bob.myKey}:9:ffffffffffffffff:1`)).toBe(false);
  });
});
