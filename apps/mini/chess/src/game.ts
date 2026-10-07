/**
 * The game, over the broker: state, rules and the message protocol (protocol.ts), with no DOM, so the tests drive it
 * with a mock broker.
 *
 * Play is live only: a move needs the peer's app open. The game is saved in the app's storage (per chat) after every
 * change, and both sides send a `sync` whenever the other side opens the app, so a reload or a reconnect resumes it.
 *
 * Every move from the peer is checked: right game, right ply number, the peer's turn, legal in the position. A move
 * that fails is ignored and reported (a notice), and this side answers with its own `sync` (at most once a second) so
 * an honest peer that fell out of step can catch up.
 *
 * A `sync` is taken only as far as it is provable: the same game (its id comes from both salts, and the salts must
 * include this side's own), a history that is ours plus at most one legal ply of the sender's, and a non-board end
 * the sender may claim (its own resignation, or a draw this side offered). Anything else is shown as "out of step",
 * and New game starts a fresh toss that gives up both games.
 */
import { Chess, type Square } from "chess.js";
import type { MiniAppApi, MiniAppJson, MiniAppPeerEvent } from "@ghostly/core/miniApp";
import { encodeMessage, MAX_PLIES, parseMessage, UCI, type Colour, type DrawOption, type GameEnd, type Message } from "./protocol.ts";
import { commitment, cryptoRandom, deal, newSalt, type Random } from "./toss.ts";

/** The game in a chat, as storage keeps it under "game". */

/**
 * A value as the broker takes it: strict JSON, made by a round trip through JSON. The broker refuses a value with an
 * `undefined` member (a JSON value has none), and a game record spread with `d: undefined` has one: its save and its
 * move were refused, so a move was never sent nor kept. JSON drops such a member, as it does here.
 */
function plain(value: unknown): MiniAppJson {
  return JSON.parse(JSON.stringify(value)) as MiniAppJson;
}

export interface SavedGame {
  v: 1;
  /** Game id, from both salts. */
  g: string;
  /** This side's colour. */
  me: Colour;
  /** [this side's salt, the peer's salt]. */
  s: [string, string];
  /** Every ply, UCI. */
  m: string[];
  /** How the game ended other than on the board. */
  x?: GameEnd;
  /** A draw offer that stands: made by this side ("me") or the peer. */
  d?: "me" | "peer";
}

/** A toss in progress, as storage keeps it under "flip": the salt survives a reload, so the toss can finish. */
export interface SavedFlip {
  v: 1;
  salt: string;
  /** The peer's commitment this salt was revealed against. */
  peer?: string;
  /** Game ids this toss gives up. */
  a: string[];
}

/** A game played alone on one device (both colours), under "local". */
export interface SavedLocal {
  v: 1;
  m: string[];
}

export type EndReason = "checkmate" | "stalemate" | "repetition" | "fifty" | "material" | "limit" | "resign" | "agreed";
export interface Ending {
  result: "1-0" | "0-1" | "1/2-1/2";
  why: EndReason;
}

export type Phase = "loading" | "alone" | "toss" | "playing" | "over" | "out-of-step";

export type Notice =
  | "invalid-move"
  | "bad-message"
  | "too-big"
  | "newer-version"
  | "bad-reveal"
  | "toss-restarted"
  | "out-of-step"
  | "peer-new-game"
  | "send-failed";

export interface View {
  phase: Phase;
  /** This side's colour in a chat game; undefined alone or before the toss. */
  me?: Colour;
  peerOpen: boolean;
  fen: string;
  turn: Colour;
  plies: number;
  lastMove?: { from: Square; to: Square };
  inCheck: boolean;
  end?: Ending;
  drawOffer?: "me" | "peer";
  /** This side may move now. */
  canMove: boolean;
}

export interface ControllerOptions {
  random?: Random;
  now?: () => number;
}

const KEY_GAME = "game";
const KEY_FLIP = "flip";
const KEY_LOCAL = "local";
const RESYNC_GAP_MS = 1000;

const other = (c: Colour): Colour => (c === "w" ? "b" : "w");

/** Plays one UCI ply on `chess`, or throws. The promotion piece must be given exactly when the move promotes. */
export function playUci(chess: Chess, uci: string): void {
  if (!UCI.test(uci)) throw new Error(`not a move: ${uci}`);
  const promotion = uci.length === 5 ? uci[4] : undefined;
  const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion });
  if ((move.promotion ?? undefined) !== promotion) {
    chess.undo();
    throw new Error(`promotion piece wrong in ${uci}`);
  }
}

/** A position from a list of plies, or null when one is illegal. */
export function replay(moves: string[]): Chess | null {
  const chess = new Chess();
  try {
    for (const m of moves) playUci(chess, m);
  } catch {
    return null;
  }
  return chess;
}

/** How the board ended the game, if it did. */
export function boardEnding(chess: Chess, plies: number): Ending | undefined {
  if (chess.isCheckmate()) return { result: chess.turn() === "w" ? "0-1" : "1-0", why: "checkmate" };
  if (chess.isStalemate()) return { result: "1/2-1/2", why: "stalemate" };
  if (chess.isInsufficientMaterial()) return { result: "1/2-1/2", why: "material" };
  // Draws by repetition and by the 50-move rule end the game at once, without a claim: simpler for a chat game.
  if (chess.isThreefoldRepetition()) return { result: "1/2-1/2", why: "repetition" };
  if (chess.isDrawByFiftyMoves()) return { result: "1/2-1/2", why: "fifty" };
  if (plies >= MAX_PLIES) return { result: "1/2-1/2", why: "limit" };
  return undefined;
}

function endingOf(chess: Chess, plies: number, x: GameEnd | undefined): Ending | undefined {
  if (x?.why === "resign") return { result: x.by === "w" ? "0-1" : "1-0", why: "resign" };
  if (x?.why === "agreed") return { result: "1/2-1/2", why: "agreed" };
  return boardEnding(chess, plies);
}

const isPrefix = (a: string[], b: string[]) => a.length <= b.length && a.every((m, i) => b[i] === m);

export class ChessController {
  private readonly api: MiniAppApi;
  private readonly random: Random;
  private readonly now: () => number;
  private inChat = false;
  private peerOpen = false;
  private phaseLoaded = false;
  private game: SavedGame | null = null;
  private flip: SavedFlip | null = null;
  private local: SavedLocal | null = null;
  /** The peer's game id when the two sides hold different games. */
  private stepPeerGame: string | null = null;
  private chess = new Chess();
  private queue: Promise<void> = Promise.resolve();
  private lastResync = -Infinity;
  private readonly listeners = new Set<() => void>();
  private readonly noticeListeners = new Set<(notice: Notice) => void>();
  private readonly unsubscribe: (() => void)[] = [];

  constructor(api: MiniAppApi, options: ControllerOptions = {}) {
    this.api = api;
    this.random = options.random ?? cryptoRandom;
    this.now = options.now ?? (() => Date.now());
  }

  // ---------- life ----------

  /** Reads the context and the saved game, listens to the peer, and says hello if the peer is open. */
  async start(): Promise<void> {
    const context = await this.api.context();
    this.inChat = context.inChat;
    this.peerOpen = context.peer !== null;
    if (this.inChat) {
      this.game = this.readGame(await this.api.storage.get(KEY_GAME));
      this.flip = this.readFlip(await this.api.storage.get(KEY_FLIP));
      const chess = this.game && replay(this.game.m);
      if (!chess) this.game = null;
      this.chess = chess ?? new Chess();
      this.unsubscribe.push(this.api.chat.on("message", (data) => this.enqueue(() => this.receive(data))));
      this.unsubscribe.push(this.api.chat.on("peer", (peer) => this.enqueue(() => this.peerChanged(peer))));
    } else {
      const moves = this.readMoves(await this.api.storage.get(KEY_LOCAL));
      const chess = replay(moves);
      this.chess = chess ?? new Chess();
      this.local = { v: 1, m: chess ? moves : [] };
    }
    this.phaseLoaded = true;
    if (this.inChat && this.peerOpen) await this.enqueue(() => this.hello());
    this.changed();
  }

  /** Stops listening. */
  stop(): void {
    for (const off of this.unsubscribe.splice(0)) off();
  }

  /** Waits for every message received so far to be handled (for tests and for the UI after an action). */
  settled(): Promise<void> {
    return this.queue;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onNotice(listener: (notice: Notice) => void): () => void {
    this.noticeListeners.add(listener);
    return () => this.noticeListeners.delete(listener);
  }

  // ---------- what the UI reads ----------

  view(): View {
    const history = this.chess.history({ verbose: true });
    const last = history[history.length - 1];
    const plies = history.length;
    const end = this.inChat ? (this.game ? endingOf(this.chess, plies, this.game.x) : undefined) : boardEnding(this.chess, plies);
    let phase: Phase;
    if (!this.phaseLoaded) phase = "loading";
    else if (!this.inChat) phase = "alone";
    else if (this.stepPeerGame) phase = "out-of-step";
    else if (!this.game || this.flip) phase = "toss";
    else phase = end ? "over" : "playing";
    const me = this.inChat ? this.game?.me : undefined;
    const turn = this.chess.turn();
    const canMove = !end && (phase === "alone" || (phase === "playing" && this.peerOpen && me === turn));
    return {
      phase,
      me,
      peerOpen: this.peerOpen,
      fen: this.chess.fen(),
      turn,
      plies,
      lastMove: last ? { from: last.from, to: last.to } : undefined,
      inCheck: this.chess.inCheck(),
      end,
      drawOffer: this.inChat && !end ? this.game?.d : undefined,
      canMove,
    };
  }

  /** The board as chess.js gives it, rank 8 first. */
  board(): ReturnType<Chess["board"]> {
    return this.chess.board();
  }

  /** Where the piece on `square` may go now, if this side may move it. */
  targets(square: Square): { to: Square; promotion: boolean }[] {
    if (!this.view().canMove) return [];
    const seen = new Map<Square, boolean>();
    for (const m of this.chess.moves({ square, verbose: true })) seen.set(m.to, seen.get(m.to) || Boolean(m.promotion));
    return [...seen].map(([to, promotion]) => ({ to, promotion }));
  }

  // ---------- this side's actions ----------

  /** Plays a move of this side's. False when it is not this side's turn or not legal. */
  move(from: Square, to: Square, promotion?: "q" | "r" | "b" | "n"): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.view().canMove) return false;
      const uci = `${from}${to}${promotion ?? ""}`;
      try {
        playUci(this.chess, uci);
      } catch {
        return false;
      }
      if (!this.inChat) {
        this.local = { v: 1, m: [...(this.local?.m ?? []), uci] };
        await this.api.storage.set(KEY_LOCAL, plain(this.local));
        this.changed();
        return true;
      }
      const game = this.game!;
      const n = game.m.length;
      this.game = { ...game, m: [...game.m, uci], d: undefined };
      await this.saveGame();
      this.changed();
      await this.send({ k: "move", g: game.g, n, m: uci });
      return true;
    });
  }

  /** Resigns the game in this chat. */
  resign(): Promise<void> {
    return this.enqueue(async () => {
      const view = this.view();
      if (view.phase !== "playing" || !this.game) return;
      this.game = { ...this.game, x: { why: "resign", by: this.game.me }, d: undefined };
      await this.saveGame();
      this.changed();
      await this.send({ k: "resign", g: this.game.g });
    });
  }

  /** Offers a draw, or accepts the peer's standing offer. */
  offerDraw(): Promise<void> {
    return this.enqueue(async () => {
      if (this.view().phase !== "playing" || !this.peerOpen || !this.game || this.game.d === "me") return;
      if (this.game.d === "peer") return this.answerDrawNow(true);
      this.game = { ...this.game, d: "me" };
      await this.saveGame();
      this.changed();
      await this.send({ k: "draw", g: this.game.g, o: "offer" });
    });
  }

  /** Accepts or declines the peer's draw offer. */
  answerDraw(accept: boolean): Promise<void> {
    return this.enqueue(() => this.answerDrawNow(accept));
  }

  /** Starts a new game: alone, at once; in a chat, a new toss that gives up the current game (and the peer's, when they differ). */
  newGame(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.inChat) {
        this.chess = new Chess();
        this.local = { v: 1, m: [] };
        await this.api.storage.set(KEY_LOCAL, plain(this.local));
        this.changed();
        return;
      }
      const view = this.view();
      if (view.phase === "playing") return; // resign first
      const give = [this.game?.g, this.stepPeerGame].filter((g): g is string => Boolean(g));
      await this.startToss(give);
    });
  }

  // ---------- protocol ----------

  /** What this side tells a peer that just opened: the toss it has going, or its game, or a new toss. */
  private async hello(): Promise<void> {
    if (this.flip) return this.send({ k: "seek", c: commitment(this.flip.salt), a: this.flip.a });
    if (this.game) return this.sendSync();
    await this.startToss([]);
  }

  private async peerChanged(peer: MiniAppPeerEvent): Promise<void> {
    this.peerOpen = peer.open;
    this.changed();
    if (peer.open) await this.hello();
  }

  private async receive(data: MiniAppJson): Promise<void> {
    const parsed = parseMessage(data);
    if (!parsed.ok) {
      this.notice(parsed.reason === "too-big" ? "too-big" : parsed.reason === "newer-version" ? "newer-version" : "bad-message");
      return;
    }
    const message = parsed.message;
    switch (message.k) {
      case "seek":
        return this.onSeek(message.c, message.a);
      case "reveal":
        return this.onReveal(message.s, message.c);
      case "move":
        return this.onMove(message.g, message.n, message.m);
      case "sync":
        return this.onSync(message.g, message.s, message.m, message.x);
      case "resign":
        return this.onResign(message.g);
      case "draw":
        return this.onDraw(message.g, message.o);
    }
  }

  private async onSeek(peerCommit: string, abandons: string[]): Promise<void> {
    const game = this.game;
    const over = game ? Boolean(endingOf(this.chess, game.m.length, game.x)) : true;
    // A game still on stays on unless the peer gives it up: the peer probably lost it, and our sync brings it back.
    if (game && !over && !this.flip && !abandons.includes(game.g)) return this.sendSync();
    if (this.flip && commitment(this.flip.salt) === peerCommit) return this.notice("bad-message");
    // A seek already answered, again (the peer reloaded, or both started at once): the reveal again, nothing new.
    if (this.flip && this.flip.peer === peerCommit) return this.send({ k: "reveal", s: this.flip.salt, c: peerCommit });
    if (!this.flip || this.flip.peer) {
      // No toss yet, or the peer tossed again after it saw our salt: a fresh salt, since a known one would let it choose.
      if (this.flip) this.notice("toss-restarted");
      else if (game && !over) this.notice("peer-new-game");
      const give = this.flip?.a ?? (game && !over ? [game.g] : []);
      this.flip = { v: 1, salt: newSalt(this.random), a: give, peer: peerCommit };
    } else {
      this.flip = { ...this.flip, peer: peerCommit };
    }
    await this.api.storage.set(KEY_FLIP, plain(this.flip));
    this.changed();
    // Our seek again before the reveal: the peer can check a reveal only against a commitment it has.
    await this.send({ k: "seek", c: commitment(this.flip.salt), a: this.flip.a });
    await this.send({ k: "reveal", s: this.flip.salt, c: peerCommit });
  }

  private async onReveal(peerSalt: string, answering: string): Promise<void> {
    // A reveal for an older toss of ours, or with no toss going: stale, nothing to do.
    if (!this.flip || answering !== commitment(this.flip.salt) || !this.flip.peer) return;
    if (commitment(peerSalt) !== this.flip.peer) return this.notice("bad-reveal");
    const { g, me } = deal(this.flip.salt, peerSalt);
    await this.begin({ v: 1, g, me, s: [this.flip.salt, peerSalt], m: [] });
  }

  private async onMove(g: string, n: number, uci: string): Promise<void> {
    if (!this.game || this.game.g !== g || this.flip) return this.resync();
    const game = this.game;
    if (n < game.m.length && game.m[n] === uci) return; // a repeat
    const end = endingOf(this.chess, game.m.length, game.x);
    if (end || n !== game.m.length || this.chess.turn() !== other(game.me)) {
      this.notice("invalid-move");
      return this.resync();
    }
    try {
      playUci(this.chess, uci);
    } catch {
      this.notice("invalid-move");
      return this.resync();
    }
    this.game = { ...game, m: [...game.m, uci], d: undefined };
    await this.saveGame();
    this.changed();
  }

  private async onSync(g: string, salts: [string, string], moves: string[], x: GameEnd | undefined): Promise<void> {
    const [theirSalt, mySalt] = salts;
    let dealt: { g: string; me: Colour };
    try {
      dealt = deal(mySalt, theirSalt);
    } catch {
      return this.notice("bad-message");
    }
    if (dealt.g !== g) return this.notice("bad-message");
    const same = this.game && this.game.g === g && this.game.s[0] === mySalt && this.game.s[1] === theirSalt;
    if (!same) {
      // Adopt only a game this side's own salt made: the toss it had going, so the colours are the ones it agreed to.
      if (this.flip && this.flip.salt === mySalt && this.flip.peer === commitment(theirSalt)) {
        await this.begin({ v: 1, g, me: dealt.me, s: [mySalt, theirSalt], m: [] });
        return this.onSync(g, salts, moves, x);
      }
      if (this.game && this.game.g === g) return this.notice("bad-message");
      this.stepPeerGame = g;
      this.notice("out-of-step");
      this.changed();
      return;
    }
    const game = this.game!;
    this.stepPeerGame = null;
    let next = game;
    if (moves.length > game.m.length) {
      // Ours plus one ply, the sender's: a move of theirs we missed. Anything longer is not provable.
      const extra = moves[game.m.length];
      const ok = moves.length === game.m.length + 1 && isPrefix(game.m, moves) && this.chess.turn() === other(game.me) && !endingOf(this.chess, game.m.length, game.x);
      const chess = ok ? replay(moves) : null;
      if (!chess) {
        this.stepPeerGame = g;
        this.notice("out-of-step");
        this.changed();
        return;
      }
      this.chess = chess;
      next = { ...next, m: [...game.m, extra], d: undefined };
    } else if (!isPrefix(moves, game.m)) {
      this.stepPeerGame = g;
      this.notice("out-of-step");
      this.changed();
      return;
    }
    if (x && !next.x) {
      const allowed = (x.why === "resign" && x.by === other(next.me)) || (x.why === "agreed" && next.d === "me");
      if (allowed) next = { ...next, x, d: undefined };
      else this.notice("bad-message");
    }
    if (next !== game) {
      this.game = next;
      await this.saveGame();
    }
    this.changed();
    // The peer is behind (fewer plies, or no end it should know): it catches up from ours.
    if (moves.length < next.m.length || (next.x && !x)) await this.sendSync();
  }

  private async onResign(g: string): Promise<void> {
    if (!this.game || this.game.g !== g || this.flip) return;
    if (endingOf(this.chess, this.game.m.length, this.game.x)) return;
    this.game = { ...this.game, x: { why: "resign", by: other(this.game.me) }, d: undefined };
    await this.saveGame();
    this.changed();
  }

  private async onDraw(g: string, option: DrawOption): Promise<void> {
    if (!this.game || this.game.g !== g || this.flip) return;
    if (endingOf(this.chess, this.game.m.length, this.game.x)) return;
    const d = this.game.d;
    if (option === "offer") {
      // Both offered: that is a draw.
      this.game = d === "me" ? { ...this.game, x: { why: "agreed" }, d: undefined } : { ...this.game, d: "peer" };
    } else if (d !== "me") {
      return this.notice("bad-message");
    } else {
      this.game = option === "accept" ? { ...this.game, x: { why: "agreed" }, d: undefined } : { ...this.game, d: undefined };
    }
    await this.saveGame();
    this.changed();
  }

  private async answerDrawNow(accept: boolean): Promise<void> {
    if (!this.game || this.game.d !== "peer" || this.view().phase !== "playing") return;
    this.game = accept ? { ...this.game, x: { why: "agreed" }, d: undefined } : { ...this.game, d: undefined };
    await this.saveGame();
    this.changed();
    await this.send({ k: "draw", g: this.game.g, o: accept ? "accept" : "decline" });
  }

  // ---------- helpers ----------

  /** A new toss with a fresh salt, giving up these games. */
  private async startToss(abandons: string[]): Promise<void> {
    this.flip = { v: 1, salt: newSalt(this.random), a: abandons.slice(0, 2) };
    await this.api.storage.set(KEY_FLIP, plain(this.flip));
    this.changed();
    await this.send({ k: "seek", c: commitment(this.flip.salt), a: this.flip.a });
  }

  /** The toss is done: this is the game now. */
  private async begin(game: SavedGame): Promise<void> {
    this.game = game;
    this.flip = null;
    this.stepPeerGame = null;
    this.chess = new Chess();
    await this.saveGame();
    await this.api.storage.delete(KEY_FLIP);
    this.changed();
  }

  private async sendSync(): Promise<void> {
    if (!this.game) return;
    const message: Message = { k: "sync", g: this.game.g, s: [this.game.s[0], this.game.s[1]], m: this.game.m };
    if (this.game.x) message.x = this.game.x;
    await this.send(message);
  }

  /** Our state for a peer that sent something we could not place, at most once a second. */
  private async resync(): Promise<void> {
    if (this.now() - this.lastResync < RESYNC_GAP_MS) return;
    this.lastResync = this.now();
    await this.hello();
  }

  private async send(message: Message): Promise<void> {
    if (!this.peerOpen) return;
    try {
      await this.api.chat.send(plain(encodeMessage(message)));
    } catch {
      // The peer closed or the chat dropped: the sync on its next open carries this.
      this.notice("send-failed");
    }
  }

  private async saveGame(): Promise<void> {
    if (this.game) await this.api.storage.set(KEY_GAME, plain(this.game));
  }

  private readGame(value: MiniAppJson | undefined): SavedGame | null {
    const v = value as Partial<SavedGame> | undefined;
    if (!v || v.v !== 1 || typeof v.g !== "string" || (v.me !== "w" && v.me !== "b") || !Array.isArray(v.s) || !Array.isArray(v.m)) return null;
    return v as SavedGame;
  }

  private readFlip(value: MiniAppJson | undefined): SavedFlip | null {
    const v = value as Partial<SavedFlip> | undefined;
    if (!v || v.v !== 1 || typeof v.salt !== "string" || !/^[0-9a-f]{64}$/.test(v.salt) || !Array.isArray(v.a)) return null;
    return v as SavedFlip;
  }

  private readMoves(value: MiniAppJson | undefined): string[] {
    const v = value as Partial<SavedLocal> | undefined;
    return v && v.v === 1 && Array.isArray(v.m) && v.m.every((m) => typeof m === "string") ? v.m : [];
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  private notice(notice: Notice): void {
    for (const listener of this.noticeListeners) listener(notice);
  }
}
