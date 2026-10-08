import { describe, expect, it } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { pairedMessageFrame } from "../src/ghostlink";
import { editFrame, parseEditFrame } from "../src/pairedEdits";
import { GroupSession, type GroupEdgeFrame, type GroupIncomingMessage } from "../src/groupSession";
import { CommunitySession, type CommunityFrame, type CommunityIncomingMessage } from "../src/groupCommunity";
import { BUTTONS_CAPABILITY, KNOWN_SESSION_CAPABILITIES } from "../src/pairedCapabilities";
import { groupReplyAuthor, pairedReplyAuthor, readReply, wireReply } from "../src/replies";
import { STATUS_CARD_LIMITS, buttonLabelClash, checkStatusCard, readStatusCard, sameButtonText, statusCardText, type ButtonsCard } from "../src/statusCards";
// covers: chat.buttons.wire

/*
 * Message buttons (WISP 406 · Message Buttons): a card of kind `buttons` beside a bot's text, bounded and read by the
 * reader's rule; a press as a reply naming the button (`r.b`), which an older reader takes as an ordinary reply; both on
 * every wire that carries a card or a reply.
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const NOW = Date.UTC(2026, 8, 30, 12, 0);
const ID = "A".repeat(22);

const ask = (extra: Record<string, unknown> = {}) => ({
  kind: "buttons", id: "ask-30", buttons: [{ id: "yes", label: "Yes", style: "primary", once: true }, { id: "no", label: "No", once: true }], ...extra,
});

describe("buttons as a reader takes them", () => {
  it("keeps the buttons as sent, with the bot's answer and whether they are closed", () => {
    expect(readStatusCard(ask(), NOW)).toEqual(ask());
    expect(readStatusCard(ask({ chosen: "yes", closed: true }), NOW)).toEqual(ask({ chosen: "yes", closed: true }));
  });

  it("leaves out a button that does not hold, and drops the card when none does: the text shows", () => {
    const card = readStatusCard(ask({ buttons: [
      { id: "yes", label: "Yes" }, { id: "yes", label: "Again" }, { id: "-x", label: "Flag" }, { id: "b", label: "" }, "c", { id: "ok", label: "Fine", style: "loud", once: "yes" },
    ] }), NOW) as ButtonsCard;
    expect(card.buttons).toEqual([{ id: "yes", label: "Yes" }, { id: "ok", label: "Fine" }]);
    for (const bad of [ask({ buttons: [] }), ask({ buttons: "yes" }), ask({ buttons: [{ id: "", label: "x" }] }), ask({ id: undefined })])
      expect(readStatusCard(bad, NOW)).toBeUndefined();
  });

  it("cuts the list and each label to its bound, and cleans a label to one line", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `b${i}`, label: `Option ${i}` }));
    const card = readStatusCard(ask({ buttons: [{ id: "long", label: `Yes\nplease ‮${"x".repeat(60)}` }, ...many] }), NOW) as ButtonsCard;
    expect(card.buttons).toHaveLength(STATUS_CARD_LIMITS.buttons);
    expect([...card.buttons[0].label].length).toBeLessThanOrEqual(STATUS_CARD_LIMITS.buttonLabel);
    expect(card.buttons[0].label.startsWith("Yes please x")).toBe(true);
  });

  it("drops an answer that names no button, and a neutral style says nothing", () => {
    expect(readStatusCard(ask({ chosen: "maybe", closed: "yes" }), NOW)).toEqual(ask());
    expect((readStatusCard(ask({ buttons: [{ id: "a", label: "A", style: "neutral" }] }), NOW) as ButtonsCard).buttons).toEqual([{ id: "a", label: "A" }]);
  });
});

describe("buttons as a sender may send them", () => {
  it("takes buttons within every bound", () => {
    expect(checkStatusCard(ask({ chosen: "no", closed: true }), NOW)).toEqual({ card: ask({ chosen: "no", closed: true }) });
  });

  it("refuses what a reader would drop or cut, saying why", () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [ask({ buttons: [] }), /1 to 6/],
      [ask({ buttons: Array.from({ length: 7 }, (_, i) => ({ id: `b${i}`, label: "x" })) }), /1 to 6/],
      [ask({ buttons: [{ id: "a", label: "A" }, { id: "a", label: "B" }] }), /used twice/],
      [ask({ buttons: [{ id: "a b", label: "A" }] }), /buttons\[0\]\.id/],
      [ask({ buttons: [{ id: "a", label: "x".repeat(41) }] }), /at most 40/],
      [ask({ buttons: [{ id: "a", label: "" }] }), /label is text/],
      [ask({ buttons: [{ id: "a", label: "A", style: "loud" }] }), /style/],
      [ask({ buttons: [{ id: "a", label: "A", once: 1 }] }), /once/],
      [ask({ chosen: "maybe" }), /chosen/],
      [ask({ closed: false }), /closed/],
      [ask({ links: [{ url: "https://example.com" }] }), /no links/],
      [ask({ kind: "poll" }), /task, routine, buttons, app or usage/],
    ];
    for (const [raw, error] of cases) expect(checkStatusCard(raw, NOW)).toEqual({ error: expect.stringMatching(error) });
  });

  it("refuses two buttons a typed answer could not tell apart, naming them", () => {
    // The same label, however it is cased or spaced.
    expect(checkStatusCard(ask({ buttons: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }, { id: "ok", label: " yes " }] }), NOW))
      .toEqual({ error: expect.stringMatching(/buttons\[2\]\.label "yes" repeats buttons\[0\]\.label/) });
    // A label that is another button's id: "no" typed would be the first button's label and the second's id.
    expect(checkStatusCard(ask({ buttons: [{ id: "yes", label: "No" }, { id: "no", label: "Nope" }] }), NOW))
      .toEqual({ error: expect.stringMatching(/buttons\[0\]\.label "No" is buttons\[1\]\.id/) });
    expect(buttonLabelClash([{ id: "a", label: "Same" }, { id: "b", label: "SAME" }])).toEqual({ at: 1, with: 0, kind: "label" });
    // A label that is its own id is what most buttons are; labels apart only past case and spaces are fine.
    expect(checkStatusCard(ask({ buttons: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }, { id: "later", label: "Yes, later" }] }), NOW)).toHaveProperty("card");
    expect(buttonLabelClash([{ id: "yes", label: "YES" }, { id: "no", label: "no" }])).toBeUndefined();
  });

  it("a reader keeps a card that repeats a label, and a typed answer takes the first", () => {
    const card = readStatusCard(ask({ buttons: [{ id: "a", label: "Yes" }, { id: "b", label: "yes" }, { id: "c", label: "a" }] }), NOW) as ButtonsCard;
    expect(card.buttons.map(b => b.id)).toEqual(["a", "b", "c"]);
    expect(card.buttons.find(b => sameButtonText(b.label, " YES ") || sameButtonText(b.id, " YES "))?.id).toBe("a");
    expect(card.buttons.find(b => sameButtonText(b.label, "a") || sameButtonText(b.id, "a"))?.id).toBe("a");
  });

  it("says the answers in words when the bot gave no text of its own", () => {
    expect(statusCardText(readStatusCard(ask(), NOW)!)).toBe("Reply: Yes / No");
  });
});

describe("a press is a reply naming the button", () => {
  it("keeps a button id that holds, and an older reader sees an ordinary reply", () => {
    const press = { i: ID, s: "Want the $30 one?", f: "recipient", b: "yes" };
    expect(readReply(press, pairedReplyAuthor)).toEqual(press);
    expect(wireReply(press)).toEqual(press);
    // An id that does not hold: only a reply, never a press, and the message stays.
    expect(readReply({ ...press, b: "no way" }, pairedReplyAuthor)).toEqual({ i: ID, s: "Want the $30 one?", f: "recipient" });
    expect(readReply({ ...press, b: 7 }, pairedReplyAuthor)).toEqual({ i: ID, s: "Want the $30 one?", f: "recipient" });
    // What an app from before buttons keeps of it: `{ i, s, f }`.
    const { i, s, f } = press;
    expect(readReply(clone({ i, s, f }), pairedReplyAuthor)).toEqual({ i, s, f });
  });

  it("rides on paired-message as `r.b`, the label as its text", () => {
    const frame = JSON.parse(pairedMessageFrame("B".repeat(22), NOW, "Yes", undefined, { i: ID, s: "Want the $30 one?", f: "recipient", b: "yes" }));
    expect(frame).toEqual({ t: "paired-message", id: "B".repeat(22), ts: NOW, m: "Yes", r: { i: ID, s: "Want the $30 one?", f: "recipient", b: "yes" } });
  });

  it("the bot marks its answer with an edit carrying the card of that version", () => {
    const card = readStatusCard(ask({ chosen: "yes", closed: true }), NOW)!;
    const edit = JSON.parse(editFrame({ id: ID, e: 1, ts: NOW, m: "Want the $30 one?", sc: card }));
    expect(parseEditFrame(edit, NOW)).toEqual({ id: ID, e: 1, ts: NOW, m: "Want the $30 one?", sc: card });
  });

  it("is a capability a 1:1 app says it has, so a bot knows its contact can press", () => {
    expect(BUTTONS_CAPABILITY).toBe("buttons/1");
    expect(KNOWN_SESSION_CAPABILITIES).toContain(BUTTONS_CAPABILITY);
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

describe("buttons in a private group", () => {
  it("every member gets the buttons, and the bot learns who pressed which", async () => {
    const net = mesh();
    const bot = net.add(GroupSession.create("Shop"));
    const bob = await net.admit(bot), carol = await net.admit(bot);
    const card = readStatusCard(ask())!;
    const { id } = await bot.sendText("Want the $30 one?", Date.now(), [], undefined, undefined, card) as { id: string };
    await net.settle();
    expect(net.inbox.get(bob.myKey)!.at(-1)).toMatchObject({ id, text: "Want the $30 one?", card });
    expect(await carol.sendText("Yes", Date.now(), [], { i: id, s: "Want the $30 one?", f: bot.myKey, b: "yes" })).toHaveProperty("id");
    await net.settle();
    const press = net.inbox.get(bot.myKey)!.at(-1)!;
    expect(press).toMatchObject({ sender: carol.myKey, text: "Yes", reply: { i: id, f: bot.myKey, b: "yes" } });
    expect(groupReplyAuthor(press.reply!.f)).toBe(true);
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
      app: () => {},
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

describe("buttons in a community", () => {
  it("the buttons ride in the payload and a press comes back naming its button", async () => {
    const net = community();
    const alice = net.push(CommunitySession.create("Ghosts"));
    const bot = await net.admit(alice);
    await net.settle();
    const card = readStatusCard(ask())!;
    const sent = await bot.sendText("Want the $30 one?", "Bot", Date.now(), [], undefined, undefined, card) as { id: string };
    await net.settle();
    expect(net.inbox.get(alice.myKey)!.at(-1)).toMatchObject({ text: "Want the $30 one?", card });
    await alice.sendText("No", "Alice", Date.now(), [], { i: sent.id, s: "Want the $30 one?", f: bot.myKey, b: "no" });
    await net.settle();
    expect(net.inbox.get(bot.myKey)!.at(-1)).toMatchObject({ sender: alice.myKey, text: "No", reply: { i: sent.id, b: "no" } });
  });
});
