import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, fromBase64Url, randomBytes, toBase64Url, utf8Encode } from "./bytes";
import { publicKeyFromZ32 } from "./identity";

/**
 * The ratchet of a 1:1 chat's stored paths (WISP 4xx-ratchet, reserved number 407): what goes on the DHT floor
 * (WISP 403) and what is held (WISP 404) is sealed with a key used once, from a double ratchet in the manner of
 * Signal's (an X25519 step each time the turn passes, a one-way chain per message), so a participation key stolen
 * later opens none of it once the turn has passed. The live session needs none: its transports agree fresh keys on
 * every connection.
 *
 * Pure: every call takes a state and returns the next one. The caller holds one lock per chat from reading the state
 * to saving the next (an open's until what it opened is stored), and saves a seal's state before the sealed bytes
 * leave the device. Nothing here reads a clock or the network but through its options.
 */
export const RATCHET_CAPABILITY = "ratchet/1" as const;
export type RatchetLane = "floor" | "hold";
const LANE: Record<RatchetLane, number> = { floor: 1, hold: 2 };
const VERSION = 1;
const SID_BYTES = 8;
/** version, lane, session id, the sender's ratchet key, the hold lane's previous chain length, the message number. */
export const RATCHET_HEADER_BYTES = 1 + 1 + SID_BYTES + 32 + 4 + 4;
/** What sealing adds to a plaintext: the header and the 16-byte tag (the nonce is derived, never sent). */
export const RATCHET_OVERHEAD = RATCHET_HEADER_BYTES + 16;
/**
 * How far a message may be ahead of the last one opened on its chain. A mailbox shows only its newest envelope, so the
 * floor's between were replaced unread: their keys are stepped over and never kept. A held item's are kept. A sender
 * whose chain reaches the bound without the turn passing starts a new session rather than seal past it.
 */
export const MAX_SKIP: Record<RatchetLane, number> = { floor: 4096, hold: 512 };
/** Keys kept for held items not opened yet, at most, oldest dropped first. */
export const MAX_SKIPPED_KEYS = 512;
/** A kept key, and a session only received on, is dropped this long after it was last of use: a held item lives 7 days. */
export const RATCHET_KEEP_MS = 8 * 24 * 60 * 60_000;
/**
 * A session that lost (`lost`) becomes current when its floor envelopes keep rising in sequence while the current one
 * has opened no floor envelope for this long: two that started at once settle within one keep-alive (about four
 * minutes), and a contact that lost its state meanwhile seals in its own session from then on.
 */
export const FOLLOW_MS = 10 * 60_000;
/** Session ids no longer in use, kept so a replayed envelope of one cannot start it again. */
const MAX_RETIRED = 16;

interface Chain { k: string; n: number }
interface Lanes { floor: Chain; hold: Chain }
export interface RatchetSession {
  /** 8 random bytes, base64url: the session, chosen by the side that started it. */
  sid: string;
  rk: string;
  /** This side's ratchet secret; null while it is still the participation key's (the second side, before its first step). */
  dhs: string | null;
  dhsPub: string;
  /** The contact's ratchet key; null until its first message (the second side). */
  dhr: string | null;
  send: Lanes;
  /** How many held items the previous sending chain used: said in every header. */
  pnHold: number;
  recv: Lanes | null;
  /** A message of the contact's opened under this session. */
  heard: boolean;
  /**
   * The highest floor sequence (WISP 403's, signed by the contact and kept across its restores) of an envelope opened
   * under this session: what orders the contact's sessions, so an envelope from before both settled never wins.
   */
  floorSeq?: number;
  /** When a floor envelope was last opened under it. */
  floorAt?: number;
  /** A session that lost when both started at once, or came from before both settled: only opened with (but `FOLLOW_MS`). */
  lost?: true;
  /** When this side made or first opened it. */
  made: number;
  /**
   * The turn passed both ways: this side stepped on a key of the contact's with a ratchet secret of its own, so what
   * either side seals from now on needs secrets that are deleted after use, not the participation keys.
   */
  fs: boolean;
  at: number;
}
interface Skipped { s: string; d: string; n: number; k: string; at: number }
export interface RatchetState {
  v: 1;
  /** The session this side seals with. */
  current?: RatchetSession;
  /**
   * Sessions this side only opens with, newest last, at most `MAX_OTHERS`: the contact's that lost to this side's, this
   * side's before the contact started anew, or one the contact had left.
   */
  others: RatchetSession[];
  /** Hold lane only. */
  skipped: Skipped[];
  retired: string[];
  /** A ratcheted item from the contact was opened on this lane: from then on a plain one is refused there. */
  heard: { floor?: true; hold?: true };
}
export const emptyRatchetState = (): RatchetState => ({ v: 1, others: [], skipped: [], retired: [], heard: {} });
/** Sessions only opened with, at most. */
const MAX_OTHERS = 2;

/** What both sides of one chat derive the ratchet from: never stored in the state. */
export interface RatchetKeys {
  /** This side's participation seed (Ed25519, 32 bytes). */
  seed: Uint8Array;
  /** Both participation keys, z-base-32. */
  self: string;
  peer: string;
  /** The chat's two rendezvous keys, z-base-32, in either order. */
  rendezvous: [string, string];
  /** The invite's secret (`LinkParams.encKeyB64`). */
  secret: Uint8Array;
}
export interface RatchetOptions {
  now?: number;
  /** For test vectors only: where random bytes come from. */
  random?: (bytes: number) => Uint8Array;
}

const b64 = toBase64Url, unb64 = fromBase64Url;
const label = (text: string) => utf8Encode(`ghostly-ratchet/1 ${text}`);
const mac = (key: Uint8Array, text: string) => hmac(sha256, key, label(text));

function u32(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) throw new Error("Ratchet counter out of range");
  return new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}
const readU32 = (b: Uint8Array, at: number) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
/** X25519, or null for a key that gives no secret (a low-order point): such an item does not open. */
function agree(secret: Uint8Array, pub: Uint8Array): Uint8Array | null {
  try { return x25519.getSharedSecret(secret, pub); } catch { return null; }
}

/** One chat's fixed keys, computed once per call. */
interface Context { keys: RatchetKeys; first: boolean; secret: Uint8Array; pub: Uint8Array; peer: Uint8Array }
function context(keys: RatchetKeys): Context {
  const secret = ed25519.utils.toMontgomerySecret(keys.seed);
  return { keys, secret, pub: x25519.getPublicKey(secret), peer: ed25519.utils.toMontgomery(publicKeyFromZ32(keys.peer)),
    // The side whose participation key sorts first starts like Signal's first sender; the other like its second.
    first: compareBytes(publicKeyFromZ32(keys.self), publicKeyFromZ32(keys.peer)) < 0 };
}

function root(c: Context, sid: Uint8Array): Uint8Array {
  const { keys } = c;
  const info = utf8Encode(JSON.stringify(["ghostly-ratchet/1", [...keys.rendezvous].sort(), [keys.self, keys.peer].sort()]));
  const salt = hkdf(sha256, keys.secret, info, label("salt"), 32);
  return hkdf(sha256, x25519.getSharedSecret(c.secret, c.peer), salt, concatBytes(label("root"), sid), 32);
}
/** The root key a session starts from: the two participation keys' agreement, salted by the invite and the chat, per session id. */
export const ratchetRoot = (keys: RatchetKeys, sid: Uint8Array): Uint8Array => root(context(keys), sid);

/** A ratchet step: the next root key and the chain key it gives, from an X25519 output. */
function stepRoot(rk: Uint8Array, dh: Uint8Array): [Uint8Array, Uint8Array] {
  const okm = hkdf(sha256, dh, rk, label("step"), 64);
  return [okm.slice(0, 32), okm.slice(32)];
}
const lanes = (ck: Uint8Array): Lanes => ({ floor: { k: b64(mac(ck, "lane floor")), n: 0 }, hold: { k: b64(mac(ck, "lane hold")), n: 0 } });
/** One message key off a chain, and the chain moved past it. */
function advance(chain: Chain): [Uint8Array, Chain] {
  const ck = unb64(chain.k);
  return [hmac(sha256, ck, new Uint8Array([1])), { k: b64(hmac(sha256, ck, new Uint8Array([2]))), n: chain.n + 1 }];
}

function newSession(c: Context, sid: Uint8Array, random: (n: number) => Uint8Array, now: number): RatchetSession {
  const rk0 = root(c, sid);
  const initial = lanes(mac(rk0, "initial"));
  const base = { sid: b64(sid), pnHold: 0, heard: false, fs: false, at: now, made: now };
  // The second side: its first messages go on a chain from the root alone; its first step comes with the contact's first message.
  if (!c.first) return { ...base, rk: b64(rk0), dhs: null, dhsPub: b64(c.pub), dhr: null, send: initial, recv: null };
  // The first side takes its first step at once, against the contact's participation key, and reads the contact's first
  // messages on the chain from the root alone.
  const dhs = random(32);
  const [rk, ck] = stepRoot(rk0, x25519.getSharedSecret(dhs, c.peer));
  return { ...base, rk: b64(rk), dhs: b64(dhs), dhsPub: b64(x25519.getPublicKey(dhs)), dhr: b64(c.peer), send: lanes(ck), recv: initial };
}

function messageKeys(mk: Uint8Array): { key: Uint8Array; nonce: Uint8Array } {
  const okm = hkdf(sha256, mk, new Uint8Array(32), label("message"), 56);
  return { key: okm.slice(0, 32), nonce: okm.slice(32) };
}
function aad(lane: RatchetLane, sender: string, recipient: string, header: Uint8Array): Uint8Array {
  return concatBytes(utf8Encode("ghostly-ratchet/1"), new Uint8Array([LANE[lane]]), publicKeyFromZ32(sender), publicKeyFromZ32(recipient), header);
}

function header(lane: RatchetLane, session: RatchetSession, n: number): Uint8Array {
  return concatBytes(new Uint8Array([VERSION, LANE[lane]]), unb64(session.sid), unb64(session.dhsPub), u32(session.pnHold), u32(n));
}
interface Header { lane: RatchetLane; sid: string; dh: string; pnHold: number; n: number }
function parseHeader(sealed: Uint8Array): Header | null {
  if (sealed.length < RATCHET_OVERHEAD || sealed[0] !== VERSION || (sealed[1] !== 1 && sealed[1] !== 2)) return null;
  const at = 2 + SID_BYTES + 32;
  return { lane: sealed[1] === 1 ? "floor" : "hold", sid: b64(sealed.slice(2, 2 + SID_BYTES)), dh: b64(sealed.slice(2 + SID_BYTES, at)), pnHold: readU32(sealed, at), n: readU32(sealed, at + 4) };
}

function prune(state: RatchetState, now: number): void {
  state.skipped = state.skipped.filter(k => k.at + RATCHET_KEEP_MS > now).slice(-MAX_SKIPPED_KEYS);
  for (const old of state.others.filter(o => o.at + RATCHET_KEEP_MS <= now)) retire(state, old);
  state.others = state.others.filter(o => o.at + RATCHET_KEEP_MS > now);
}
function retire(state: RatchetState, session: RatchetSession | undefined): void {
  if (!session) return;
  if (!state.retired.includes(session.sid)) state.retired = [...state.retired, session.sid].slice(-MAX_RETIRED);
  state.skipped = state.skipped.filter(k => k.s !== session.sid);
}
/** `session` is only opened with from now on; past `MAX_OTHERS`, the one used least lately is retired. */
function demote(state: RatchetState, session: RatchetSession): void {
  state.others = [...state.others.filter(o => o.sid !== session.sid), session].sort((a, b) => a.at - b.at);
  while (state.others.length > MAX_OTHERS) retire(state, state.others.shift());
}

/**
 * Seals one item for the contact on a lane, with the current session (started here when there is none, or when its
 * chain on this lane reached `MAX_SKIP` without the turn passing: past it the contact could not step over to it). The
 * state returned MUST be saved before the sealed bytes leave the device: a key is used once, and a crash between the
 * two that kept the old state would use it again on other bytes.
 */
export function ratchetSeal(prev: RatchetState, keys: RatchetKeys, lane: RatchetLane, plaintext: Uint8Array, options: RatchetOptions = {}): { state: RatchetState; sealed: Uint8Array } {
  const now = options.now ?? Date.now(), random = options.random ?? randomBytes;
  const state = structuredClone(prev);
  prune(state, now);
  if (state.current && state.current.send[lane].n >= MAX_SKIP[lane]) { demote(state, state.current); delete state.current; }
  const session = state.current ??= newSession(context(keys), random(SID_BYTES), random, now);
  const [mk, next] = advance(session.send[lane]);
  const head = header(lane, session, session.send[lane].n);
  session.send[lane] = next; session.at = now;
  const { key, nonce } = messageKeys(mk);
  return { state, sealed: concatBytes(head, xchacha20poly1305(key, nonce, aad(lane, keys.self, keys.peer, head)).encrypt(plaintext)) };
}

/**
 * Opens `sealed` under `session`, changing it and `state` in place (both are a copy the caller throws away on null).
 * Every bound is checked before any X25519 or chain step.
 */
function openWith(state: RatchetState, session: RatchetSession, c: Context, h: Header, sealed: Uint8Array, random: (n: number) => Uint8Array, now: number): Uint8Array | null {
  const decrypt = (mk: Uint8Array) => {
    const { key, nonce } = messageKeys(mk);
    try { return xchacha20poly1305(key, nonce, aad(h.lane, c.keys.peer, c.keys.self, sealed.subarray(0, RATCHET_HEADER_BYTES))).decrypt(sealed.subarray(RATCHET_HEADER_BYTES)); }
    catch { return null; }
  };
  if (h.lane === "hold") {
    const i = state.skipped.findIndex(k => k.s === session.sid && k.d === h.dh && k.n === h.n);
    if (i >= 0) {
      const plain = decrypt(unb64(state.skipped[i].k));
      if (plain) state.skipped.splice(i, 1);
      return plain;
    }
  }
  const keep = (lane: RatchetLane, dh: string, from: Chain, until: number): Chain => {
    let chain = from;
    while (chain.n < until) {
      const [mk, next] = advance(chain);
      // A hold chain's keys stepped over wait for their items; a floor's are dropped (replaced unread).
      if (lane === "hold") state.skipped.push({ s: session.sid, d: dh, n: chain.n, k: b64(mk), at: now });
      chain = next;
    }
    return chain;
  };
  const bound = MAX_SKIP[h.lane];
  if (h.dh !== session.dhr) {
    // The contact took a step. Bounds first: the new chain starts at 0, and what is left of the previous hold chain is
    // kept as far as the contact says it went.
    const old = session.recv && session.dhr ? session.recv.hold : null;
    if (h.n > bound || (old && h.pnHold > old.n && h.pnHold - old.n > MAX_SKIP.hold)) return null;
    const ours = session.dhs ? unb64(session.dhs) : c.secret;
    const received = agree(ours, unb64(h.dh));
    if (!received) return null;
    if (old && session.dhr) keep("hold", session.dhr, old, h.pnHold);
    let [rk, ck] = stepRoot(unb64(session.rk), received);
    const steppedWithOwn = session.dhs !== null;
    session.recv = lanes(ck); session.dhr = h.dh;
    session.pnHold = session.send.hold.n;
    const dhs = random(32);
    [rk, ck] = stepRoot(rk, x25519.getSharedSecret(dhs, unb64(h.dh)));
    session.rk = b64(rk); session.dhs = b64(dhs); session.dhsPub = b64(x25519.getPublicKey(dhs)); session.send = lanes(ck);
    if (steppedWithOwn && h.dh !== b64(c.peer)) session.fs = true;
  }
  if (!session.recv) return null;
  const chain = session.recv[h.lane];
  // Only forward: an older floor envelope was read already or replaced; an older held one opened from a kept key above.
  if (h.n < chain.n || h.n - chain.n > bound) return null;
  const [mk, next] = advance(keep(h.lane, h.dh, chain, h.n));
  const plain = decrypt(mk);
  if (!plain) return null;
  session.recv[h.lane] = next; session.heard = true; session.at = now;
  return plain;
}

/**
 * Opens an item the contact sealed. Null: not a ratcheted item of this chat on this lane, or one already opened, or
 * past the bounds. Otherwise the plaintext, and `finish`, which gives the state to save once the item is stored and
 * passed its path's own checks (a newer DHT sequence, a held item not taken before): those, not the ratchet, are what
 * refuse a replay. `order`: a floor envelope's sequence, read from the body once opened. `fresh`: it came under a
 * session this side did not know.
 */
export function ratchetOpen(prev: RatchetState, keys: RatchetKeys, lane: RatchetLane, sealed: Uint8Array, options: RatchetOptions = {}): { plaintext: Uint8Array; fresh: boolean; finish(order?: number): RatchetState } | null {
  const now = options.now ?? Date.now(), random = options.random ?? randomBytes;
  const h = parseHeader(sealed);
  if (!h || h.lane !== lane) return null;
  const state = structuredClone(prev);
  prune(state, now);
  const c = context(keys);
  const seen = (session: RatchetSession, order: number | undefined) => {
    if (lane !== "floor" || order === undefined || !Number.isSafeInteger(order)) return false;
    const rising = session.floorSeq !== undefined && order > session.floorSeq;
    session.floorSeq = Math.max(session.floorSeq ?? 0, order); session.floorAt = now;
    return rising;
  };
  const done = () => { state.heard[lane] = true; prune(state, now); return state; };
  const known = state.current?.sid === h.sid ? state.current : state.others.find(o => o.sid === h.sid);
  if (known) {
    const plaintext = openWith(state, known, c, h, sealed, random, now);
    if (!plaintext) return null;
    return { plaintext, fresh: false, finish: order => {
      const rising = seen(known, order), current = state.current;
      // The contact keeps speaking in a session that lost, and not in this side's: it lost its state just as both settled.
      if (rising && known.lost && current && known !== current && current.floorSeq === undefined && now - (current.floorAt ?? current.made) > FOLLOW_MS) {
        state.others = state.others.filter(o => o.sid !== known.sid);
        delete known.lost;
        demote(state, current); state.current = known;
      }
      return done();
    } };
  }
  if (state.retired.includes(h.sid)) return null;
  // Bounds before any work: a session's chains start at 0.
  if (h.n > MAX_SKIP[lane] || h.pnHold > MAX_SKIP.hold) return null;
  const fresh = newSession(c, unb64(h.sid), random, now);
  const plaintext = openWith(state, fresh, c, h, sealed, random, now);
  if (!plaintext) return null;
  return { plaintext, fresh: true, finish: order => {
    seen(fresh, order);
    const current = state.current;
    if (!current) state.current = fresh;
    else if (current.floorSeq === undefined) {
      // Both started at once (no floor envelope of the contact's opened in this side's session yet): the larger session
      // id wins on both sides; the one that lost is kept to open what came under it, never to seal or win again.
      if (compareBytes(unb64(h.sid), unb64(current.sid)) > 0) { current.lost = true; demote(state, current); state.current = fresh; }
      else { fresh.lost = true; demote(state, fresh); }
    } else if (lane === "floor" && fresh.floorSeq !== undefined && fresh.floorSeq > current.floorSeq) {
      // A floor envelope newer, by the contact's own sequence, than any it put out in this side's session: the contact
      // lost its state, or its chain reached its bound. Its session becomes current.
      demote(state, current); state.current = fresh;
    } else if (lane === "floor") {
      // Older than what the contact said in this side's session: from before both settled. Kept only to open with.
      fresh.lost = true; demote(state, fresh);
    } else {
      // A held item of a session the contact left (it came late): opened, and its session forgotten.
      state.skipped = state.skipped.filter(k => k.s !== fresh.sid);
    }
    return done();
  } };
}

/** Whether `sealed` is shaped as a ratcheted item of this lane (it may still not open). */
export const isRatcheted = (sealed: Uint8Array, lane: RatchetLane) => parseHeader(sealed)?.lane === lane;
/** Whether forward secrecy is on for this chat: the turn passed both ways in the session this side seals with. */
export const ratchetOn = (state: RatchetState | undefined) => !!state?.current?.fs;
/** Whether a lane refuses plain items from the contact: a ratcheted one opened there (WISP 4xx § Downgrade). */
export const ratchetHeard = (state: RatchetState | undefined, lane: RatchetLane) => !!state?.heard[lane];

/**
 * One chat's ratchet, shared by its two lanes (the DHT floor and held items): the one lock per chat of WISP 4xx §
 * Saving state, and the order of saving. Every change goes through `lock`, so a seal and an open never start from the
 * same state.
 */
export class RatchetBox {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly keys: () => RatchetKeys, private state: RatchetState, private readonly save: (state: RatchetState) => Promise<void>) {}
  /** Runs `fn` alone among this chat's ratchet changes; `seal` and `open` are called inside it only. */
  lock<T>(fn: (box: RatchetTransaction) => Promise<T>): Promise<T> {
    const run = this.chain.then(() => fn(this.transaction()));
    this.chain = run.then(() => {}, () => {});
    return run;
  }
  private transaction(): RatchetTransaction {
    return {
      // Seal, save, send: the state is saved before the bytes are handed back.
      seal: async (lane, plaintext) => {
        const { state, sealed } = ratchetSeal(this.state, this.keys(), lane, plaintext);
        await this.save(state); this.state = state;
        return sealed;
      },
      // Open, store, save: the caller stores what opened, then commits; without a commit nothing moved.
      open: (lane, sealed) => {
        const opened = ratchetOpen(this.state, this.keys(), lane, sealed);
        if (!opened) return null;
        return { plaintext: opened.plaintext, fresh: opened.fresh, commit: async order => { const state = opened.finish(order); await this.save(state); this.state = state; } };
      },
    };
  }
  /**
   * Opens without keeping anything, and without the lock: a look from another profile, or the first half of a receive
   * whose content is then stored with no lock held (`commitOpen` keeps it).
   */
  peek(lane: RatchetLane, sealed: Uint8Array): Uint8Array | null { return ratchetOpen(this.state, this.keys(), lane, sealed)?.plaintext ?? null; }
  /**
   * The second half of a receive, once what `peek` gave is stored: opened again under the lock on the state as it is now
   * (a seal or another open may have moved it meanwhile), and that state saved. False: it no longer opens (taken by a
   * receive of the same item meanwhile), and nothing moved. So the lock is never held while content is stored, which
   * may call back into the other lane.
   */
  commitOpen(lane: RatchetLane, sealed: Uint8Array, order?: number): Promise<boolean> {
    return this.lock(async tx => {
      const opened = tx.open(lane, sealed);
      if (!opened) return false;
      await opened.commit(order);
      return true;
    });
  }
  heard(lane: RatchetLane): boolean { return ratchetHeard(this.state, lane); }
  /** A ratcheted item from the contact opened on either lane: this side seals with the ratchet whatever the contact's record says. */
  get heardAny(): boolean { return this.heard("floor") || this.heard("hold"); }
  get on(): boolean { return ratchetOn(this.state); }
}
export interface RatchetTransaction {
  seal(lane: RatchetLane, plaintext: Uint8Array): Promise<Uint8Array>;
  /** `commit(order)`: a floor envelope's sequence, as `ratchetOpen`'s `finish`. */
  open(lane: RatchetLane, sealed: Uint8Array): { plaintext: Uint8Array; fresh: boolean; commit(order?: number): Promise<void> } | null;
}
