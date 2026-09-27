import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCallSignal, signalHasVideo, CALL_SIGNAL_MAX_AGE_MS, type CallSignal } from "@ghostly/core";
import type { EngineState, LinkView } from "@ghostly/browser/shared/types";
import { CliError } from "../errors";
import { AudioSocket, audioSocketPath } from "./audioSocket";
import { CallMedia, loadCallStack, type CallStack } from "./media";
import { DEFAULT_RATE, FRAME_MS, isCallRate, PlaybackQueue, type CallRate } from "./pcm";

/**
 * Voice calls on the headless Ghostly (WISP 11xx § Calls): the calls/1 signals of the chat session (WISP 601), the
 * media on a WebRTC connection of the CLI's own, and the audio handed to an outside program over a Unix socket per
 * call. The rules are the apps' (packages/react/src/useWebRTC.ts): a call per chat; an offer rings while this side
 * is idle; an answer counts only after this side's offer; a hang-up ends whatever is on; a signal older than the
 * last one handled is ignored; after a hang-up the signal is cleared 5 s later.
 */

export type CallState = "ringing" | "connecting" | "connected";
export type EndReason = "hangup" | "remote-hangup" | "missed" | "rejected" | "unanswered" | "failed" | "stopped";

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
}

/** The audio contract of one call, as commands and events report it. */
export interface AudioInfo { socket: string; rate: CallRate; channels: 1; format: "s16le"; frameMs: typeof FRAME_MS }

/** An outgoing call rings this long, then ends as `unanswered`. */
export const RING_MS = 60_000;
/** An answered or accepted call has this long to connect its media, then ends as `failed`. */
export const CONNECT_MS = 30_000;
/** How long a call whose media closed or failed waits for the contact's hang-up signal to say why. */
export const MEDIA_GRACE_MS = 3_000;
/** After a hang-up, the signal is cleared this much later (the apps' own delay). */
export const CLEAR_MS = 5_000;

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
  media: CallMedia | null;
  socket: AudioSocket | null;
  /** What the program wrote and the call has not sent yet: kept from the moment the socket opens. */
  queue: PlaybackQueue | null;
  startedAt: number;
  connectedAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  ended: boolean;
}

/** Auto-answer, kept in the profile's `calls.json`: every chat, or the listed ones, at a rate. */
export interface AutoAnswer { on: boolean; from: string[]; rate: CallRate }

export class CallManager {
  private readonly calls = new Map<string, Call>();
  /** Per chat: the timestamp of the last signal handled. */
  private readonly lastSignal = new Map<string, number>();
  /** Per chat: the timer that clears the hang-up signal. */
  private readonly clearing = new Map<string, ReturnType<typeof setTimeout>>();
  private auto: AutoAnswer;
  private readonly configPath: string;
  private stopping = false;

  constructor(private readonly host: CallHost) {
    this.configPath = join(host.profileDir, "calls.json");
    this.auto = readAuto(this.configPath);
  }

  private get now(): number { return (this.host.now ?? Date.now)(); }

  // ---------- signals from the contact ----------

  /** A signal the contact's app sent in a chat (the engine's `call-signal`). */
  onSignal(chat: string, json: string): void {
    const signal = parseCallSignal(json, this.now);
    if (!signal) return;
    if (signal.ts <= (this.lastSignal.get(chat) ?? 0)) return;
    const call = this.byChat(chat);
    // A connected call only hears a hang-up (and picture changes, which are no business of an audio-only side).
    if (call?.state === "connected" && signal.t !== "h" && signal.t !== "v") return;
    if (signal.t === "o" && !call) {
      this.lastSignal.set(chat, signal.ts);
      this.incoming(chat, signal);
    } else if (signal.t === "a" && call?.direction === "out" && call.state === "ringing" && signal.ts > call.offerTs) {
      this.lastSignal.set(chat, signal.ts);
      this.accepted(call, signal);
    } else if (signal.t === "v") {
      this.lastSignal.set(chat, signal.ts);
    } else if (signal.t === "h") {
      this.lastSignal.set(chat, signal.ts);
      if (call) {
        const reason: EndReason = call.state === "ringing" ? (call.direction === "in" ? "missed" : "rejected") : "remote-hangup";
        void this.end(call, reason, false);
      }
    }
  }

  private incoming(chat: string, offer: CallSignal): void {
    const link = this.link(chat);
    const call = this.add(chat, "in", this.auto.rate);
    call.offer = offer;
    call.video = signalHasVideo(offer);
    // Unanswered, an offer goes stale: the contact's app has given up or will, and answering it would be refused.
    this.arm(call, Math.max(1000, offer.ts + CALL_SIGNAL_MAX_AGE_MS - this.now), "missed", false);
    this.host.emit("call.incoming", `call.incoming:${call.id}`, { call: call.id, chat, name: link ? nameOf(link) : null, video: call.video, auto: this.autoFor(chat) });
    if (this.host.answers !== false && this.autoFor(chat)) {
      void this.answer(call.id, {}).catch((error) => process.stderr.write(`ghostly: auto-answer failed: ${error instanceof Error ? error.message : String(error)}\n`));
    }
  }

  private accepted(call: Call, answer: CallSignal): void {
    try {
      call.media!.applyAnswer(answer);
    } catch (error) {
      process.stderr.write(`ghostly: call ${call.id}: the answer was refused (${error instanceof Error ? error.message : String(error)})\n`);
      void this.end(call, "failed", true);
      return;
    }
    call.state = "connecting";
    this.arm(call, CONNECT_MS, "failed", true);
  }

  // ---------- commands ----------

  async start(chat: string, options: { rate?: unknown }): Promise<Record<string, unknown>> {
    const link = this.callable(chat);
    if (this.byChat(link.id)) throw new CliError("busy", "A call is already on in this chat");
    const rate = rateOf(options.rate, this.auto.rate);
    const stack = await this.stack();
    const call = this.add(link.id, "out", rate);
    try {
      await this.attach(call, (media) => CallMedia.offer(stack, media));
      if (call.ended) throw new CliError("unavailable", "The call ended before it was placed");
      call.offerTs = this.now;
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
    // Answered: no longer missed if it goes stale; the media has its own time to connect.
    call.state = "connecting";
    this.disarm(call);
    try {
      await this.attach(call, (media) => CallMedia.answer(stack, call.offer!, media));
      if (call.ended) throw new CliError("unavailable", "The call ended before it was answered");
      await this.send(call.chat, { t: "a", ts: this.now, ...call.media!.local, v: 0 });
    } catch (error) {
      await this.end(call, "failed", true, false);
      throw error;
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
    const from = (next.from ?? []).map((ref) => this.chatId(ref));
    this.auto = { on: next.on, from: next.on ? from : [], rate: rateOf(next.rate, next.on ? this.auto.rate : DEFAULT_RATE) };
    const tmp = `${this.configPath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ autoAnswer: this.auto }, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.configPath);
    return this.getAuto();
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
      media: null, socket: null, queue: null, startedAt: this.now, connectedAt: null, timer: null, ended: false,
    };
    this.calls.set(call.id, call);
    return call;
  }

  /** The call's socket (open from now on: a program may connect before the media is up) and its media. */
  private async attach(call: Call, create: (options: Parameters<typeof CallMedia.offer>[1]) => Promise<CallMedia>): Promise<void> {
    const queue = (call.queue = new PlaybackQueue(call.rate));
    call.socket = await AudioSocket.open(audioSocketPath(this.host.profileDir, call.id), call.rate, {
      onAudio: (chunk) => queue.push(chunk),
    });
    call.media = await create({
      rate: call.rate,
      queue,
      log: (line) => process.stderr.write(`ghostly: call ${call.id}: ${line}\n`),
      iceServers: this.host.engine.getState().settings?.iceServers ?? [],
      onFrame: (frame) => call.socket?.write(frame),
      onState: (state) => {
        if (call.ended) return;
        if (state === "connected") { this.connected(call); return; }
        // The contact's app closes its connection as it hangs up, and that is often here before its hang-up signal
        // (which crosses the chat session): the signal gets a moment to say so. Without one, a connection the
        // contact closed was still a hang-up; one that failed ends the call as it does in the apps, with nothing to say.
        this.arm(call, MEDIA_GRACE_MS, state === "closed" ? "remote-hangup" : "failed", false);
      },
    });
  }

  private connected(call: Call): void {
    if (call.state === "connected") return;
    call.state = "connected";
    call.connectedAt = this.now;
    this.disarm(call);
    this.host.emit("call.connected", `call.connected:${call.id}`, { call: call.id, chat: call.chat, direction: call.direction, audio: this.audioInfo(call) });
  }

  private async end(call: Call, reason: EndReason, tell: boolean, report = true): Promise<void> {
    if (call.ended) return;
    call.ended = true;
    this.disarm(call);
    this.calls.delete(call.id);
    if (report) process.stderr.write(`ghostly: call ${call.id}: ended (${reason})${call.media ? `, ice ${call.media.ice.state}` : ""}\n`);
    call.media?.close();
    await call.socket?.close();
    if (tell) {
      await this.send(call.chat, { t: "h", ts: this.now }).catch(() => {});
      if (!this.stopping) {
        const timer = setTimeout(() => {
          this.clearing.delete(call.chat);
          void this.sendRaw(call.chat, null).catch(() => {});
        }, CLEAR_MS);
        timer.unref?.();
        this.clearing.set(call.chat, timer);
      }
    } else {
      // Nothing left to say: a signal still waiting for the next session is dropped.
      await this.sendRaw(call.chat, null).catch(() => {});
    }
    if (report) {
      this.host.emit("call.ended", `call.ended:${call.id}`, {
        call: call.id, chat: call.chat, direction: call.direction, reason,
        ...(call.connectedAt !== null ? { duration: this.now - call.connectedAt } : {}),
      });
    }
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
    if (this.host.answers === false) throw new CliError("unavailable", "Calls need the daemon (a call outlives this command): start it with `ghostly daemon --detach`");
    const stack = await (this.host.stack ?? loadCallStack)();
    if (typeof stack === "string") throw new CliError("unavailable", stack);
    return stack;
  }

  private audioInfo(call: Call): AudioInfo | null {
    return call.socket ? { socket: call.socket.path, rate: call.rate, channels: 1, format: "s16le", frameMs: FRAME_MS } : null;
  }

  private view(call: Call): Record<string, unknown> {
    const audio = call.media?.audio;
    return {
      call: call.id, chat: call.chat, direction: call.direction, state: call.state, video: call.video,
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

  /** A chat by id, prefix or name (the API's rules). */
  private chatId(ref: string): string {
    const links = this.host.engine.getState().links;
    const exact = links.find((l) => l.id === ref);
    if (exact) return exact.id;
    const byPrefix = links.filter((l) => l.id.startsWith(ref));
    if (byPrefix.length === 1) return byPrefix[0].id;
    const lower = ref.toLowerCase();
    const byName = links.filter((l) => [l.label, l.peerNick].some((n) => n?.trim().toLowerCase() === lower));
    if (byName.length === 1) return byName[0].id;
    throw new CliError(byPrefix.length + byName.length > 1 ? "bad_request" : "not_found", byPrefix.length + byName.length > 1 ? `${JSON.stringify(ref)} names more than one chat: use its id` : `No chat ${JSON.stringify(ref)}`);
  }

  /** The chat, if a call can go in it now; else why not (the engine's reason). */
  private callable(ref: string): LinkView {
    const link = this.link(this.chatId(ref))!;
    if (!link.profile) throw new CliError("unavailable", "Calls are in chats made since 0.4 (the chat session): this is a compatibility chat");
    if (link.callsUnavailable) throw new CliError("unavailable", link.callsUnavailable);
    return link;
  }

  private autoFor(chat: string): boolean {
    return this.auto.on && (this.auto.from.length === 0 || this.auto.from.includes(chat));
  }
}

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
