import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answersOffer, callSignalHeardAt, parseCallSignal, signalHasVideo, BURST_RING_MS, CALL_SIGNAL_MAX_AGE_MS, QUICK_REDIAL_MS, type CallSignal } from "@ghostly/core";
import type { EngineState, LinkView } from "@ghostly/browser/shared/types";
import { findChat, findOwnNamedChat } from "../apiKit";
import { CliError } from "../errors";
import { AudioSocket, audioSocketPath, clearAudioSockets, feedQueue } from "./audioSocket";
import { callIceServers, CallMedia, callUsesTurn, EarlyAnswer, loadCallStack, type CallStack, type MediaOptions } from "./media";
import { DEFAULT_RATE, FRAME_MS, isCallRate, monotonic, PlaybackQueue, type CallRate } from "./pcm";

/**
 * Voice calls on the headless Ghostly (WISP 1100 § Calls): the calls/1 signals of the chat session (WISP 601), the
 * media on a WebRTC connection of the CLI's own, and the audio handed to an outside program over a Unix socket per
 * call. The rules are the apps' (packages/react/src/useWebRTC.ts): a call per chat; an offer rings while this side
 * is idle, or when it wins a glare with this side's own offer; an answer counts only after this side's offer; a hang-up ends whatever is on; a signal older than the
 * last one handled is ignored; after a hang-up the signal is cleared 5 s later.
 */

export type CallState = "ringing" | "connecting" | "connected";
export type EndReason = "hangup" | "remote-hangup" | "missed" | "rejected" | "unanswered" | "crossed" | "failed" | "stopped";

/** What the engine gives the calls: its state, and a way to send this side's signal. */
export interface CallEngine {
  getState(): EngineState;
  setCallSignal(params: { linkId: string; signal: string | null }): Promise<void> | void;
}

export interface CallHost {
  engine: CallEngine;
  emit(type: string, id: string, fields: Record<string, unknown>): void;
  profileDir: string;
  /** Whether this host answers and places calls: a daemon does; a one-shot command leaves, so it only reports. */
  answers?: boolean;
  /** The media stack (tests give their own). */
  stack?: () => Promise<CallStack | string>;
  now?: () => number;
  /**
   * How many times an outgoing call offers again, and an answered one answers the contact's newer offer (MAX_REDIALS):
   * tests that refuse some answers themselves raise it by theirs, so the real race's own refusals, which can come on
   * top, still find the app's budget whole.
   */
  maxRedials?: number;
  /** STALL_MS and STALL_END_MS (tests shorten them). */
  stall?: { afterMs: number; endMs: number };
  /** EARLY_ANSWER_MS (tests shorten it). */
  earlyAnswerMs?: number;
  /** CALL_PACE_MS (0: no pace; a test that redials at once on a clock that stands still). */
  callPaceMs?: number;
  /** QUICK_REDIAL_MS (0: no call is held back; tests that ring and hang up over and over to see each call). */
  quickRedialMs?: number;
}

/**
 * The audio contract of one call, as commands and events report it. `token` is the call's secret, which a program sends
 * first on the socket (`AudioSocket`): only the daemon's own clients are told it.
 */
export interface AudioInfo { socket: string; token: string; rate: CallRate; channels: 1; format: "s16le"; frameMs: typeof FRAME_MS }

/** An outgoing call rings this long, then ends as `unanswered`. */
export const RING_MS = 60_000;
/** An answered or accepted call has this long to connect its media, then ends as `failed`. */
export const CONNECT_MS = 30_000;
/** How long a call whose media closed or failed waits for the contact's hang-up signal to say why. */
export const MEDIA_GRACE_MS = 3_000;
/** After a hang-up, the signal is cleared this much later (the apps' own delay). */
export const CLEAR_MS = 5_000;
/** How many times an outgoing call offers again after an answer was refused (`redial`), and the wait before each. */
export const MAX_REDIALS = 4;
export const REDIAL_BACKOFF_MS = [150, 300, 600, 600] as const;
/** A connected call that hears no packet from the contact this long says so (`call.stalled`). */
export const STALL_MS = 5_000;
/** A connected call that hears no packet from the contact this long ends as `failed`. */
export const STALL_END_MS = 15_000;
/** A connection that fails this soon after its answer went in lost the race `redial` describes, and starts over. */
export const RACE_FAIL_MS = 2_000;
/**
 * A ringing call's answer is made ahead (`prepare`), and made again this often while it rings: libjuice gives up on a
 * connection that has nothing to check (the offer's candidates wait for the answer) after about 40 s.
 */
export const EARLY_ANSWER_MS = 30_000;
/**
 * A call this side placed that ended before it was answered (hung up while it rang, or rang out) is followed by the
 * next one in the same chat no sooner than this: the contact's app keeps a call that comes this soon after a missed one
 * that barely rang as missed and does not ring it (`QUICK_REDIAL_MS`, 2 s, which this side keeps too), so a loop would only add lines. A bot looping
 * `call.start` / `call.hangup` placed 1,375 calls a minute (agents#974). `call.start` refuses sooner with `busy` and the
 * wait left (`retryAfterMs`); a person placing calls by hand never meets it.
 */
export const CALL_PACE_MS = 2_000;

/**
 * At most this many early answers are being made or held at once, and one being made per chat: a call that ends as
 * its early answer is made closes it only once made (up to HOST_GATHER_MS later). Past either, the call rings without
 * one, and its answer makes its own connection (or it gets one once the chat's is made).
 */
export const MAX_EARLY_ANSWERS = 4;

interface Call {
  id: string;
  chat: string;
  direction: "in" | "out";
  state: CallState;
  rate: CallRate;
  video: boolean;
  offer: CallSignal | null;
  /** This side's offer's timestamp: only a later answer counts. */
  offerTs: number;
  /** This side's offer waits for its answer. */
  offering: boolean;
  /** How many times this side offered again on a new connection after an answer was refused (`redial`). */
  redials: number;
  /** How many times this side answered the contact's newer offer on a new connection (`reanswer`). */
  reanswers: number;
  /** The log said the contact's offers past the last start-over are ignored: it says so once a call. */
  ignoring: boolean;
  /** Counts the connections made for the call: one that comes back after a newer one was asked for is closed. */
  attempt: number;
  /** The attempt whose connection has the contact's answer (0: none yet), and when it went in (`monotonic`). */
  answered: number;
  answeredAt: number;
  media: CallMedia | null;
  /** While an incoming call rings: its answer's connection, made ahead (`prepare`), the one being made, and the timer that makes it again. */
  early: EarlyAnswer | null;
  making: Making | null;
  earlyTimer: ReturnType<typeof setTimeout> | null;
  socket: AudioSocket | null;
  /** What the program wrote and the call has not sent yet: kept from the moment the socket opens. */
  queue: PlaybackQueue | null;
  startedAt: number;
  connectedAt: number | null;
  /** The same moment on the call's own clock (`monotonic`), for its length: the time it lasted, whatever the device's clock did. */
  connectedTick: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** The connected call's watch on the contact's packets (`watch`). */
  watcher: ReturnType<typeof setInterval> | null;
  /** Since when nothing came from the contact, while the call says it stalled (null: it does not); how many times it did. */
  stalledFrom: number | null;
  stalls: number;
  ended: boolean;
  /** Why it ended, once it has. */
  reason?: EndReason;
}

/** An early answer being made; `claimed` once the call's answer waits for it, which then takes it itself. */
interface Making { chat: string; done: Promise<EarlyAnswer | null>; claimed: boolean }

/** Auto-answer, kept in the profile's `calls.json`: every chat, or the listed ones, at a rate. */
export interface AutoAnswer { on: boolean; from: string[]; rate: CallRate }

export class CallManager {
  private readonly calls = new Map<string, Call>();
  /** Per chat: the timestamp of the last signal handled. */
  private readonly lastSignal = new Map<string, number>();
  /** Per chat: the timestamp of the last signal sent (`stamp`). */
  private readonly lastSent = new Map<string, number>();
  /** Per chat: the timer that clears the hang-up signal. */
  private readonly clearing = new Map<string, ReturnType<typeof setTimeout>>();
  /** Per chat: when this side's last call there ended before it was answered (`CALL_PACE_MS`). */
  private readonly unansweredAt = new Map<string, number>();
  /** Per chat: when the contact's last call there was missed after it barely rang, or held back (`QUICK_REDIAL_MS`). */
  private readonly missedAt = new Map<string, number>();
  /** Per chat: the contact's last call held back (`QUICK_REDIAL_MS`) until its hang-up, and when it came. */
  private readonly held = new Map<string, { offer: CallSignal; at: number }>();
  /**
   * The chats whose contact's calls are being held back (`QUICK_REDIAL_MS`) since the last that rang: the log says so for
   * the first only. A detached daemon's log only grows, and a contact's loop would set its pace.
   */
  private readonly bursts = new Set<string>();
  /** The early answers being made, those of ended calls too (MAX_EARLY_ANSWERS). */
  private readonly makings = new Set<Making>();
  private auto: AutoAnswer;
  private readonly configPath: string;
  private stopping = false;

  constructor(private readonly host: CallHost) {
    this.configPath = join(host.profileDir, "calls.json");
    this.auto = readAuto(this.configPath);
    // A daemon starts with no call: a socket left in its folder is one a daemon that crashed during a call never closed.
    if (host.answers !== false) clearAudioSockets(host.profileDir);
  }

  private get now(): number { return (this.host.now ?? Date.now)(); }

  /**
   * A new signal's timestamp in a chat: now, or 1 ms after the last one sent there. The contact drops a signal no
   * newer than the last it heard, so a redial or a hang-up in the same millisecond as the signal before it would be lost.
   */
  private stamp(chat: string): number {
    const ts = Math.max(this.now, (this.lastSent.get(chat) ?? 0) + 1);
    this.lastSent.set(chat, ts);
    return ts;
  }

  // ---------- signals from the contact ----------

  /** A signal the contact's app sent in a chat (the engine's `call-signal`). */
  onSignal(chat: string, json: string): void {
    // A stopping daemon takes no call, and its own have been hung up (`stopAll`): nothing here is heard any more.
    if (this.stopping) return;
    const signal = parseCallSignal(json, this.now);
    if (!signal) return;
    if (signal.ts <= (this.lastSignal.get(chat) ?? 0)) return;
    const call = this.byChat(chat);
    // Reconnecting (WISP 601): this side never says it restarts ICE (`x`), so an app sends it no restart offer (`r`),
    // and one that comes all the same is dropped here, on a call or not. libdatachannel (0.24.5) cannot restart ICE
    // on a connection that has started: it refuses a remote offer with new ICE credentials ("Invalid ICE settings
    // from remote SDP") and cannot make one. A call whose path is lost ends as before (`MEDIA_GRACE_MS`).
    if (signal.t === "r" || (signal.t === "a" && signal.re !== undefined)) return;
    // A connected call only hears a hang-up (and picture changes, which are no business of an audio-only side).
    if (call?.state === "connected" && signal.t !== "h" && signal.t !== "v") return;
    if (signal.t === "o" && !call) {
      this.lastSignal.set(chat, signal.ts);
      if (this.quickRedial(chat)) {
        // Placed faster than a person redials (QUICK_REDIAL_MS), as the apps hold it: kept as missed, with no ring, no
        // event and no answer, auto-answer's included. A burst rings once, and is one line in the log.
        if (!this.bursts.has(chat)) process.stderr.write(`ghostly: chat ${chat}: a call came right after a missed one that barely rang: kept as missed, and the next ones that come as fast\n`);
        this.bursts.add(chat);
        this.missedAt.set(chat, this.now);
        this.held.set(chat, { offer: signal, at: this.now });
      } else {
        this.incoming(chat, signal);
      }
    } else if (signal.t === "a" && call?.direction === "out" && call.offering && answersOffer(signal, call.offerTs)) {
      this.lastSignal.set(chat, signal.ts);
      this.accepted(call, signal);
    } else if (signal.t === "o" && call?.direction === "out" && call.state === "ringing") {
      // Both called at once (WISP 601, "Both call at once"): the earlier offer wins on both sides, at the same
      // millisecond the lower DTLS fingerprint; ours still being made counts as later. The loser rings.
      this.lastSignal.set(chat, signal.ts);
      const mine = call.offering ? call.offerTs : 0;
      const theirsFirst = !mine || signal.ts < mine || (signal.ts === mine && (signal.f ?? "") < (call.media?.local.f ?? ""));
      if (theirsFirst) void this.yieldTo(call, signal);
    } else if (signal.t === "o" && call?.direction === "in" && call.state === "connecting" && call.media && signal.ts > (call.offer?.ts ?? 0)) {
      // The contact's side offered again on a new connection (see `redial`): the answered call starts over on one, up
      // to MAX_REDIALS times, as the apps do (MAX_RESTARTS). Past it the offer is ignored, and the call that did not
      // connect ends as `failed` at its timer. The log says so once.
      this.lastSignal.set(chat, signal.ts);
      if (call.reanswers < this.maxRedials) void this.reanswer(call, signal);
      else if (!call.ignoring) {
        call.ignoring = true;
        process.stderr.write(`ghostly: call ${call.id}: the contact offered again past the last start-over: ignored, and its next offers on this call\n`);
      }
    } else if (signal.t === "v") {
      this.lastSignal.set(chat, signal.ts);
    } else if (signal.t === "h") {
      this.lastSignal.set(chat, signal.ts);
      this.held.delete(chat);
      if (call) {
        // A hang-up while this side starts over (`redial`) is the contact's app ending a connection that failed. Once
        // a connection came up, the call was on: a start-over before it does not make the hang-up a failure.
        // A hang-up that says the contact's side could not connect (`r: "u"`, WISP 601): the call failed, not declined.
        const unreachable = signal.r === "u" && call.state !== "connected";
        const failed = unreachable || (call.state !== "connected" && (call.offering || (call.direction === "out" && call.redials > 0)));
        const reason: EndReason = call.state === "ringing" && call.direction === "in" ? "missed"
          : call.state === "ringing" && !unreachable ? "rejected" : failed ? "failed" : "remote-hangup";
        void this.end(call, reason, false);
      }
    }
  }

  /**
   * The contact's offer won a glare: our call ends as `crossed`, sending nothing (a hang-up would end the contact's
   * call, and clearing our signal could drop an answer we are about to give), and the contact's call rings here.
   */
  private async yieldTo(call: Call, offer: CallSignal): Promise<void> {
    await this.end(call, "crossed", false);
    // Something newer (the contact's hang-up) came while ours ended, or another call started: nothing rings.
    if (this.lastSignal.get(call.chat) !== offer.ts || this.byChat(call.chat) || this.stopping) return;
    this.incoming(call.chat, offer);
  }

  private incoming(chat: string, offer: CallSignal): void {
    this.held.delete(chat);
    this.bursts.delete(chat);
    const link = this.link(chat);
    const call = this.add(chat, "in", this.auto.rate);
    call.offer = offer;
    call.video = signalHasVideo(offer);
    // Unanswered, an offer goes stale: the contact's app has given up or will, and answering it would be refused.
    this.arm(call, Math.max(1000, callSignalHeardAt(offer) + CALL_SIGNAL_MAX_AGE_MS - this.now), "missed", false);
    this.host.emit("call.incoming", `call.incoming:${call.id}`, { call: call.id, chat, name: link ? nameOf(link) : null, video: call.video, auto: this.autoFor(chat) });
    this.prepare(call);
    if (this.host.answers !== false && this.autoFor(chat)) {
      void this.answer(call.id, {}).catch((error) => process.stderr.write(`ghostly: auto-answer failed: ${error instanceof Error ? error.message : String(error)}\n`));
    }
  }

  private accepted(call: Call, answer: CallSignal): void {
    call.offering = false;
    call.state = "connecting";
    const attempt = (call.answered = call.attempt);
    call.answeredAt = monotonic();
    try {
      call.media!.applyAnswer(answer);
    } catch (error) {
      // The connection may have failed first, while the answer was added: then it already started over.
      if (attempt === call.attempt) this.refused(call, `the answer was refused (${error instanceof Error ? error.message : String(error)})`);
      return;
    }
    if (attempt === call.attempt) this.arm(call, CONNECT_MS, "failed", true);
  }

  /**
   * The contact's answer on this connection was refused, or the connection failed right after it (the same race,
   * whose handshake can also fail once the answer is in): offering again (`redial`) while there are tries left.
   */
  private refused(call: Call, what: string): void {
    if (call.redials < this.maxRedials) {
      process.stderr.write(`ghostly: call ${call.id}: ${what}: offering again on a new connection\n`);
      void this.redial(call);
      return;
    }
    process.stderr.write(`ghostly: call ${call.id}: ${what}\n`);
    void this.end(call, "failed", true);
  }

  private get maxRedials(): number { return this.host.maxRedials ?? MAX_REDIALS; }

  /**
   * A new offer on a new connection, up to MAX_REDIALS times, each after a short wait. libdatachannel (0.24.5) can
   * refuse a good answer: when the contact's checks and its DTLS hello came before the answer (they do, the answer
   * crosses the chat session), ICE connects and the handshake ends inside setRemoteDescription, before the answer's
   * fingerprint is recorded; the fingerprint check fails, the connection closes its transports, and adding the
   * answer's candidates throws "Got a remote candidate without ICE transport". That connection is done for, and the
   * contact's side saw the handshake fail too, so both start over: the contact's side answers the newer offer
   * (`reanswer`). Each new connection runs the same race (CI runners lose about one in six, Linux arm64 twice in a
   * row), hence several. The race can also let the answer in and fail the handshake a moment later: a connection
   * that fails after its answer, before it ever connected, starts over the same way. The contact's side ends a call whose connection failed after MEDIA_GRACE_MS: every wait stays
   * well under it. Fixed upstream in libdatachannel 0235225a, which no release has yet.
   */
  private async redial(call: Call): Promise<void> {
    const wait = REDIAL_BACKOFF_MS[Math.min(call.redials, REDIAL_BACKOFF_MS.length - 1)];
    call.redials++;
    // The refused connection is dropped now: its closing must not arm its own timer over the one below while we wait.
    call.attempt++;
    call.media?.close();
    call.media = null;
    this.arm(call, CONNECT_MS, "failed", true);
    await new Promise((resolve) => setTimeout(resolve, wait));
    if (call.ended) return;
    try {
      const stack = await this.stack();
      if (!(await this.connect(call, (media) => CallMedia.offer(stack, media)))) return;
      call.offerTs = this.stamp(call.chat);
      call.offering = true;
      await this.send(call.chat, { t: "o", ts: call.offerTs, ...call.media!.local, v: 0 });
    } catch (error) {
      process.stderr.write(`ghostly: call ${call.id}: offering again failed (${error instanceof Error ? error.message : String(error)})\n`);
      void this.end(call, "failed", true);
    }
  }

  /** The contact's newer offer (its `redial`): answered on a new connection, on the call's socket. */
  private async reanswer(call: Call, offer: CallSignal): Promise<void> {
    process.stderr.write(`ghostly: call ${call.id}: the contact offered again: answering on a new connection\n`);
    call.reanswers++;
    call.offer = offer;
    call.video = signalHasVideo(offer);
    this.arm(call, CONNECT_MS, "failed", true);
    try {
      const stack = await this.stack();
      if (!(await this.connect(call, (media) => CallMedia.answer(stack, offer, media)))) return;
      await this.send(call.chat, { t: "a", ts: this.stamp(call.chat), o: offer.ts, ...call.media!.local, v: 0 });
    } catch (error) {
      process.stderr.write(`ghostly: call ${call.id}: answering again failed (${error instanceof Error ? error.message : String(error)})\n`);
      void this.end(call, "failed", true);
    }
  }

  /**
   * The ringing call's answer, made now (`EarlyAnswer`): when the call is answered, its candidates have been gathered
   * and the answer goes at once. Made again every EARLY_ANSWER_MS while it rings; when it cannot be made, the answer makes its own.
   * Not made with a TURN server in the profile's settings: libjuice never gives an allocation back (no Refresh with
   * LIFETIME 0 when a connection closes), so each one held a relay on the server for 10 minutes, those of calls declined,
   * missed and cancelled too, and a server with a per-user quota refused the next calls theirs. The answer allocates.
   */
  private prepare(call: Call): void {
    if (this.host.answers === false || call.ended || call.state !== "ringing") return;
    const settings = this.host.engine.getState().settings;
    const iceServers = settings?.iceServers ?? [];
    // Hide my IP from contacts: no call is answered here (`callable`), so none is made ahead either.
    if (settings?.relayOnly === true || callUsesTurn(callIceServers(iceServers))) return;
    this.stopEarly(call);
    call.earlyTimer = setTimeout(() => this.prepare(call), this.host.earlyAnswerMs ?? EARLY_ANSWER_MS);
    call.earlyTimer.unref?.();
    if (call.making) return;
    // Bounded (MAX_EARLY_ANSWERS): a contact that rings and hangs up over and over makes one at a time.
    const held = [...this.calls.values()].filter((c) => c !== call && c.early).length;
    if (this.makings.size + held >= MAX_EARLY_ANSWERS || [...this.makings].some((m) => m.chat === call.chat)) return;
    const offer = call.offer!;
    const making: Making = {
      chat: call.chat,
      done: this.stack().then((stack) => EarlyAnswer.open(stack, offer, {
        iceServers,
        log: (line) => process.stderr.write(`ghostly: call ${call.id}: ${line}\n`),
      })).catch((error) => {
        // Not tried again while it rings: the answer makes its own connection, as it did before.
        this.stopEarly(call);
        process.stderr.write(`ghostly: call ${call.id}: the answer could not be made ahead (${error instanceof Error ? error.message : String(error)})\n`);
        return null;
      }),
      claimed: false,
    };
    call.making = making;
    this.makings.add(making);
    void making.done.then((early) => {
      this.makings.delete(making);
      if (call.making === making) call.making = null;
      if (!making.claimed && early) {
        // The call ended, or was answered on the one made before, while this one was made.
        if (call.ended || call.state !== "ringing") early.close();
        else { call.early?.close(); call.early = early; }
      }
      // A newer call in this chat rang without one while this was made: its own is made now.
      const next = this.byChat(making.chat);
      if (next && next !== call && next.direction === "in" && !next.making && !next.early) this.prepare(next);
    });
  }

  /** The answered call's early answer: the one made, if still good, or the one being made; none from then on. */
  private async takeEarly(call: Call): Promise<EarlyAnswer | null> {
    this.stopEarly(call);
    const early = call.early;
    call.early = null;
    if (early?.usable) return early;
    early?.close();
    const making = call.making;
    if (!making) return null;
    making.claimed = true;
    return making.done;
  }

  /** The early answer is not made again. */
  private stopEarly(call: Call): void {
    if (call.earlyTimer) clearTimeout(call.earlyTimer);
    call.earlyTimer = null;
  }

  // ---------- commands ----------

  async start(chat: string, options: { rate?: unknown }): Promise<Record<string, unknown>> {
    const link = this.callable(chat);
    if (this.byChat(link.id)) throw new CliError("busy", "A call is already on in this chat");
    // The contact's call held back here (QUICK_REDIAL_MS) may still ring there: ours would cross it, and theirs, the
    // earlier offer, would win on their side while this side has already spent it. It rings here instead, as the apps do.
    const held = this.held.get(link.id);
    if (held && this.within(held.at, RING_MS)) {
      this.incoming(link.id, held.offer);
      throw new CliError("busy", "The contact is calling: their call rings here");
    }
    this.paced(link.id);
    const rate = rateOf(options.rate, this.auto.rate);
    const stack = await this.stack();
    // The contact's call may have come in while the stack loaded.
    if (this.byChat(link.id)) throw new CliError("busy", "A call is already on in this chat");
    const call = this.add(link.id, "out", rate);
    try {
      await this.attach(call, (media) => CallMedia.offer(stack, media));
      if (call.reason === "crossed") throw new CliError("busy", "The contact called at the same time: their call rings here");
      if (call.ended) throw new CliError("unavailable", "The call ended before it was placed");
      call.offerTs = this.stamp(link.id);
      call.offering = true;
      await this.send(link.id, { t: "o", ts: call.offerTs, ...call.media!.local, v: 0 });
    } catch (error) {
      await this.end(call, "failed", false, false);
      throw error;
    }
    this.arm(call, RING_MS, "unanswered", true);
    this.host.emit("call.outgoing", `call.outgoing:${call.id}`, { call: call.id, chat: link.id, name: nameOf(link), audio: this.audioInfo(call) });
    return this.view(call);
  }

  async answer(ref: string | undefined, options: { rate?: unknown }): Promise<Record<string, unknown>> {
    const call = this.find(ref, (c) => c.direction === "in" && c.state === "ringing");
    if (call.direction !== "in" || call.state !== "ringing") throw new CliError("refused", "That call is not ringing here");
    this.callable(call.chat);
    call.rate = rateOf(options.rate, call.rate);
    const stack = await this.stack();
    // The call may have ended (the contact hung up, the offer went stale) or been answered by another command while
    // the stack loaded: an ended call opens nothing, and a call is answered once.
    if (call.ended) throw new CliError("unavailable", "The call ended before it was answered");
    if (call.state !== "ringing") throw new CliError("refused", "That call is not ringing here");
    // Answered: no longer missed if it goes stale; the media has its own time to connect.
    call.state = "connecting";
    this.disarm(call);
    let early: EarlyAnswer | null = null;
    try {
      early = await this.takeEarly(call);
      await this.attach(call, (media) => CallMedia.answer(stack, call.offer!, media, early));
      if (call.ended) throw new CliError("unavailable", "The call ended before it was answered");
      await this.send(call.chat, { t: "a", ts: this.stamp(call.chat), o: call.offer!.ts, ...call.media!.local, v: 0 });
    } catch (error) {
      // Its call.incoming went out: call.ended does too, for the program (or hook) waiting on that call. The contact's
      // app still rings: the hang-up says this side could not connect (`r: "u"`), as an app's whose microphone was
      // refused does, so the contact's chat says the call failed, not that it was declined.
      await this.end(call, "failed", "unreachable");
      throw error;
    } finally {
      // Unused (the call ended first): closed. Nothing once its connection is the call's.
      early?.close();
    }
    this.arm(call, CONNECT_MS, "failed", true);
    return this.view(call);
  }

  async hangup(ref: string | undefined): Promise<Record<string, unknown>> {
    const call = this.find(ref);
    const view = this.view(call);
    await this.end(call, "hangup", true);
    return { ...view, state: "ended", reason: "hangup" };
  }

  /** One call, by its id or its chat (or the only one). */
  get(ref: string | undefined): Record<string, unknown> {
    return this.view(this.find(ref));
  }

  list(): Record<string, unknown>[] {
    return [...this.calls.values()].map((call) => this.view(call));
  }

  /** Drops the audio the program queued and the call has not sent yet (barge-in). */
  flush(ref: string | undefined): Record<string, unknown> {
    const call = this.find(ref);
    const flushedMs = call.queue?.flush() ?? 0;
    return { call: call.id, chat: call.chat, flushedMs };
  }

  getAuto(): AutoAnswer { return { ...this.auto, from: [...this.auto.from] }; }

  setAuto(next: { on: boolean; from?: string[]; rate?: unknown }): AutoAnswer {
    // The daemon answers these chats' calls from now on: never one found only by a name its contact chose.
    const { links, groups } = this.host.engine.getState();
    const from = (next.from ?? []).map((ref) => findOwnNamedChat(links, ref, groups).id);
    this.auto = { on: next.on, from: next.on ? from : [], rate: rateOf(next.rate, next.on ? this.auto.rate : DEFAULT_RATE) };
    this.saveAuto();
    return this.getAuto();
  }

  /**
   * A chat removed from this device leaves the chats auto-answer answers. The last one gone turns auto-answer off:
   * an empty list is "answer everyone", never what was asked for.
   */
  forgetChat(chat: string): void {
    if (!this.auto.from.includes(chat)) return;
    const from = this.auto.from.filter((c) => c !== chat);
    this.auto = from.length > 0 ? { ...this.auto, from } : { on: false, from: [], rate: DEFAULT_RATE };
    this.saveAuto();
  }

  private saveAuto(): void {
    const tmp = `${this.configPath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ autoAnswer: this.auto }, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.configPath);
  }

  /** Before the engine stops: every call is hung up (the contact's app is told), its program gets EOF. */
  async stopAll(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.calls.values()].map((call) => this.end(call, "stopped", true)));
    for (const timer of this.clearing.values()) clearTimeout(timer);
    this.clearing.clear();
  }

  // ---------- inside ----------

  private add(chat: string, direction: "in" | "out", rate: CallRate): Call {
    if (this.stopping) throw new CliError("unavailable", "The daemon is stopping");
    // A new call in this chat: the last one's hang-up must not be cleared over its signal.
    const clearing = this.clearing.get(chat);
    if (clearing) { clearTimeout(clearing); this.clearing.delete(chat); }
    const call: Call = {
      id: randomBytes(6).toString("hex"), chat, direction, state: "ringing", rate, video: false, offer: null, offerTs: 0,
      offering: false, redials: 0, reanswers: 0, ignoring: false, attempt: 0, answered: 0, answeredAt: 0, media: null, early: null, making: null, earlyTimer: null, socket: null, queue: null, startedAt: this.now, connectedAt: null, connectedTick: null, timer: null,
      watcher: null, stalledFrom: null, stalls: 0, ended: false,
    };
    this.calls.set(call.id, call);
    return call;
  }

  /**
   * The call's socket (open from now on: a program may connect before the media is up) and its media. A call that
   * ended while its socket opened closes it here: `end` found none to close, and nothing lists the call any more.
   */
  private async attach(call: Call, create: (options: MediaOptions) => Promise<CallMedia>): Promise<void> {
    const queue = (call.queue = new PlaybackQueue(call.rate));
    const socket = await AudioSocket.open(audioSocketPath(this.host.profileDir, call.id), call.rate, feedQueue(queue));
    if (call.ended) { await socket.close(); return; }
    call.socket = socket;
    await this.connect(call, create);
  }

  /**
   * A connection for the call, in place of the one it had (closed first); the socket and its queue stay. False when
   * the call ended, or asked for a newer connection, while this one was made: then it is closed.
   */
  private async connect(call: Call, create: (options: MediaOptions) => Promise<CallMedia>): Promise<boolean> {
    // No connection is made for a call that is over (it ended while the stack loaded or its socket opened).
    if (call.ended) return false;
    const attempt = ++call.attempt;
    call.media?.close();
    call.media = null;
    let failed = false;
    const media = await create({
      rate: call.rate,
      queue: call.queue ?? undefined,
      log: (line) => process.stderr.write(`ghostly: call ${call.id}: ${line}\n`),
      iceServers: this.host.engine.getState().settings?.iceServers ?? [],
      onFrame: (frame) => call.socket?.write(frame),
      onState: (state) => {
        if (call.ended || attempt !== call.attempt) return;
        if (state === "connected") { this.connected(call); return; }
        // A connection fails, then closes: it still failed.
        if (state === "closed" && failed) return;
        failed ||= state === "failed";
        // The answer went in and the connection failed at once, before it ever connected: the race's other ending (a
        // contact out of reach fails later, and ends the call as before).
        if (state === "failed" && call.direction === "out" && call.answered === attempt && call.state !== "connected"
          && monotonic() - call.answeredAt < RACE_FAIL_MS) {
          this.refused(call, "the connection failed as the answer went in");
          return;
        }
        // The contact's app closes its connection as it hangs up, and that is often here before its hang-up signal
        // (which crosses the chat session): the signal gets a moment to say so. Without one, a connection the
        // contact closed was still a hang-up; one that failed ends the call, and the contact is told, as the apps tell
        // it: its side may still say "Connecting..." or "Reconnecting..." (WISP 601 "Couldn't connect").
        this.arm(call, MEDIA_GRACE_MS, state === "closed" ? "remote-hangup" : "failed", state !== "closed");
      },
    });
    if (call.ended || attempt !== call.attempt) {
      media.close();
      return false;
    }
    call.media = media;
    return true;
  }

  private connected(call: Call): void {
    if (call.state === "connected") return;
    call.state = "connected";
    call.connectedAt = this.now;
    call.connectedTick = monotonic();
    this.disarm(call);
    this.host.emit("call.connected", `call.connected:${call.id}`, { call: call.id, chat: call.chat, direction: call.direction, audio: this.audioInfo(call) });
    this.watch(call);
  }

  /**
   * libjuice says nothing of a contact whose side went away (a crash, a closed lid, a lost network) until its consent
   * checks fail, about 30 s later: a connected call watches the contact's packets instead. An app sends them all along
   * (silence while muted, and RTCP), and so does the CLI. Nothing for STALL_MS: `call.stalled`; packets again:
   * `call.resumed`; nothing for STALL_END_MS: the call ends as `failed`, and the contact's app is told.
   */
  private watch(call: Call): void {
    const { afterMs, endMs } = this.host.stall ?? { afterMs: STALL_MS, endMs: STALL_END_MS };
    // On the audio's clock (`monotonic`): on the device's, a clock set ahead read as that long without a packet, and ended the call.
    const since = monotonic(), every = Math.min(1000, afterMs / 5);
    // A tick that comes far past its interval comes after a stall of this side's own (its loop held by other work, the
    // process stopped or swapped out), and before the packets the contact sent meanwhile are read: that time is not the
    // contact's silence (`own`, until something is heard after it), and the call is judged on the next tick, once read.
    let ticked = since, own = 0, ownUntil = 0;
    call.watcher = setInterval(() => {
      if (call.ended) return;
      const now = monotonic(), gap = now - ticked;
      ticked = now;
      if (gap > 2 * every) { own += gap - every; ownUntil = now; return; }
      const heardAt = Math.max(since, call.media?.audio.heardAt ?? 0);
      if (heardAt >= ownUntil) own = 0;
      const silentMs = now - heardAt - own;
      const fields = { call: call.id, chat: call.chat, direction: call.direction };
      if (silentMs >= endMs) {
        process.stderr.write(`ghostly: call ${call.id}: nothing heard from the contact for ${Math.round(silentMs / 1000)} s\n`);
        void this.end(call, "failed", true);
      } else if (silentMs >= afterMs && call.stalledFrom === null) {
        call.stalledFrom = heardAt;
        call.stalls++;
        process.stderr.write(`ghostly: call ${call.id}: stalled, nothing heard from the contact for ${silentMs} ms\n`);
        this.host.emit("call.stalled", `call.stalled:${call.id}:${call.stalls}`, { ...fields, silentMs });
      } else if (silentMs < afterMs && call.stalledFrom !== null) {
        const gapMs = heardAt - call.stalledFrom;
        call.stalledFrom = null;
        process.stderr.write(`ghostly: call ${call.id}: resumed after ${gapMs} ms\n`);
        this.host.emit("call.resumed", `call.resumed:${call.id}:${call.stalls}`, { ...fields, silentMs: gapMs });
      }
    }, every);
    call.watcher.unref?.();
  }

  /** `tell`: the contact is sent a hang-up; `"unreachable"`, one that says this side could not connect (`r: "u"`, WISP 601). */
  private async end(call: Call, reason: EndReason, tell: boolean | "unreachable", report = true): Promise<void> {
    if (call.ended) return;
    call.ended = true;
    call.reason = reason;
    this.disarm(call);
    if (call.watcher) clearInterval(call.watcher);
    this.calls.delete(call.id);
    // A call placed here that the contact never answered: the next one waits a moment (`CALL_PACE_MS`).
    if (call.direction === "out" && call.connectedAt === null && call.state === "ringing" && (reason === "hangup" || reason === "unanswered")) this.unansweredAt.set(call.chat, this.now);
    // The contact's call that ended before it connected, not by this side, after it barely rang (auto-answered or not):
    // the next one that comes right after it is held back (`QUICK_REDIAL_MS`). One that rang a while holds nothing back.
    if (call.direction === "in" && call.connectedAt === null && reason !== "hangup" && reason !== "stopped") {
      if (this.within(call.startedAt, BURST_RING_MS)) this.missedAt.set(call.chat, this.now);
      else this.missedAt.delete(call.chat);
    }
    if (report) process.stderr.write(`ghostly: call ${call.id}: ended (${reason})${call.media ? `, ice ${call.media.ice.state}` : ""}\n`);
    // Whatever the media's close throws, the rest of the end follows: the contact is told, the program reads EOF.
    try { call.media?.close(); } catch (error) { process.stderr.write(`ghostly: call ${call.id}: closing its media failed: ${error instanceof Error ? error.message : String(error)}\n`); }
    // A call that ends ringing (declined, missed, stale) closes the answer it made ahead; one being made, once made.
    this.stopEarly(call);
    call.early?.close();
    call.early = null;
    // The program reads EOF now; one that keeps its side open does not hold the hang-up or call.ended (only a
    // stopping daemon waits for it, below).
    const closing = call.socket?.close();
    if (tell) {
      // A call that failed before it ever connected says so too (`r: "u"`, WISP 601 "Couldn't connect"), as the apps do:
      // a plain hang-up reaches a caller that still rings as a decline.
      const unreachable = tell === "unreachable" || (reason === "failed" && call.connectedAt === null);
      const hangUp: CallSignal = unreachable ? { t: "h", ts: this.stamp(call.chat), r: "u" } : { t: "h", ts: this.stamp(call.chat) };
      await this.send(call.chat, hangUp).catch(() => {});
      if (!this.stopping) {
        const timer = setTimeout(() => {
          this.clearing.delete(call.chat);
          void this.sendRaw(call.chat, null).catch(() => {});
        }, CLEAR_MS);
        timer.unref?.();
        this.clearing.set(call.chat, timer);
      }
    } else if (reason !== "crossed") {
      // Nothing left to say: a signal still waiting for the next session is dropped.
      await this.sendRaw(call.chat, null).catch(() => {});
    }
    if (report) {
      this.host.emit("call.ended", `call.ended:${call.id}`, {
        call: call.id, chat: call.chat, direction: call.direction, reason,
        ...(call.connectedTick !== null ? { duration: Math.round(monotonic() - call.connectedTick) } : {}),
      });
    }
    if (this.stopping) await closing;
  }

  /** Refuses a call placed too soon after this side's last unanswered one in the chat (`CALL_PACE_MS`). */
  private paced(chat: string): void {
    const pace = this.host.callPaceMs ?? CALL_PACE_MS, last = this.unansweredAt.get(chat);
    if (!pace || last === undefined) return;
    if (!this.within(last, pace)) { this.unansweredAt.delete(chat); return; }
    const left = last + pace - this.now;
    throw new CliError("busy", `Your last call in this chat ended unanswered a moment ago: call again in ${Math.ceil(left / 100) / 10} s`, { retryAfterMs: left });
  }

  /** Whether the contact's call coming now in the chat is held back: its last one was missed after it barely rang, or held, a moment ago. */
  private quickRedial(chat: string): boolean {
    const quick = this.host.quickRedialMs ?? QUICK_REDIAL_MS, last = this.missedAt.get(chat);
    return !!quick && last !== undefined && this.within(last, quick);
  }

  /**
   * Whether less than `ms` passed since `at`, on the device's clock (`now`, which the timestamps the contact sees are on).
   * An `at` later than now is the clock set back since: the wait is taken as over, not as lasting as long as the jump.
   */
  private within(at: number, ms: number): boolean {
    const passed = this.now - at;
    return passed >= 0 && passed < ms;
  }

  private arm(call: Call, ms: number, reason: EndReason, tell: boolean): void {
    this.disarm(call);
    call.timer = setTimeout(() => void this.end(call, reason, tell), ms);
    call.timer.unref?.();
  }

  private disarm(call: Call): void {
    if (call.timer) clearTimeout(call.timer);
    call.timer = null;
  }

  private send(chat: string, signal: CallSignal): Promise<void> {
    return this.sendRaw(chat, JSON.stringify(signal));
  }

  private async sendRaw(chat: string, signal: string | null): Promise<void> {
    try {
      await this.host.engine.setCallSignal({ linkId: chat, signal });
    } catch (error) {
      throw new CliError("unavailable", error instanceof Error ? error.message : String(error));
    }
  }

  private async stack(): Promise<CallStack> {
    if (this.host.answers === false) throw new CliError("unavailable", CALLS_NEED_DAEMON);
    const stack = await (this.host.stack ?? loadCallStack)();
    if (typeof stack === "string") throw new CliError("unavailable", stack);
    return stack;
  }

  private audioInfo(call: Call): AudioInfo | null {
    return call.socket ? { socket: call.socket.path, token: call.socket.token, rate: call.rate, channels: 1, format: "s16le", frameMs: FRAME_MS } : null;
  }

  private view(call: Call): Record<string, unknown> {
    const audio = call.media?.audio;
    return {
      call: call.id, chat: call.chat, direction: call.direction, state: call.state, stalled: call.stalledFrom !== null, video: call.video,
      startedAt: call.startedAt, connectedAt: call.connectedAt,
      audio: this.audioInfo(call),
      ...(call.socket ? { stats: { framesIn: audio?.received ?? 0, framesOut: audio?.sent ?? 0, queuedMs: call.queue?.queuedMs ?? 0, programConnected: call.socket.connected, ice: call.media?.ice ?? null } } : {}),
    };
  }

  private byChat(chat: string): Call | undefined {
    for (const call of this.calls.values()) if (call.chat === chat) return call;
    return undefined;
  }

  /** A call by its id, or by its chat; with no ref, the only call (or the only one `prefer` picks). */
  private find(ref: string | undefined, prefer?: (call: Call) => boolean): Call {
    if (ref) {
      const byId = this.calls.get(ref);
      if (byId) return byId;
      const call = this.byChat(this.chatId(ref));
      if (!call) throw new CliError("not_found", `No call in chat ${ref}`);
      return call;
    }
    const all = [...this.calls.values()];
    const picked = prefer && all.filter(prefer).length === 1 ? all.filter(prefer) : all;
    if (picked.length === 1) return picked[0];
    if (!picked.length) throw new CliError("not_found", "No call is on");
    throw new CliError("bad_request", "More than one call is on: name one (its id or its chat)", { calls: picked.map((c) => c.id) });
  }

  private link(chat: string): LinkView | undefined {
    return this.host.engine.getState().links.find((l) => l.id === chat);
  }

  /** A chat by id, contact key, prefix or name (the API's rules, `findChat`); a group's says it is one. */
  private chatId(ref: string): string {
    const { links, groups } = this.host.engine.getState();
    return findChat(links, ref, groups).id;
  }

  /** The chat, if a call can go in it now; else why not (the engine's reason). */
  private callable(ref: string): LinkView {
    const link = this.link(this.chatId(ref))!;
    // A one-shot's chat is not live yet, and never would be in time: it said "Calls need a live connection" before
    // the daemon it needs (`stack`).
    if (this.host.answers === false) throw new CliError("unavailable", CALLS_NEED_DAEMON);
    if (!link.profile) throw new CliError("unavailable", "Calls are in chats made since 0.4 (the chat session): this is a compatibility chat");
    if (link.callsUnavailable) throw new CliError("unavailable", link.callsUnavailable);
    if (this.host.engine.getState().settings?.relayOnly === true) throw new CliError("unavailable", CALLS_OFF_RELAY_ONLY);
    return link;
  }

  private autoFor(chat: string): boolean {
    return this.auto.on && (this.auto.from.length === 0 || this.auto.from.includes(chat));
  }
}

const CALLS_NEED_DAEMON = "Calls need the daemon (a call outlives this command): start it with `ghostly daemon --detach`";
/**
 * Hide my IP from contacts (`relayOnly`, WISP 601 Relay only): libdatachannel's relay policy only keeps the other
 * candidates out of the signal; its ICE still checks from this machine's own sockets, and a call connected on a direct
 * pair in a local lab. So the CLI places and answers no call while it is on, as the apps do with media that cannot keep
 * to the relay.
 */
const CALLS_OFF_RELAY_ONLY = "Calls are off while Hide my IP from contacts is on: this headless Ghostly cannot keep a call to the relay";

function nameOf(link: LinkView): string | null {
  return link.label?.trim() || link.peerNick?.trim() || null;
}

function rateOf(value: unknown, fallback: CallRate): CallRate {
  if (value === undefined || value === null) return fallback;
  if (!isCallRate(value)) throw new CliError("bad_request", "rate must be 8000, 12000, 16000, 24000 or 48000");
  return value;
}

function readAuto(path: string): AutoAnswer {
  const off: AutoAnswer = { on: false, from: [], rate: DEFAULT_RATE };
  if (!existsSync(path)) return off;
  try {
    const saved = (JSON.parse(readFileSync(path, "utf8")) as { autoAnswer?: Partial<AutoAnswer> }).autoAnswer;
    if (!saved) return off;
    return {
      on: saved.on === true,
      from: Array.isArray(saved.from) ? saved.from.filter((c): c is string => typeof c === "string") : [],
      rate: isCallRate(saved.rate) ? saved.rate : DEFAULT_RATE,
    };
  } catch {
    return off;
  }
}
