// covers: apps.chess
import { describe, expect, it } from "vitest";
import type { Square } from "chess.js";
import { ChessController, type Notice, type SavedGame } from "../src/game.ts";
import { encodeMessage, MAX_MESSAGE_BYTES } from "../src/protocol.ts";
import { commitment, newSalt } from "../src/toss.ts";
import { chatPair, MockBroker } from "./mockBroker.ts";

/** A side of the chat: its broker, its app, and what the app reported. */
interface Side {
  broker: MockBroker;
  game: ChessController;
  notices: Notice[];
}

async function open(broker: MockBroker): Promise<Side> {
  broker.launch();
  const game = new ChessController(broker);
  const notices: Notice[] = [];
  game.onNotice((n) => notices.push(n));
  await game.start();
  return { broker, game, notices };
}

/** Until no frame is on its way and both apps handled what they got. */
async function settle(...sides: Side[]): Promise<void> {
  for (let idle = 0; idle < 3; ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.all(sides.map((s) => s.game.settled()));
    idle = sides.every((s) => s.broker.inFlight === 0) ? idle + 1 : 0;
  }
}

async function start(): Promise<{ ana: Side; bob: Side; white: Side; black: Side }> {
  const [a, b] = chatPair();
  const ana = await open(a);
  const bob = await open(b);
  await settle(ana, bob);
  const white = ana.game.view().me === "w" ? ana : bob;
  const black = white === ana ? bob : ana;
  return { ana, bob, white, black };
}

/** Plays a UCI ply by the side to move, through its app, and lets it arrive. */
async function play(sides: { white: Side; black: Side }, ...plies: string[]): Promise<void> {
  for (const uci of plies) {
    const mover = sides.white.game.view().turn === "w" ? sides.white : sides.black;
    const ok = await mover.game.move(uci.slice(0, 2) as Square, uci.slice(2, 4) as Square, uci[4] as "q" | undefined);
    expect(ok, `${uci} by ${mover.broker.name}`).toBe(true);
    await settle(sides.white, sides.black);
  }
}

const saved = (side: Side) => JSON.parse(side.broker.stored.get("game")!) as SavedGame;
const SCHOLARS_MATE = ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7"];

describe("the colour toss", () => {
  it("gives the two sides one game and opposite colours", async () => {
    const { ana, bob } = await start();
    const a = ana.game.view();
    const b = bob.game.view();
    expect(a.phase).toBe("playing");
    expect(b.phase).toBe("playing");
    expect(new Set([a.me, b.me])).toEqual(new Set(["w", "b"]));
    expect(saved(ana).g).toBe(saved(bob).g);
    expect(saved(ana).s).toEqual([saved(bob).s[1], saved(bob).s[0]]);
    expect(ana.notices).toEqual([]);
    expect(bob.notices).toEqual([]);
  });

  it("decides colours from both salts, so either colour comes up", async () => {
    const colours = new Set<string>();
    for (let i = 0; i < 12 && colours.size < 2; i++) colours.add((await start()).ana.game.view().me!);
    expect(colours).toEqual(new Set(["w", "b"]));
  });

  it("refuses a reveal that does not match the commitment", async () => {
    const [a, b] = chatPair();
    const ana = await open(a);
    b.launch(); // Bob's side is a script here, not the app
    const bobSalt = newSalt();
    a.inject(encodeMessage({ k: "seek", c: commitment(bobSalt), a: [] }));
    await settle(ana);
    const anaSeek = a.sent.find((m) => (m as { k?: string }).k === "seek") as { c: string };
    a.inject(encodeMessage({ k: "reveal", s: newSalt(), c: anaSeek.c }));
    await settle(ana);
    expect(ana.notices).toContain("bad-reveal");
    expect(ana.game.view().phase).toBe("toss");
  });

  it("does not let a peer skip the toss with a made-up game", async () => {
    const [a, b] = chatPair();
    const ana = await open(a);
    b.launch();
    // A game from two salts Ana never saw, in which the forger's side happens to be white.
    let forged: { g: string; s: [string, string] } | undefined;
    const { deal } = await import("../src/toss.ts");
    while (!forged) {
      const mine = newSalt();
      const fake = newSalt();
      const d = deal(mine, fake);
      if (d.me === "w") forged = { g: d.g, s: [mine, fake] };
    }
    a.inject(encodeMessage({ k: "sync", g: forged.g, s: forged.s, m: ["e2e4"] }));
    await settle(ana);
    expect(ana.game.view().phase).toBe("out-of-step");
    expect(ana.game.view().plies).toBe(0);
    expect(a.stored.has("game")).toBe(false);
  });
});

describe("a game over the mock broker", () => {
  it("plays Scholar's mate, and both boards show mate", async () => {
    const sides = await start();
    await play(sides, ...SCHOLARS_MATE);
    for (const side of [sides.white, sides.black]) {
      const view = side.game.view();
      expect(view.phase).toBe("over");
      expect(view.end).toEqual({ result: "1-0", why: "checkmate" });
      expect(view.plies).toBe(7);
      expect(view.canMove).toBe(false);
      expect(side.notices).toEqual([]);
    }
    expect(sides.white.game.view().fen).toBe(sides.black.game.view().fen);
    expect(saved(sides.white).m).toEqual(SCHOLARS_MATE);
    expect(saved(sides.black).m).toEqual(SCHOLARS_MATE);
  });

  it("keeps every message well under the frame cap", async () => {
    const sides = await start();
    await play(sides, ...SCHOLARS_MATE);
    for (const value of [...sides.ana.broker.sent, ...sides.bob.broker.sent]) {
      expect(new TextEncoder().encode(JSON.stringify(value)).length).toBeLessThan(MAX_MESSAGE_BYTES);
    }
  });

  it("does not move while the contact has Chess closed (live play only)", async () => {
    const sides = await start();
    sides.black.game.stop();
    sides.black.broker.shutdown();
    await settle(sides.white);
    expect(sides.white.game.view().peerOpen).toBe(false);
    expect(sides.white.game.view().canMove).toBe(false);
    expect(await sides.white.game.move("e2", "e4")).toBe(false);
  });

  it("resumes after a reload mid-game, from storage and the catch-up", async () => {
    const sides = await start();
    await play(sides, "e2e4", "e7e5", "f1c4");
    // Black reloads: its app goes, then comes back on the same storage.
    sides.black.game.stop();
    sides.black.broker.shutdown();
    await settle(sides.white);
    const black = await open(sides.black.broker);
    await settle(sides.white, black);
    const view = black.game.view();
    expect(view.phase).toBe("playing");
    expect(view.me).toBe("b");
    expect(view.plies).toBe(3);
    expect(view.fen).toBe(sides.white.game.view().fen);
    expect(view.canMove).toBe(true);
    await play({ white: sides.white, black }, "b8c6", "d1h5", "g8f6", "h5f7");
    expect(black.game.view().end).toEqual({ result: "1-0", why: "checkmate" });
    expect(sides.white.game.view().end).toEqual({ result: "1-0", why: "checkmate" });
    expect([...sides.white.notices, ...black.notices]).toEqual([]);
  });

  it("catches up a move that was lost when the contact's app closed", async () => {
    const sides = await start();
    await play(sides, "e2e4", "e7e5");
    // White moves, and Black's app closes before the frame arrives.
    await sides.white.game.move("f1", "c4");
    sides.black.game.stop();
    sides.black.broker.shutdown();
    await settle(sides.white);
    expect(saved(sides.black).m).toEqual(["e2e4", "e7e5"]);
    const black = await open(sides.black.broker);
    await settle(sides.white, black);
    expect(black.game.view().plies).toBe(3);
    expect(saved(black).m).toEqual(["e2e4", "e7e5", "f1c4"]);
    expect(black.game.view().canMove).toBe(true);
  });

  it("finishes the toss when one side reloads in the middle of it", async () => {
    const [a, b] = chatPair();
    const ana = await open(a);
    b.launch();
    const bob1 = new ChessController(b);
    await bob1.start();
    // Bob's app goes before the toss finishes; its salt is in storage, so the toss can end with the same colours.
    bob1.stop();
    b.shutdown();
    await settle(ana);
    const bob = await open(b);
    await settle(ana, bob);
    expect(ana.game.view().phase).toBe("playing");
    expect(bob.game.view().phase).toBe("playing");
    expect(new Set([ana.game.view().me, bob.game.view().me])).toEqual(new Set(["w", "b"]));
    expect(saved(ana).g).toBe(saved(bob).g);
  });
});

describe("a hostile or broken peer", () => {
  it("ignores and reports a move out of turn, illegal moves, a wrong ply number and a wrong promotion", async () => {
    const sides = await start();
    await play(sides, "e2e4");
    const { black, white } = sides;
    const g = saved(black).g;
    // Black is to move, so any move from White's side now is out of turn.
    black.broker.inject(encodeMessage({ k: "move", g, n: 1, m: "d2d4" }));
    await settle(black, white);
    expect(black.notices).toEqual(["invalid-move"]);
    expect(saved(black).m).toEqual(["e2e4"]);
    await play(sides, "e7e5");
    const position = black.game.view().fen;
    for (const m of ["e4e5", "g1g4", "e1e3"]) black.broker.inject(encodeMessage({ k: "move", g, n: 2, m })); // illegal
    black.broker.inject(encodeMessage({ k: "move", g, n: 4, m: "d2d4" })); // a ply that is not next
    black.broker.inject(encodeMessage({ k: "move", g, n: 2, m: "g1f3q" })); // a legal move with a promotion it does not have
    await settle(black, white);
    expect(black.notices.filter((n) => n === "invalid-move")).toHaveLength(6);
    expect(black.game.view().fen).toBe(position);
    expect(saved(black).m).toEqual(["e2e4", "e7e5"]);
    // The game goes on as if nothing came.
    await play(sides, "f1c4", "b8c6", "d1h5", "g8f6", "h5f7");
    expect(black.game.view().end?.why).toBe("checkmate");
    expect(white.notices).toEqual([]);
  });

  it("ignores and reports malformed messages", async () => {
    const sides = await start();
    await play(sides, "e2e4");
    const { black } = sides;
    const g = saved(black).g;
    const before = JSON.stringify(saved(black));
    const junk: unknown[] = [
      null,
      42,
      "e7e5",
      [],
      {},
      { p: "checkers", v: 1, k: "move", g, n: 1, m: "e7e5" },
      { p: "chess", v: "1", k: "move", g, n: 1, m: "e7e5" },
      { p: "chess", v: 1, k: "castle" },
      { p: "chess", v: 1, k: "move", g: "not-a-game-id!!!", n: 1, m: "e7e5" },
      { p: "chess", v: 1, k: "move", g, n: -1, m: "e7e5" },
      { p: "chess", v: 1, k: "move", g, n: 1.5, m: "e7e5" },
      { p: "chess", v: 1, k: "move", g, n: 1, m: "Nf3" },
      { p: "chess", v: 1, k: "move", g, n: 1, m: { from: "e7", to: "e5" } },
      { p: "chess", v: 1, k: "sync", g, s: ["x", "y"], m: "" },
      { p: "chess", v: 1, k: "sync", g, s: [newSalt(), newSalt()], m: "e2e4  e7e5" },
      { p: "chess", v: 1, k: "sync", g, s: [newSalt(), newSalt()], m: "", x: { why: "timeout" } },
      { p: "chess", v: 1, k: "seek", c: "abc", a: [] },
      { p: "chess", v: 1, k: "seek", c: commitment(newSalt()), a: [g, g, g] },
      { p: "chess", v: 1, k: "draw", g, o: "maybe" },
      { p: "chess", v: 1, k: "resign" },
    ];
    for (const value of junk) black.broker.inject(value);
    await settle(sides.white, black);
    expect(black.notices.filter((n) => n === "bad-message")).toHaveLength(junk.length);
    expect(JSON.stringify(saved(black))).toBe(before);
    expect(black.game.view().phase).toBe("playing");
  });

  it("says when the contact has a newer Chess", async () => {
    const sides = await start();
    sides.black.broker.inject({ p: "chess", v: 2, k: "move", g: saved(sides.black).g, n: 0, m: "e2e4" });
    await settle(sides.black);
    expect(sides.black.notices).toEqual(["newer-version"]);
  });

  it("ignores and reports an oversized message before reading it", async () => {
    const sides = await start();
    await play(sides, "e2e4");
    const { black } = sides;
    const g = saved(black).g;
    const huge = { p: "chess", v: 1, k: "sync", g, s: saved(black).s, m: Array.from({ length: 4000 }, () => "e2e4").join(" ") };
    expect(new TextEncoder().encode(JSON.stringify(huge)).length).toBeGreaterThan(MAX_MESSAGE_BYTES);
    black.broker.inject(huge);
    black.broker.inject({ p: "chess", v: 1, k: "move", g, n: 1, m: "e7e5", pad: "x".repeat(MAX_MESSAGE_BYTES) });
    await settle(black);
    expect(black.notices).toEqual(["too-big", "too-big"]);
    expect(saved(black).m).toEqual(["e2e4"]);
  });

  it("does not take a resignation for this side, or an accepted draw it never offered", async () => {
    const sides = await start();
    await play(sides, "e2e4");
    const { black } = sides;
    const s = saved(black);
    black.broker.inject(encodeMessage({ k: "sync", g: s.g, s: [s.s[1], s.s[0]], m: s.m, x: { why: "resign", by: "b" } }));
    black.broker.inject(encodeMessage({ k: "sync", g: s.g, s: [s.s[1], s.s[0]], m: s.m, x: { why: "agreed" } }));
    black.broker.inject(encodeMessage({ k: "draw", g: s.g, o: "accept" }));
    await settle(black);
    expect(black.notices).toEqual(["bad-message", "bad-message", "bad-message"]);
    expect(black.game.view().end).toBeUndefined();
  });
});

describe("ending a game", () => {
  it("resigns, and both sides see who won", async () => {
    const sides = await start();
    await play(sides, "e2e4");
    await sides.black.game.resign();
    await settle(sides.white, sides.black);
    for (const side of [sides.white, sides.black]) expect(side.game.view().end).toEqual({ result: "1-0", why: "resign" });
    expect(await sides.white.game.move("d2", "d4")).toBe(false);
  });

  it("draws by agreement, and a declined offer lapses", async () => {
    const sides = await start();
    await play(sides, "e2e4");
    await sides.black.game.offerDraw();
    await settle(sides.white, sides.black);
    expect(sides.white.game.view().drawOffer).toBe("peer");
    await sides.white.game.answerDraw(false);
    await settle(sides.white, sides.black);
    expect(sides.black.game.view().drawOffer).toBeUndefined();
    await sides.white.game.offerDraw();
    await settle(sides.white, sides.black);
    await sides.black.game.answerDraw(true);
    await settle(sides.white, sides.black);
    for (const side of [sides.white, sides.black]) expect(side.game.view().end).toEqual({ result: "1/2-1/2", why: "agreed" });
  });

  it("draws by threefold repetition", async () => {
    const sides = await start();
    await play(sides, "g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8");
    for (const side of [sides.white, sides.black]) expect(side.game.view().end).toEqual({ result: "1/2-1/2", why: "repetition" });
  });

  it("starts a new game after one ends, with a new toss", async () => {
    const sides = await start();
    const first = saved(sides.white).g;
    await play(sides, ...SCHOLARS_MATE);
    await sides.black.game.newGame();
    await settle(sides.white, sides.black);
    for (const side of [sides.white, sides.black]) {
      expect(side.game.view().phase).toBe("playing");
      expect(side.game.view().plies).toBe(0);
    }
    expect(saved(sides.white).g).not.toBe(first);
    expect(saved(sides.white).g).toBe(saved(sides.black).g);
  });
});

describe("alone", () => {
  it("plays both sides on one device and keeps the game", async () => {
    const broker = new MockBroker("solo", "1.0.0", false);
    broker.isOpen = true;
    const game = new ChessController(broker);
    await game.start();
    expect(game.view().phase).toBe("alone");
    for (const uci of SCHOLARS_MATE) expect(await game.move(uci.slice(0, 2) as Square, uci.slice(2, 4) as Square)).toBe(true);
    expect(game.view().end).toEqual({ result: "1-0", why: "checkmate" });
    const again = new ChessController(broker);
    await again.start();
    expect(again.view().plies).toBe(7);
    expect(broker.sent).toEqual([]);
  });
});
