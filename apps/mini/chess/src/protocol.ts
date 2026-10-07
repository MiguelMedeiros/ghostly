/**
 * Chess's own messages, carried as the JSON value of `ghostly.chat.send` (one `apps/1` data frame each).
 *
 * Every message is `{"p": "chess", "v": 1, "k": <kind>, ...}`:
 *   seek    {c, a}        a coin toss: c = my commitment (hex SHA-256 of a secret salt), a = game ids I give up
 *   reveal  {s, c}        my salt, answering the peer's commitment c
 *   move    {g, n, m}     ply number n of game g, as UCI ("e2e4", "e7e8q")
 *   sync    {g, s, m, x?} catch-up: game g, both salts [sender's, receiver's], every ply, and how it ended if not on the board
 *   resign  {g}           the sender resigns game g
 *   draw    {g, o}        o = "offer", "accept" or "decline"
 *
 * Everything from the peer is untrusted: parseMessage checks the size first, then every field's type, shape and
 * range, and refuses the message whole. Unknown extra fields are ignored, so a later 1.x can add one.
 */
import type { MiniAppJson } from "@ghostly/core/miniApp";

export const PROTOCOL = "chess";
export const VERSION = 1;
/** One message, serialized as UTF-8 JSON. Half the 32 KiB `paired-app` data cap, so there is room to spare. */
export const MAX_MESSAGE_BYTES = 16 * 1024;
/** Longest game kept and synced: 2000 plies of at most 5 bytes is about 12 KiB in a sync. Reaching it ends the game drawn. */
export const MAX_PLIES = 2000;
/** Game ids a seek may give up: the sender's current game and the one the peer showed it. */
export const MAX_ABANDON = 2;

export type Colour = "w" | "b";
/** How a game ended other than on the board. */
export type GameEnd = { why: "resign"; by: Colour } | { why: "agreed" };
export type DrawOption = "offer" | "accept" | "decline";

export type Message =
  | { k: "seek"; c: string; a: string[] }
  | { k: "reveal"; s: string; c: string }
  | { k: "move"; g: string; n: number; m: string }
  | { k: "sync"; g: string; s: [string, string]; m: string[]; x?: GameEnd }
  | { k: "resign"; g: string }
  | { k: "draw"; g: string; o: DrawOption };

export type ParseFailure = "too-big" | "malformed" | "newer-version";
export type Parsed = { ok: true; message: Message } | { ok: false; reason: ParseFailure };

const HEX64 = /^[0-9a-f]{64}$/;
const GAME_ID = /^[0-9a-f]{16}$/;
export const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/** UTF-8 bytes of a value as JSON, or Infinity when it cannot be serialized. */
export function jsonBytes(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? Infinity : new TextEncoder().encode(text).length;
  } catch {
    return Infinity;
  }
}

/** The wire form of a message. Throws when it would break the size cap, which only a bug can do. */
export function encodeMessage(message: Message): MiniAppJson {
  const { k, ...fields } = message;
  const wire = { p: PROTOCOL, v: VERSION, k, ...fields } as unknown as MiniAppJson;
  if (message.k === "sync") (wire as Record<string, MiniAppJson>).m = message.m.join(" ");
  if (jsonBytes(wire) > MAX_MESSAGE_BYTES) throw new Error(`chess: a ${k} message is over ${MAX_MESSAGE_BYTES} bytes`);
  return wire;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isColour = (v: unknown): v is Colour => v === "w" || v === "b";

function parseEnd(v: unknown): GameEnd | null {
  if (!isObject(v)) return null;
  if (v.why === "resign" && isColour(v.by)) return { why: "resign", by: v.by };
  if (v.why === "agreed") return { why: "agreed" };
  return null;
}

/** A peer's message, checked. Never throws. */
export function parseMessage(value: unknown): Parsed {
  if (jsonBytes(value) > MAX_MESSAGE_BYTES) return { ok: false, reason: "too-big" };
  const bad: Parsed = { ok: false, reason: "malformed" };
  if (!isObject(value) || value.p !== PROTOCOL || !Number.isInteger(value.v)) return bad;
  if ((value.v as number) > VERSION) return { ok: false, reason: "newer-version" };
  if (value.v !== VERSION) return bad;
  const v = value;
  switch (v.k) {
    case "seek": {
      if (typeof v.c !== "string" || !HEX64.test(v.c)) return bad;
      if (!Array.isArray(v.a) || v.a.length > MAX_ABANDON || !v.a.every((g) => typeof g === "string" && GAME_ID.test(g))) return bad;
      return { ok: true, message: { k: "seek", c: v.c, a: [...(v.a as string[])] } };
    }
    case "reveal": {
      if (typeof v.s !== "string" || !HEX64.test(v.s) || typeof v.c !== "string" || !HEX64.test(v.c)) return bad;
      return { ok: true, message: { k: "reveal", s: v.s, c: v.c } };
    }
    case "move": {
      if (typeof v.g !== "string" || !GAME_ID.test(v.g)) return bad;
      if (!Number.isInteger(v.n) || (v.n as number) < 0 || (v.n as number) >= MAX_PLIES) return bad;
      if (typeof v.m !== "string" || !UCI.test(v.m)) return bad;
      return { ok: true, message: { k: "move", g: v.g, n: v.n as number, m: v.m } };
    }
    case "sync": {
      if (typeof v.g !== "string" || !GAME_ID.test(v.g)) return bad;
      if (!Array.isArray(v.s) || v.s.length !== 2 || !v.s.every((s) => typeof s === "string" && HEX64.test(s))) return bad;
      if (typeof v.m !== "string") return bad;
      const moves = v.m === "" ? [] : v.m.split(" ");
      if (moves.length > MAX_PLIES || !moves.every((m) => UCI.test(m))) return bad;
      let end: GameEnd | undefined;
      if (v.x !== undefined) {
        const parsed = parseEnd(v.x);
        if (!parsed) return bad;
        end = parsed;
      }
      const message: Message = { k: "sync", g: v.g, s: [v.s[0] as string, v.s[1] as string], m: moves };
      if (end) message.x = end;
      return { ok: true, message };
    }
    case "resign": {
      if (typeof v.g !== "string" || !GAME_ID.test(v.g)) return bad;
      return { ok: true, message: { k: "resign", g: v.g } };
    }
    case "draw": {
      if (typeof v.g !== "string" || !GAME_ID.test(v.g)) return bad;
      if (v.o !== "offer" && v.o !== "accept" && v.o !== "decline") return bad;
      return { ok: true, message: { k: "draw", g: v.g, o: v.o } };
    }
    default:
      return bad;
  }
}
