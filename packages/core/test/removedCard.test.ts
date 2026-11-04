import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { editFrame, parseEditFrame, MAX_EDITS_PER_MESSAGE } from "../src/pairedEdits";
import { GroupSession, type GroupEdgeFrame, type GroupIncomingMessage } from "../src/groupSession";
import { CommunitySession, type CommunityFrame } from "../src/groupCommunity";
import { parseCommunityEdit, type GroupIncomingEdit } from "../src/groupEdits";
import { STATUS_CARD_LIMITS, checkStatusCard, readStatusCard, removedCardText, statusCardText } from "../src/statusCards";
import * as shipped from "./fixtures/statusCards-1.0.1";
// covers: chat.status-cards.wire

/*
 * A card its sender takes back (WISP 405 · Status Cards § Removing a card): `{kind: "removed", id, of}`, carried as an
 * edit of the card's message on every path. What a reader keeps of it, what a sender may send, its text, and what an
 * app from before it does: Ghostly 1.0.1's reader (frozen in fixtures/) drops the unknown kind and shows the text.
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const NOW = Date.UTC(2026, 9, 18, 4, 0);
const ID = "A".repeat(22);
const removed = (extra: Record<string, unknown> = {}) => ({ kind: "removed", id: "relay-rotation", of: "task", ...extra });
const task = { kind: "task", id: "relay-rotation", title: "Fix relay rotation", status: "running" };

describe("a removed card as a reader takes it", () => {
  it("keeps its id and what it was, a task or a routine", () => {
    expect(readStatusCard(removed(), NOW)).toEqual(removed());
    expect(readStatusCard(removed({ of: "routine", id: "bughunt" }), NOW)).toEqual({ kind: "removed", id: "bughunt", of: "routine" });
  });

  it("leaves out anything else it carries", () => {
    expect(readStatusCard(removed({ title: "Fix relay rotation", status: "done", links: [{ url: "https://x.example/" }] }), NOW)).toEqual(removed());
  });

  it("is dropped when its id or what it was does not hold", () => {
    for (const bad of [removed({ of: "usage" }), removed({ of: "app" }), removed({ of: undefined }), removed({ id: "-x" }), removed({ id: "" }), removed({ id: 7 })])
      expect(readStatusCard(bad, NOW), JSON.stringify(bad)).toBeUndefined();
  });
});

describe("a removed card as a sender may send it", () => {
  it("is its kind, the card's id and what it was", () => {
    expect(checkStatusCard(removed(), NOW)).toEqual({ card: removed() });
    expect(checkStatusCard(removed({ of: "routine" }), NOW)).toEqual({ card: removed({ of: "routine" }) });
  });

  it("is refused anything a reader would leave out or drop, saying why", () => {
    const cases: [unknown, RegExp][] = [
      [removed({ of: "usage" }), /of is one of task, routine/],
      [removed({ of: undefined }), /of is one of task, routine/],
      [removed({ title: "Fix relay rotation" }), /takes only kind, id and of, not title/],
      [removed({ links: [{ url: "https://x.example/" }] }), /takes only kind, id and of, not links/],
      [removed({ id: "-x" }), /id is/],
    ];
    for (const [raw, error] of cases) expect((checkStatusCard(raw, NOW) as { error?: string }).error, JSON.stringify(raw)).toMatch(error);
  });
});

describe("a removed card's text", () => {
  it("says what was removed, and its title when the sender knows it", () => {
    expect(statusCardText(readStatusCard(removed(), NOW)!)).toBe("🗑 Task removed");
    expect(statusCardText(readStatusCard(removed({ of: "routine" }), NOW)!)).toBe("🗑 Routine removed");
    expect(removedCardText("task", "Fix relay rotation")).toBe("🗑 Task removed: Fix relay rotation");
    expect(removedCardText("routine", "Nightly bug hunt")).toBe("🗑 Routine removed: Nightly bug hunt");
  });
});

describe("an app from before removals (Ghostly 1.0.1's reader)", () => {
  it("drops the unknown kind, so the message shows its text: the card is gone there too", () => {
    expect(shipped.readStatusCard(task, NOW)).toBeDefined();
    expect(shipped.readStatusCard(removed(), NOW)).toBeUndefined();
    expect(shipped.readStatusCard(JSON.parse(JSON.stringify((checkStatusCard(removed(), NOW) as { card: unknown }).card)), NOW)).toBeUndefined();
  });
});

describe("a removal rides as an edit on every path", () => {
  const card = readStatusCard(removed(), NOW)!;
  const text = removedCardText("task", "Fix relay rotation");

  it("on paired-edit, past a text's hundred too", () => {
    for (const e of [1, MAX_EDITS_PER_MESSAGE + 1, STATUS_CARD_LIMITS.edits]) {
      const frame = JSON.parse(editFrame({ id: ID, e, ts: NOW, m: text, sc: card }));
      expect(parseEditFrame(frame, NOW)).toEqual({ id: ID, e, ts: NOW, m: text, sc: card });
    }
  });

  it("on a private group's edit", async () => {
    const sessions = new Map<string, GroupSession>();
    const edits: GroupIncomingEdit[] = [];
    let pending: Promise<unknown>[] = [];
    const add = (state: ReturnType<typeof GroupSession.create>, onEdit?: (e: GroupIncomingEdit) => void) => {
      const session: GroupSession = new GroupSession(state, {
        save: async () => {},
        send: (to, frame: GroupEdgeFrame) => { const t = sessions.get(to); if (t) pending.push(t.handle(session.myKey, clone(frame))); },
        message: (_m: GroupIncomingMessage) => {},
        edit: e => { onEdit?.(e); },
        changed: () => {},
      });
      sessions.set(session.myKey, session);
      return session;
    };
    const settle = async () => { while (pending.length) { const batch = pending; pending = []; await Promise.all(batch); } };
    const alice = add(GroupSession.create("Ghosts"));
    const seed = createIdentity().seedB64;
    const welcome = await alice.admit(identityFromSeedB64(seed).pubKeyZ32);
    const invite = alice.inviteFrame();
    const joined = GroupSession.join({ name: invite.name, admin: invite.admin }, welcome.slice(0, -1), welcome[welcome.length - 1], seed);
    if ("error" in joined) throw new Error(joined.error);
    const bob = add(joined.state, e => edits.push(e));
    await settle();
    const running = readStatusCard(task, NOW)!;
    const { id } = await alice.sendText(statusCardText(running), Date.now(), [], undefined, undefined, running) as { id: string };
    await settle();
    expect(await alice.sendEdit(id, { v: 150, ts: 1000, text, card })).toEqual({ sent: 1 });
    await settle();
    expect(edits).toEqual([{ id, sender: alice.myKey, e: 150, ts: 1000, m: text, sc: card }]);
    expect(bob.myKey).not.toBe(alice.myKey);
  });

  it("on a community's edit frame", async () => {
    const members: CommunitySession[] = [];
    const apps: Record<string, unknown>[] = [];
    let pending: Promise<unknown>[] = [];
    const push = (state: ReturnType<typeof CommunitySession.create>, onApp?: (frame: Record<string, unknown>) => void) => {
      const deliver = (to: CommunitySession | undefined, frame: CommunityFrame) => { if (to && to !== session) pending.push(to.handle(session.myKey, clone(frame))); };
      const session: CommunitySession = new CommunitySession(state, {
        save: async () => {},
        broadcast: (frame: CommunityFrame) => { for (const m of members) deliver(m, frame); },
        direct: (to: string, frame: CommunityFrame) => deliver(members.find(m => m.myKey === to), frame),
        addressed: (to: string, frame: CommunityFrame) => deliver(members.find(m => m.myKey === to), frame),
        message: () => {},
        app: (a: { frame: Record<string, unknown> }) => { onApp?.(a.frame); },
        changed: () => {},
      });
      members.push(session);
      return session;
    };
    const settle = async () => { for (let i = 0; i < 200 && pending.length; i++) { const batch = pending; pending = []; await Promise.all(batch); } };
    const alice = push(CommunitySession.create("Ghosts"), frame => apps.push(frame));
    const seedB64 = createIdentity().seedB64;
    const frames = await alice.admit(identityFromSeedB64(seedB64).pubKeyZ32);
    await settle();
    const joined = CommunitySession.join({ g: alice.id, host: alice.entryKey }, clone(frames.slice(0, -1)), clone(frames[frames.length - 1]), seedB64);
    if ("error" in joined) throw new Error(joined.error);
    const bob = push(joined.state);
    await settle();
    const running = readStatusCard(task, NOW)!;
    const sent = await bob.sendText(statusCardText(running), "Bot", Date.now(), [], undefined, undefined, running) as { id: string };
    await settle();
    expect(await bob.sendEdit({ id: sent.id, v: 101, ts: 5, text, card }, "Bot")).toHaveProperty("id");
    await settle();
    expect(parseCommunityEdit(apps.at(-1)!, bob.myKey)).toEqual({ id: sent.id, e: 101, ts: 5, m: text, sc: card });
  });
});
