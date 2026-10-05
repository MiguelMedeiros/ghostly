import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { pairedMessageFrame } from "../src/ghostlink";
import { editFrame, parseEditFrame, MAX_EDITS_PER_MESSAGE } from "../src/pairedEdits";
import { GroupSession, type GroupEdgeFrame, type GroupIncomingMessage, type GroupMessageFrame } from "../src/groupSession";
import { CommunitySession, type CommunityFrame, type CommunityIncomingMessage } from "../src/groupCommunity";
import { communityEditFrame, parseCommunityEdit, type GroupIncomingEdit } from "../src/groupEdits";
import {
  STATUS_CARD_LIMITS, cardLinkHost, cardUrl, checkStatusCard, readStatusCard, statusCardText, taskProgress, type RoutineCard, type TaskCard,
} from "../src/statusCards";
// covers: chat.status-cards.wire

/*
 * Status cards (WISP 405 · Status Cards): what a reader keeps of a card and what a sender may send, each bound, and the
 * card beside its fallback text on every wire that carries one.
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const NOW = Date.UTC(2026, 8, 29, 12, 0);
const ID = "A".repeat(22);

const task = (extra: Record<string, unknown> = {}) => ({ kind: "task", id: "relay-rotation", title: "Fix relay rotation", status: "running", ...extra });
const routine = (extra: Record<string, unknown> = {}) => ({ kind: "routine", id: "bughunt", name: "Nightly bug hunt", schedule: "every day 01:00", state: "active", ...extra });

describe("a card as a reader takes it", () => {
  it("keeps a task's fields as sent", () => {
    const raw = task({
      progress: 40, done: 2, total: 5, step: "Running the e2e", branch: "r6a/relay-rotation", startedAt: NOW - 60_000, updatedAt: NOW,
      pr: { url: "https://github.com/MiguelMedeiros/ghostly/pull/612", number: 612, additions: 123, deletions: 45, files: 7 },
      items: [{ text: "Codec", state: "done" }, { text: "Engine", state: "running" }], links: [{ url: "https://ci.example/run/1", label: "CI run" }],
    });
    expect(readStatusCard(raw, NOW)).toEqual(raw);
  });

  it("drops a card that cannot stand, never guessing: the message then shows its text", () => {
    for (const bad of [null, "task", [], task({ kind: "poll" }), task({ status: "paused" }), task({ status: undefined }), task({ title: "" }), task({ title: "\u202e\u200b" }),
      task({ id: "" }), task({ id: "-flag" }), task({ id: "a b" }), task({ id: "x".repeat(65) }), routine({ state: "running" }), routine({ schedule: 3 }), routine({ name: undefined })])
      expect(readStatusCard(bad, NOW)).toBeUndefined();
  });

  it("refuses a card past its bytes, whatever it holds", () => {
    const big = task({ items: Array.from({ length: 20 }, () => ({ text: "é".repeat(200), state: "done" })) });
    expect(JSON.stringify(big).length).toBeLessThan(STATUS_CARD_LIMITS.bytes);
    expect(new TextEncoder().encode(JSON.stringify(big)).length).toBeGreaterThan(STATUS_CARD_LIMITS.bytes);
    expect(readStatusCard(big, NOW)).toBeUndefined();
  });

  it("clamps what has a range and leaves out what does not hold", () => {
    const card = readStatusCard(task({
      progress: 140.6, done: 7, total: 5, step: "line one\nline two", branch: 12, startedAt: NOW + 3_600_000, updatedAt: -5,
      pr: { url: "http://github.com/o/r/pull/1", number: 1 }, links: [{ url: "javascript:alert(1)" }, { url: "https://user:pw@evil.example/" }, { url: "https://ok.example/x", label: "ok" }],
      items: [...Array.from({ length: 25 }, (_, i) => ({ text: `step ${i}`, state: i === 0 ? "exploded" : "done" })), { text: "" }],
    }), NOW) as TaskCard;
    expect(card.progress).toBe(100);
    expect(card.done).toBeUndefined();
    expect(card.step).toBe("line one line two");
    expect(card.branch).toBeUndefined();
    expect(card.startedAt).toBe(NOW + 5 * 60_000);
    expect(card.updatedAt).toBeUndefined();
    expect(card.pr).toBeUndefined();
    expect(card.links).toEqual([{ url: "https://ok.example/x", label: "ok" }]);
    expect(card.items).toHaveLength(STATUS_CARD_LIMITS.items);
    expect(card.items![0]).toEqual({ text: "step 0", state: "pending" });
  });

  it("shows text as one clean line, without direction or invisible characters, cut to its bound", () => {
    const card = readStatusCard(task({ title: "a\u202etxt.exe\u200b  b", step: "x".repeat(500) }), NOW) as TaskCard;
    expect(card.title).toBe("atxt.exe b");
    expect([...card.step!]).toHaveLength(STATUS_CARD_LIMITS.line);
  });

  it("keeps a routine's next run up to a year ahead, and its runs within their bound", () => {
    const runs = Array.from({ length: 14 }, (_, i) => ({ at: NOW - i * 86_400_000, result: i % 2 ? "ok" : "failed", summary: `run ${i}` }));
    const card = readStatusCard(routine({ cron: "0 1 * * *", nextRunAt: NOW + 13 * 3_600_000, lastRun: runs[0], runs }), NOW) as RoutineCard;
    expect(card.nextRunAt).toBe(NOW + 13 * 3_600_000);
    expect(card.cron).toBe("0 1 * * *");
    expect(card.runs).toHaveLength(STATUS_CARD_LIMITS.runs);
    expect(card.lastRun).toEqual(runs[0]);
    const far = readStatusCard(routine({ nextRunAt: NOW + 400 * 86_400_000, cron: "0 1 * * *; rm -rf /", lastRun: { at: NOW, result: "maybe" } }), NOW) as RoutineCard;
    expect(far.nextRunAt).toBeUndefined();
    expect(far.cron).toBeUndefined();
    expect(far.lastRun).toBeUndefined();
  });
});

describe("a card as a sender may send it", () => {
  it("takes a card within every bound", () => {
    expect(checkStatusCard(task({ progress: 0, items: [{ text: "a" }] }), NOW)).toEqual({ card: { ...task({ progress: 0 }), items: [{ text: "a", state: "pending" }] } });
    expect(checkStatusCard(routine({ nextRunAt: NOW + 1000 }), NOW)).toHaveProperty("card");
  });

  it("refuses what a reader would drop or cut, saying why", () => {
    const cases: [unknown, RegExp][] = [
      [task({ status: "paused" }), /status is one of/],
      [task({ kind: "poll" }), /kind is task, routine or buttons/],
      [task({ id: "-x" }), /id is/],
      [task({ title: "t".repeat(121) }), /title is at most 120/],
      [task({ progress: 101 }), /progress/],
      [task({ done: 3 }), /done and total go together/],
      [task({ done: 6, total: 5 }), /done is at most total/],
      [task({ pr: { url: "http://github.com/o/r/pull/1" } }), /pr.url must be an https link/],
      [task({ pr: { url: "https://github.com/o/r/pull/1", additions: -1 } }), /pr.additions/],
      [task({ items: Array.from({ length: 21 }, () => ({ text: "x" })) }), /items is a list of at most 20/],
      [task({ items: [{ text: "x", state: "exploded" }] }), /items\[0\].state/],
      [task({ step: "s".repeat(201) }), /step is at most 200/],
      [task({ updatedAt: NOW + 3_600_000 }), /updatedAt/],
      [task({ links: [{ url: "ftp://x.example/" }] }), /links\[0\].url/],
      [task({ items: Array.from({ length: 20 }, () => ({ text: "é".repeat(200) })) }), /at most 8192/],
      [routine({ nextRunAt: NOW + 400 * 86_400_000 }), /nextRunAt/],
      [routine({ runs: [{ at: NOW, result: "maybe" }] }), /runs\[0\].result/],
    ];
    for (const [raw, error] of cases) {
      const result = checkStatusCard(raw, NOW);
      expect(result, JSON.stringify(raw).slice(0, 80)).toHaveProperty("error");
      expect((result as { error: string }).error).toMatch(error);
    }
  });
});

describe("links on a card", () => {
  it("are https only and shown with their host", () => {
    expect(cardUrl("https://github.com/o/r/pull/1")).toBe("https://github.com/o/r/pull/1");
    expect(cardUrl("https://bücher.example/x")).toBe("https://xn--bcher-kva.example/x");
    for (const bad of ["http://x.example", "javascript:alert(1)", "https://a b.example", "https://x.example/\u202e", `https://x.example/${"a".repeat(600)}`, "data:text/html,x", "//x.example"])
      expect(cardUrl(bad)).toBeUndefined();
    expect(cardLinkHost("https://github.com/o/r/pull/1")).toBe("github.com");
  });
});

describe("the fallback text", () => {
  it("names a task, its state, what it does now and its PR, on plain lines", () => {
    const card = readStatusCard(task({ progress: 40, done: 2, total: 5, step: "Running the e2e", pr: { url: "https://github.com/o/r/pull/612", number: 612, additions: 123, deletions: 45 } }), NOW)!;
    expect(statusCardText(card)).toBe("🔄 Fix relay rotation\nRunning · 40% · 2 of 5 steps\nNow: Running the e2e\nPR #612 +123 -45: https://github.com/o/r/pull/612");
    expect(statusCardText(readStatusCard(task({ status: "done" }), NOW)!)).toBe("✅ Fix relay rotation\nDone");
  });

  it("says what a task does now only while it is going, as the card shows it", () => {
    const text = (status: string) => statusCardText(readStatusCard(task({ status, step: "Building", progress: 100 }), NOW)!);
    expect(text("done")).toBe("✅ Fix relay rotation\nDone · 100%");
    expect(text("failed")).toBe("❌ Fix relay rotation\nFailed · 100%");
    expect(text("cancelled")).toBe("🚫 Fix relay rotation\nCancelled · 100%");
    for (const status of ["queued", "running", "blocked"]) expect(text(status)).toMatch(/\nNow: Building$/);
  });

  it("says a routine's schedule, its last run and its next", () => {
    const card = readStatusCard(routine({ lastRun: { at: Date.UTC(2026, 8, 29, 1, 0), result: "ok", summary: "12 issues checked" }, nextRunAt: Date.UTC(2026, 8, 30, 1, 0) }), NOW)!;
    expect(statusCardText(card)).toBe("🔁 Nightly bug hunt\nevery day 01:00 · active\nLast run: ok, 2026-09-29 01:00 UTC · 12 issues checked\nNext run: 2026-09-30 01:00 UTC");
  });

  it("works out progress from steps when no percent is given", () => {
    expect(taskProgress({ done: 1, total: 3 })).toBe(33);
    expect(taskProgress({ progress: 5, done: 1, total: 3 })).toBe(5);
    expect(taskProgress({})).toBeUndefined();
  });
});

describe("a card on the live session", () => {
  const card = readStatusCard(task({ progress: 10 }), NOW)!;

  it("rides as `sc` on paired-message beside the text older apps read", () => {
    const frame = JSON.parse(pairedMessageFrame(ID, NOW, statusCardText(card), undefined, undefined, undefined, card));
    expect(frame).toEqual({ t: "paired-message", id: ID, ts: NOW, m: statusCardText(card), sc: card });
    expect(JSON.parse(pairedMessageFrame(ID, NOW, "plain"))).not.toHaveProperty("sc");
  });

  it("rides on paired-edit; an edit past a text's hundred holds only with a card", () => {
    const withCard = JSON.parse(editFrame({ id: ID, e: 101, ts: NOW, m: "🔄 x", sc: card }));
    expect(parseEditFrame(withCard, NOW)).toEqual({ id: ID, e: 101, ts: NOW, m: "🔄 x", sc: card });
    expect(parseEditFrame({ ...withCard, sc: undefined }, NOW)).toBeNull();
    expect(parseEditFrame({ ...withCard, sc: { kind: "task" } }, NOW)).toBeNull();
    expect(parseEditFrame({ ...withCard, e: STATUS_CARD_LIMITS.edits + 1 }, NOW)).toBeNull();
    // Within a text's hundred a bad card is left out, never the edit: it shows as text.
    expect(parseEditFrame({ ...withCard, e: MAX_EDITS_PER_MESSAGE, sc: { kind: "task" } }, NOW)).toEqual({ id: ID, e: MAX_EDITS_PER_MESSAGE, ts: NOW, m: "🔄 x" });
  });
});

/** Mesh members wired directly, every edge open. */
function mesh() {
  const sessions = new Map<string, GroupSession>();
  const inbox = new Map<string, GroupIncomingMessage[]>();
  const edits = new Map<string, GroupIncomingEdit[]>();
  let pending: Promise<unknown>[] = [];
  const add = (state: ReturnType<typeof GroupSession.create>) => {
    const session: GroupSession = new GroupSession(state, {
      save: async () => {},
      send: (to, frame: GroupEdgeFrame) => { const t = sessions.get(to); if (t) pending.push(t.handle(session.myKey, clone(frame))); },
      message: m => { inbox.get(session.myKey)!.push(m); },
      edit: e => { edits.get(session.myKey)!.push(e); },
      changed: () => {},
    });
    sessions.set(session.myKey, session); inbox.set(session.myKey, []); edits.set(session.myKey, []);
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
  return { admit, add, settle, inbox, edits };
}

describe("a card in a private group", () => {
  const card = readStatusCard(task({ progress: 10 }))!;

  it("is sealed in a box of its own, covered by the author's whole signature; every member gets it beside the text", async () => {
    const net = mesh();
    const alice = net.add(GroupSession.create("Sala de Máquinas"));
    const bob = await net.admit(alice);
    expect(await alice.sendText(statusCardText(card), Date.now(), [], undefined, undefined, card)).toHaveProperty("id");
    await net.settle();
    expect(net.inbox.get(bob.myKey)!.at(-1)).toMatchObject({ text: statusCardText(card), card });
    const frame = alice.state.sent.at(-1)!;
    expect(frame.sc).toBeDefined();
    expect(JSON.stringify(frame)).not.toContain("Fix relay rotation");
  });

  it("handed on by another member, keeps its card only with the author's signature over it", async () => {
    const net = mesh();
    const alice = net.add(GroupSession.create("Ghosts"));
    const bob = await net.admit(alice), carol = await net.admit(alice);
    const heard: GroupIncomingMessage[] = [];
    const reader = new GroupSession(clone(carol.state), { save: async () => {}, send: () => {}, message: m => { heard.push(m); }, changed: () => {} });
    await alice.sendText("🔄 task", Date.now(), [], undefined, undefined, card);
    await alice.sendText("plain", Date.now());
    await net.settle();
    const [carded, plain] = alice.state.sent.slice(-2).map(clone) as GroupMessageFrame[];
    await reader.handle(bob.myKey, carded);
    // Bob grafts the first message's card onto the second: the signature over the whole frame no longer holds.
    await reader.handle(bob.myKey, { ...plain, sc: carded.sc });
    expect(heard.map(m => [m.text, m.card?.id])).toEqual([["🔄 task", "relay-rotation"], ["plain", undefined]]);
  });

  it("an edit carries the card of its version, and may go past a text's hundred with one", async () => {
    const net = mesh();
    const alice = net.add(GroupSession.create("Ghosts"));
    const bob = await net.admit(alice);
    const { id } = await alice.sendText("🔄 task", Date.now(), [], undefined, undefined, card) as { id: string };
    await net.settle();
    const done = readStatusCard(task({ status: "done", progress: 100 }))!;
    expect(await alice.sendEdit(id, { v: 150, ts: 1000, text: statusCardText(done), card: done })).toEqual({ sent: 1 });
    expect(await alice.sendEdit(id, { v: 151, ts: 1001, text: "plain again" })).toEqual({ error: "This message was edited too many times" });
    await net.settle();
    expect(net.edits.get(bob.myKey)).toEqual([{ id, sender: alice.myKey, e: 150, ts: 1000, m: statusCardText(done), sc: done }]);
  });
});

/** Community members on one network where every broadcast reaches everyone. */
function community() {
  const members: CommunitySession[] = [];
  const inbox = new Map<string, CommunityIncomingMessage[]>();
  const apps = new Map<string, Record<string, unknown>[]>();
  let pending: Promise<unknown>[] = [];
  const hooks = (get: () => CommunitySession) => {
    const deliver = (to: CommunitySession | undefined, frame: CommunityFrame) => { if (to && to !== get()) pending.push(to.handle(get().myKey, clone(frame))); };
    return {
      save: async () => {},
      broadcast: (frame: CommunityFrame) => { for (const m of members) deliver(m, frame); },
      direct: (to: string, frame: CommunityFrame) => deliver(members.find(m => m.myKey === to), frame),
      addressed: (to: string, frame: CommunityFrame) => deliver(members.find(m => m.myKey === to), frame),
      message: (m: CommunityIncomingMessage) => { inbox.get(get().myKey)!.push(m); },
      app: (a: { frame: Record<string, unknown> }) => { apps.get(get().myKey)!.push(a.frame); },
      changed: () => {},
    };
  };
  const settle = async () => { for (let i = 0; i < 200 && pending.length; i++) { const batch = pending; pending = []; await Promise.all(batch); } };
  const push = (state: ReturnType<typeof CommunitySession.create>) => {
    let session: CommunitySession;
    // eslint-disable-next-line prefer-const
    session = new CommunitySession(state, hooks(() => session));
    members.push(session); inbox.set(session.myKey, []); apps.set(session.myKey, []);
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
  return { push, admit, settle, inbox, apps };
}

describe("a card in a community", () => {
  it("rides inside the sealed payload as `sc`, and its edit frame carries the card of its version", async () => {
    const net = community();
    const alice = net.push(CommunitySession.create("Ghosts"));
    const bob = await net.admit(alice);
    await net.settle();
    const card = readStatusCard(task({ progress: 10 }))!;
    const sent = await bob.sendText(statusCardText(card), "Bot", Date.now(), [], undefined, undefined, card) as { id: string };
    await net.settle();
    expect(net.inbox.get(alice.myKey)!.at(-1)).toMatchObject({ text: statusCardText(card), card });
    const done = readStatusCard(task({ status: "done" }))!;
    expect(await bob.sendEdit({ id: sent.id, v: 101, ts: 5, text: statusCardText(done), card: done }, "Bot")).toHaveProperty("id");
    await net.settle();
    const frame = net.apps.get(alice.myKey)!.at(-1)!;
    expect(parseCommunityEdit(frame, bob.myKey)).toEqual({ id: sent.id, e: 101, ts: 5, m: statusCardText(done), sc: done });
    // Past a text's hundred, an edit without its card is not one.
    expect(parseCommunityEdit(communityEditFrame({ id: sent.id, e: 101, ts: 5, m: "x" }), bob.myKey)).toBeNull();
  });
});
