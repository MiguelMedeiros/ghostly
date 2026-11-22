import { describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, Settings } from "@ghostly/browser/shared/types";
import { callApi, mentionsFor, type ApiContext } from "../src/api";
import { chatViewOf, groupViewOf } from "./support/chatView";
// covers: headless.groups

/**
 * `group send|edit --mention`: where in the text each mention is placed (WISP 902 § Mentions: code points). A
 * mention stands on a whole `@name`, one no letter, mark, digit or "_" follows, as the app's composer ends a token.
 */
const AL = "key1aaaa11", ALICE = "key2bbbb22", ALLAN = "key3cccc33", JR = "key4dddd44";
const crew = {
  id: "g1", name: "Crew", createdAt: 1, profile: "community", isAdmin: true, canSend: true, lastMessageAt: 0, invited: [], memberLinks: {},
  members: [
    { key: "mekey", role: "admin", me: true, online: true, missing: 0 },
    { key: AL, role: "member", me: false, online: true, missing: 0, nick: "Al" },
    { key: ALICE, role: "member", me: false, online: true, missing: 0, nick: "Alice" },
    { key: ALLAN, role: "member", me: false, online: true, missing: 0, nick: "Allan" },
    { key: JR, role: "member", me: false, online: true, missing: 0, nick: "J.R." },
  ],
} as unknown as GroupView;

/** `group send` over a fake engine that keeps what it was asked to send. */
function fake() {
  const node = {
    chatView: chatViewOf, groupView: groupViewOf,
    getState: () => ({ links: [], groups: [crew], settings: { online: true, nick: "Bot" } as unknown as Settings, transport: { protocol: "p", relays: [] } }) as unknown as EngineState,
    getSettings: (): Settings => node.getState().settings,
    sendGroupMessage: vi.fn(async (_params: unknown) => ({ error: null })),
    setTyping: vi.fn(),
    setGroupTyping: vi.fn(),
  };
  const ctx = {
    runtime: { server: { node }, paths: { name: "default" } },
    hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] },
    calls: { list: () => [], forgetChat: vi.fn() },
    groupAuto: { get: () => ({ on: false, from: [] }), forgetChat: vi.fn() },
    mode: "daemon", version: "test",
  } as unknown as ApiContext;
  return { ctx, node };
}

describe("group mentions", () => {
  // It was put on the first "@al" anywhere in the lowercased text: inside "@Alice", so Alice's name carried Al's key.
  it("stand on the whole @name, not on the start of a longer one", () => {
    expect(mentionsFor("@Alice @Al", ["Al"], crew)).toEqual([{ k: AL, o: 7, l: 3 }]);
    expect(mentionsFor("@Alice, @Al, hi", ["Al"], crew)).toEqual([{ k: AL, o: 8, l: 3 }]);
    expect(mentionsFor("@Al_2 @Al", ["Al"], crew)).toEqual([{ k: AL, o: 6, l: 3 }]);
    // A combining accent is part of the name it follows ("@Ál" is another name).
    expect(mentionsFor("@Al\u0301 @Al", ["Al"], crew)).toEqual([{ k: AL, o: 5, l: 3 }]);
    expect(mentionsFor("@Allan @all", ["everyone"], crew)).toEqual([{ k: "*", o: 7, l: 4 }]);
    expect(mentionsFor("@Alice @Al @Allan", ["Alice", "Al", "Allan"], crew)).toEqual([
      { k: ALICE, o: 0, l: 6 }, { k: AL, o: 7, l: 3 }, { k: ALLAN, o: 11, l: 6 },
    ]);
  });

  it("a name followed by punctuation or the end of the text is whole", () => {
    expect(mentionsFor("@Al, look", ["Al"], crew)).toEqual([{ k: AL, o: 0, l: 3 }]);
    expect(mentionsFor("thanks @AL!", ["Al"], crew)).toEqual([{ k: AL, o: 7, l: 3 }]);
    expect(mentionsFor("ping @Al", ["Al"], crew)).toEqual([{ k: AL, o: 5, l: 3 }]);
    // A name's own punctuation is matched as written, not as a pattern.
    expect(mentionsFor("@JxR. @J.R.", ["J.R."], crew)).toEqual([{ k: JR, o: 6, l: 5 }]);
  });

  // The place was found in text.toLowerCase() and used in the text: "İ" lowercases to two UTF-16 units, so every
  // mention after it was one character late ("@Al" marked as "Al ").
  it("the place is counted in the text as written", () => {
    expect(mentionsFor("İstanbul @Al", ["Al"], crew)).toEqual([{ k: AL, o: 9, l: 3 }]);
    expect(mentionsFor("İİ @everyone", ["everyone"], crew)).toEqual([{ k: "*", o: 3, l: 9 }]);
  });

  // A member's key written whole is covered whole, not only its first 8 characters.
  it("a key written whole is the mention", () => {
    expect(mentionsFor(`@${AL} hi`, ["Al"], crew)).toEqual([{ k: AL, o: 0, l: 11 }]);
    expect(mentionsFor(`@${AL.slice(0, 8)} hi`, ["Al"], crew)).toEqual([{ k: AL, o: 0, l: 9 }]);
  });

  // No whole @name anywhere: the first place it starts a longer word, as before (a send that went still goes).
  it("with no whole @name, the start of a longer one is still taken", () => {
    expect(mentionsFor("ping @Alice", ["Al"], crew)).toEqual([{ k: AL, o: 5, l: 3 }]);
    expect(mentionsFor("@Allan hi", ["everyone"], crew)).toEqual([{ k: "*", o: 0, l: 4 }]);
    expect(() => mentionsFor("ping Al", ["Al"], crew)).toThrow(expect.objectContaining({ code: "bad_request", message: "Write @Al in the text to mention Al" }));
  });

  // More than the 16 a message carries went to the engine, which dropped the list whole: the message mentioned no one.
  it("more members than a message mentions are refused before any is looked up, a ref given twice counts once", async () => {
    const members = Array.from({ length: 20 }, (_, i) => ({ key: `key${i}`.padEnd(10, "x"), role: "member", me: false, online: true, missing: 0, nick: `M${i}` }));
    const big = { ...crew, members: [crew.members[0], ...members] } as unknown as GroupView;
    const text = members.map((m) => `@${m.nick}`).join(" ");
    const names = members.map((m) => m.nick);
    expect(mentionsFor(text, names.slice(0, 16), big)).toHaveLength(16);
    expect(() => mentionsFor(text, names.slice(0, 17), big)).toThrow(expect.objectContaining({ code: "bad_request", message: "A message mentions at most 16 members (17 given): send it to fewer, or mention everyone" }));
    const lookups = vi.spyOn(big.members, "filter");
    expect(() => mentionsFor(text, Array.from({ length: 50_000 }, (_, i) => `M${i % 20}x${i}`), big)).toThrow(expect.objectContaining({ code: "bad_request" }));
    expect(lookups).not.toHaveBeenCalled();
    expect(mentionsFor("@Al hi", Array(50_000).fill("Al"), crew)).toEqual([{ k: AL, o: 0, l: 3 }]);
    const { ctx, node } = fake();
    await expect(callApi(ctx, "group.send", { group: "Crew", text: "@Al hi", mentions: Array.from({ length: 17 }, (_, i) => `x${i}`) })).rejects.toMatchObject({ code: "bad_request" });
    expect(node.sendGroupMessage).not.toHaveBeenCalled();
  });

  it("group send hands the engine the mention on the whole @name", async () => {
    const { ctx, node } = fake();
    await callApi(ctx, "group.send", { group: "Crew", text: "@Alice @Al ping", mentions: ["Al"] });
    expect(node.sendGroupMessage).toHaveBeenCalledWith({ groupId: "g1", text: "@Alice @Al ping", mentions: [{ k: AL, o: 7, l: 3 }] });
  });
});
