// covers: apps.chess
import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { boardEnding, replay } from "../src/game.ts";
import { encodeMessage, jsonBytes, MAX_MESSAGE_BYTES, MAX_PLIES, parseMessage, type Message } from "../src/protocol.ts";
import { commitment, deal, newSalt } from "../src/toss.ts";
import { en, LANGUAGES, pickLanguage, stringsFor } from "../src/strings.ts";

const g = "0123456789abcdef";

describe("the message protocol", () => {
  it("reads back every kind of message it writes", () => {
    const messages: Message[] = [
      { k: "seek", c: commitment(newSalt()), a: [g] },
      { k: "reveal", s: newSalt(), c: commitment(newSalt()) },
      { k: "move", g, n: 0, m: "e2e4" },
      { k: "move", g, n: 41, m: "a7a8n" },
      { k: "sync", g, s: [newSalt(), newSalt()], m: ["e2e4", "e7e5"], x: { why: "resign", by: "w" } },
      { k: "sync", g, s: [newSalt(), newSalt()], m: [] },
      { k: "resign", g },
      { k: "draw", g, o: "offer" },
    ];
    for (const message of messages) {
      const wire = encodeMessage(message);
      expect(wire).toMatchObject({ p: "chess", v: 1, k: message.k });
      expect(parseMessage(JSON.parse(JSON.stringify(wire)))).toEqual({ ok: true, message });
    }
  });

  it("fits the longest game in one sync, well under the 32 KiB frame cap", () => {
    const longest: Message = { k: "sync", g, s: [newSalt(), newSalt()], m: Array.from({ length: MAX_PLIES }, () => "e7e8q"), x: { why: "agreed" } };
    const bytes = jsonBytes(encodeMessage(longest));
    expect(bytes).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(MAX_MESSAGE_BYTES).toBeLessThanOrEqual(32 * 1024 / 2);
  });

  it("refuses to write a message over the cap", () => {
    const tooLong: Message = { k: "sync", g, s: [newSalt(), newSalt()], m: Array.from({ length: 4000 }, () => "e7e8q") };
    expect(() => encodeMessage(tooLong)).toThrow(/over/);
  });

  it("refuses more plies than a game may have, and values JSON cannot carry", () => {
    const m = Array.from({ length: MAX_PLIES + 1 }, () => "e2e4").join(" ");
    expect(parseMessage({ p: "chess", v: 1, k: "sync", g, s: [newSalt(), newSalt()], m })).toEqual({ ok: false, reason: "malformed" });
    expect(parseMessage({ p: "chess", v: 1, k: "move", g, n: MAX_PLIES, m: "e2e4" })).toEqual({ ok: false, reason: "malformed" });
    expect(parseMessage(undefined)).toEqual({ ok: false, reason: "too-big" });
    expect(parseMessage({ toJSON: () => { throw new Error("no"); } })).toEqual({ ok: false, reason: "too-big" });
  });
});

describe("the colour toss", () => {
  it("gives both sides the same game id and opposite colours", () => {
    for (let i = 0; i < 20; i++) {
      const a = newSalt();
      const b = newSalt();
      const fromA = deal(a, b);
      const fromB = deal(b, a);
      expect(fromA.g).toBe(fromB.g);
      expect(fromA.g).toMatch(/^[0-9a-f]{16}$/);
      expect(fromA.me).not.toBe(fromB.me);
    }
  });

  it("refuses equal salts", () => {
    const salt = newSalt();
    expect(() => deal(salt, salt)).toThrow();
  });

  it("commits to a salt without showing it", () => {
    const salt = newSalt();
    expect(commitment(salt)).toMatch(/^[0-9a-f]{64}$/);
    expect(commitment(salt)).not.toContain(salt.slice(0, 16));
    expect(commitment(salt)).toBe(commitment(salt));
  });
});

describe("the rules", () => {
  const at = (fen: string) => new Chess(fen);
  it("knows mate, stalemate, bare kings and the 50-move rule", () => {
    expect(boardEnding(replay(["f2f3", "e7e5", "g2g4", "d8h4"])!, 4)).toEqual({ result: "0-1", why: "checkmate" });
    expect(boardEnding(at("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1"), 1)).toEqual({ result: "1/2-1/2", why: "stalemate" });
    expect(boardEnding(at("8/8/4k3/8/8/4K3/8/8 w - - 0 1"), 1)).toEqual({ result: "1/2-1/2", why: "material" });
    expect(boardEnding(at("8/8/4k3/8/8/4K3/8/R7 w - - 100 90"), 1)).toEqual({ result: "1/2-1/2", why: "fifty" });
    expect(boardEnding(new Chess(), MAX_PLIES)).toEqual({ result: "1/2-1/2", why: "limit" });
    expect(boardEnding(new Chess(), 0)).toBeUndefined();
  });

  it("replays only legal plies, with the promotion exactly when there is one", () => {
    expect(replay(["e2e4", "e7e5"])?.history()).toHaveLength(2);
    expect(replay(["e2e5"])).toBeNull();
    expect(replay(["e2e4q"])).toBeNull();
    const promote = ["a2a4", "b7b5", "a4b5", "a7a6", "b5a6", "c8b7", "a6b7", "b8c6"];
    expect(replay([...promote, "b7a8"])).toBeNull();
    expect(replay([...promote, "b7a8n"])?.history().at(-1)).toBe("bxa8=N");
  });
});

describe("strings", () => {
  it("picks one of the 8 app languages from a locale, English otherwise", () => {
    expect(pickLanguage("pt-BR")).toBe("pt");
    expect(pickLanguage("zh_Hant")).toBe("zh");
    expect(pickLanguage("de-DE")).toBe("en");
    expect(pickLanguage(undefined)).toBe("en");
    expect(stringsFor("de" as never).newGame).toBe("New game");
  });

  it("has every word in each of the 8 languages, not English in their place", () => {
    for (const language of LANGUAGES) {
      const words = stringsFor(language);
      for (const key of Object.keys(en) as (keyof typeof en)[]) expect(words[key].trim(), `${language}.${key}`).not.toBe("");
      if (language === "en") continue;
      // Only the square names, which are the same everywhere, may match English.
      const same = (Object.keys(en) as (keyof typeof en)[]).filter((key) => words[key] === en[key]);
      expect(same, language).toEqual([]);
    }
    expect(stringsFor("pt").yourMove).toBe("Sua vez");
    expect(stringsFor("ar").newGame).toBe("لعبة جديدة");
  });
});
