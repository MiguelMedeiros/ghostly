/**
 * The mini-app broker on the web (WISP 1200, "The runner and the broker"): what an app in the runner's sandbox
 * (apps/web/public/app-frame.html) may ask the client for, and nothing more.
 *
 * - The app is known by its port: one MessageChannel per app instance, handed to the frame once, after its first
 *   `load`. Nothing an app sends names it; extra fields in a request are never read.
 * - The frame loads twice: the runner, then the app the runner writes into itself after `writing`. Any other load is a
 *   navigation, and tears the app down.
 * - Requests are `{id, type, args}`, at most 64 KiB as JSON and 50 a second; answers `{id, ok, value | error}`; events
 *   `{event, data}`. An unknown type is refused. An app that sends ten times the rate is stopped. `file` and
 *   `files.read` answer at most 16 MiB a second together, one read at a time.
 * - `files.*` (WISP 1200 · Linked files) only for an app granted `files`, through the platform's `linkedFiles`: the client
 *   asks the person and keeps the links; the app names only the ids it was given.
 *
 * `createBroker` is the protocol alone (tested without a browser); `startApp` frames it in a page.
 */
import type { AppFileAt } from "@ghostly/browser/engine/apps";
import { MINI_APP_LIMITS, type MiniAppContext, type MiniAppErrorCode, type MiniAppJson, type MiniAppPeerEvent, type MiniAppRequestType } from "@ghostly/core/miniApp";
import type { AppsPlatform } from "../platform";

/** An app to run: its checked entry (the engine's `appEntry`), what the person granted it, and where it opens. */
export interface AppLaunch {
  /** `<publisher key in z-base32>/<name>`. */
  ref: string;
  /** The digest of the version it runs (the entry's): what the engine judges while it runs. */
  digest: string;
  version: string;
  title: string;
  /** What the person granted at install: `chat`, `name`. */
  permissions: readonly string[];
  /** The bundle's entry HTML, as the engine checked it. */
  entry: string;
  /** The 1:1 chat it is opened in (its link id, and the person's name there), or null when it is opened alone. */
  chat: { linkId: string; name?: string } | null;
}

/** What the app sees of the client: read when it asks, so a change of theme or language shows on its next `context`. */
export interface AppView {
  theme(): "light" | "dark";
  locale(): string;
}

/**
 * Why an app stopped: it asked (`closed`), its frame loaded when it should not have (`navigated`), it broke the
 * protocol before it started or sent far past the request rate (`protocol`), it never started (`timeout`), or the
 * client stopped it (`stopped`).
 */
export type AppStopReason = "closed" | "navigated" | "protocol" | "timeout" | "stopped";

export type AppPhase = "loading" | "starting" | "writing" | "running" | "stopped";

/** Every request type the broker answers: the whole `ghostly.*` API (WISP 1200). */
export const BROKER_REQUESTS: readonly MiniAppRequestType[] = [
  "context", "file", "storage.get", "storage.set", "storage.delete", "storage.keys", "chat.send", "files.pick", "files.list", "files.read", "files.forget", "close",
];

/** How long the runner has to say `writing` once it has the port. */
export const START_TIMEOUT_MS = 15_000;

/**
 * How many messages in one second stop the app: ten times the rate. Past the rate a request is refused, yet the page
 * still receives it; only closing the port ends that, and an app this far over is not one that miscounted.
 */
export const STOP_REQUESTS_PER_SECOND = 10 * MINI_APP_LIMITS.requestsPerSecond;

/** The deepest JSON a request may carry: a value deeper than this is refused rather than walked. */
const MAX_DEPTH = 64;

interface BrokerOptions {
  host: AppsPlatform;
  launch: AppLaunch;
  view: AppView;
  /** Posts to the app's port. */
  post(message: unknown, transfer?: Transferable[]): void;
  /** Tears the frame down: called once, with why. */
  stopped(reason: AppStopReason): void;
  /**
   * The opener hands a file's bytes to the app itself (Desktop: Rust, from its own file storage): a `file` answer says
   * where they lie (`{id, ok, file: AppFileAt}`) when the host can, instead of carrying them. Every check is the same.
   */
  byReference?: boolean;
  now?: () => number;
}

export interface Broker {
  readonly phase: AppPhase;
  /** The frame's `load`. */
  load(): void;
  /** A message on the app's port. */
  message(data: unknown): void;
  /** Stops the app from outside (the person closed it, or the chat went away). */
  stop(reason?: AppStopReason): void;
}

const encoder = new TextEncoder();
const utf8Bytes = (text: string) => encoder.encode(text).byteLength;

/** Whether `value` is plain JSON (what a request may carry), no deeper than MAX_DEPTH. */
export function isJsonValue(value: unknown, depth = 0): value is MiniAppJson {
  if (depth > MAX_DEPTH) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

const NOT_JSON: unique symbol = Symbol("not JSON");

/**
 * A request's value as JSON.stringify writes it (WISP 1200 § The app API): an object member that is `undefined` is left
 * out, and `undefined` in an array is null; anything else that is not plain JSON (a function, a Map, a Date, a number
 * that is not finite, a value deeper than MAX_DEPTH) makes it NOT_JSON. Apps written in JavaScript spread records with
 * `field: undefined` all the time; refusing those refused Chess's every move.
 */
export function jsonValueOf(value: unknown, depth = 0): MiniAppJson | typeof NOT_JSON {
  if (depth > MAX_DEPTH) return NOT_JSON;
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : NOT_JSON;
  if (Array.isArray(value)) {
    const out: MiniAppJson[] = [];
    for (const item of value) {
      const next = item === undefined ? null : jsonValueOf(item, depth + 1);
      if (next === NOT_JSON) return NOT_JSON;
      out.push(next);
    }
    return out;
  }
  if (typeof value !== "object") return NOT_JSON;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return NOT_JSON;
  const out: Record<string, MiniAppJson> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const next = jsonValueOf(item, depth + 1);
    if (next === NOT_JSON) return NOT_JSON;
    // Defined, not assigned: a member named `__proto__` (a word a person typed) is kept as JSON.stringify keeps it,
    // where an assignment would set the copy's prototype and lose it.
    Object.defineProperty(out, key, { value: next, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/**
 * At least how many bytes `value` takes as JSON, counted only until it passes `budget`: a string by its length (UTF-8
 * and escapes only add), anything else by its fewest. Binary data (an ArrayBuffer or a view on one) and a value too
 * deep are NOT_JSON. It looks at no more than `budget` members, so a request far over 64 KiB is refused
 * without JSON.stringify writing it whole: a 16 MiB Uint8Array took that 1.6 s on the page's thread.
 */
function jsonBytesAtLeast(value: unknown, budget: number): number | typeof NOT_JSON {
  let bytes = 0;
  const walk = (item: unknown, depth: number): boolean => {
    // MAX_DEPTH within the args, one level below the request.
    if (depth > MAX_DEPTH + 1 || item instanceof ArrayBuffer || ArrayBuffer.isView(item)) return false;
    if (typeof item === "string") bytes += item.length + 2;
    else if (Array.isArray(item)) {
      bytes += item.length + 1;
      for (let i = 0; i < item.length && bytes <= budget; i++) if (!walk(item[i], depth + 1)) return false;
    } else if (item !== null && typeof item === "object") {
      bytes += 2;
      for (const key in item) {
        if (bytes > budget) break;
        const member = (item as Record<string, unknown>)[key];
        if (!Object.prototype.hasOwnProperty.call(item, key) || member === undefined) continue;
        bytes += key.length + 2;
        if (!walk(member, depth + 1)) return false;
      }
    } else bytes += 1;
    return true;
  };
  return walk(value, 0) ? bytes : NOT_JSON;
}

class Refusal extends Error { declare message: MiniAppErrorCode }
const refuse = (code: MiniAppErrorCode): never => { throw new Refusal(code); };

/**
 * The engine's refusals an app is told by their code (its errors cross the RPC as "<code>: words", engine/apps.ts):
 * `full` (its storage in this scope holds 5 MiB), `no-file` (no such file in its bundle), `stopped` (a store removed
 * or its publisher revoked the version running, WISP 1200 § Takedowns), and the bounds the broker checks too. Any other failure is `failed`, without the words.
 */
const ENGINE_REFUSALS: ReadonlySet<string> = new Set<MiniAppErrorCode>(["full", "no-file", "too-large", "bad-key", "stopped", "cancelled", "changed", "gone"]);

function refusalOf(error: unknown): MiniAppErrorCode {
  if (error instanceof Refusal) return error.message;
  const code = error instanceof Error ? /^([a-z][a-z-]*): /.exec(error.message)?.[1] : undefined;
  return code && ENGINE_REFUSALS.has(code) ? code as MiniAppErrorCode : "failed";
}

/** A linked file's id, as the client gives them: 22 base64url characters. */
const LINK_ID = /^[A-Za-z0-9_-]{22}$/;
const EXTENSION = /^[a-z0-9]{1,16}$/;

/** `files.pick`'s options, or a refusal: `{folder?, accept?}` and nothing else that matters. */
function pickOptions(value: unknown): { folder: boolean; accept: string[] } {
  if (value === undefined || value === null) return { folder: false, accept: [] };
  if (typeof value !== "object" || Array.isArray(value)) return refuse("bad-request");
  const { folder, accept } = value as { folder?: unknown; accept?: unknown };
  if (folder !== undefined && typeof folder !== "boolean") refuse("bad-request");
  if (accept !== undefined && (!Array.isArray(accept) || accept.length > MINI_APP_LIMITS.filesAccept || !accept.every((e) => typeof e === "string" && EXTENSION.test(e)))) refuse("bad-request");
  return { folder: folder === true, accept: [...new Set((accept as string[] | undefined) ?? [])] };
}

/** `files.read`'s range: whole numbers, an offset within a safe integer, a length of 1 to `filesReadBytes`. */
function readRange(value: unknown): { offset: number; length: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return refuse("bad-request");
  const { offset, length } = value as { offset?: unknown; length?: unknown };
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) refuse("bad-request");
  if (!Number.isSafeInteger(length) || (length as number) < 1) refuse("bad-request");
  if ((length as number) > MINI_APP_LIMITS.filesReadBytes) refuse("too-large");
  return { offset: offset as number, length: length as number };
}

function storageKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || utf8Bytes(value) > MINI_APP_LIMITS.storageKeyBytes) refuse("bad-key");
  return value as string;
}

export function createBroker({ host: platform, launch, view, post, stopped, byReference = false, now = Date.now }: BrokerOptions): Broker {
  const host = platform.running?.(launch.digest) ?? platform;
  let phase: AppPhase = "loading";
  const recent: number[] = [];
  /** The `file` answers of the last second (when, how many bytes) and their sum: what `fileBytesPerSecond` counts. */
  const served: { at: number; bytes: number }[] = [];
  let servedBytes = 0;
  /** The `file` read in progress: reads go one at a time, so each is counted before the next one starts. */
  let reading: Promise<unknown> = Promise.resolve();
  const scope = launch.chat?.linkId ?? "alone";
  const chatAllowed = !!launch.chat && launch.permissions.includes("chat");
  /** Linked files: only for an app granted `files`, in a client that keeps them. Not a version's: the outer platform's. */
  const linkedFiles = () => (launch.permissions.includes("files") ? platform.linkedFiles ?? null : null);
  /** A pick waiting for the person: one at a time per app. */
  let picking = false;
  let appId: string | null = null;
  let chatOpened = false;
  let peer: { version: string } | null = null;
  let unsubscribe: (() => void) | null = null;
  /** Settles once the chat open has answered (the chat app id, the contact's side as last heard): `context` waits for it. */
  let opened: Promise<void> = Promise.resolve();

  const event = (name: "chat.message" | "chat.peer", data: MiniAppJson | MiniAppPeerEvent) => {
    if (phase === "writing" || phase === "running") post({ event: name, data });
  };

  const openChat = () => {
    if (!chatAllowed || !launch.chat) return;
    const { linkId } = launch.chat;
    unsubscribe = host.chat.onFrame((frameLink, frame) => {
      if (frameLink !== linkId || appId === null || frame.app !== appId) return;
      if ("d" in frame) { if (peer) event("chat.message", frame.d as MiniAppJson); return; }
      if (frame.o === "open") { peer = { version: frame.v }; event("chat.peer", { open: true, version: frame.v }); }
      else { peer = null; event("chat.peer", { open: false }); }
    });
    chatOpened = true;
    opened = host.chat.open(linkId, launch.ref, launch.version).then(({ app }) => {
      if (phase === "stopped") return;
      appId = app;
      peer = host.chat.peer(linkId, app);
      if (peer) event("chat.peer", { open: true, version: peer.version });
    }, () => { /* the chat cannot run apps: chat.send says why */ });
  };

  const stop = (reason: AppStopReason = "stopped") => {
    if (phase === "stopped") return;
    phase = "stopped";
    unsubscribe?.();
    unsubscribe = null;
    if (chatOpened && launch.chat) void host.chat.close(launch.chat.linkId, launch.ref).catch(() => {});
    stopped(reason);
  };

  /**
   * Counted against `fileBytesPerSecond` with every other read, one at a time: `file` and `files.read` share the
   * chain, so an app cannot double its bytes a second by mixing them.
   */
  const counted = (load: () => Promise<Uint8Array>): Promise<Uint8Array> => {
    const read = reading.then(async () => {
      if (phase === "stopped") refuse("stopped");
      const at = now();
      while (served.length && served[0]!.at <= at - 1000) servedBytes -= served.shift()!.bytes;
      if (servedBytes >= MINI_APP_LIMITS.fileBytesPerSecond) refuse("too-fast");
      const bytes = await load();
      served.push({ at, bytes: bytes.byteLength });
      servedBytes += bytes.byteLength;
      return bytes;
    });
    reading = read.catch(() => {});
    return read;
  };

  const answer = async (type: string, args: unknown[]): Promise<{ value?: MiniAppJson | ArrayBuffer; transfer?: Transferable[]; file?: AppFileAt }> => {
    switch (type as MiniAppRequestType) {
      case "context": {
        // After the chat open answered: before it, a contact whose app is already open would read as not open, and the
        // event saying it is open could reach the app before it listens.
        await opened;
        const context: MiniAppContext = { version: launch.version, inChat: !!launch.chat, peer: chatAllowed ? peer : null, theme: view.theme(), locale: view.locale() };
        if (launch.chat?.name !== undefined && launch.permissions.includes("name")) context.name = launch.chat.name;
        return { value: context as unknown as MiniAppJson };
      }
      case "file": {
        const path = args[0];
        if (typeof path !== "string" || path.length === 0 || path.length > 1024) refuse("bad-path");
        // Bounded in bytes too: 50 reads a second of a 16 MiB file made the page copy 800 MB a second.
        const read = reading.then(async () => {
          if (phase === "stopped") refuse("stopped");
          const at = now();
          while (served.length && served[0]!.at <= at - 1000) servedBytes -= served.shift()!.bytes;
          if (servedBytes >= MINI_APP_LIMITS.fileBytesPerSecond) refuse("too-fast");
          const where = byReference && host.fileAt ? await host.fileAt(launch.ref, path as string) : null;
          const file = where ?? await host.file(launch.ref, path as string);
          const size = where ? where.length : (file as Uint8Array).byteLength;
          served.push({ at, bytes: size });
          servedBytes += size;
          return file;
        });
        reading = read.catch(() => {});
        const got = await read;
        if (!(got instanceof Uint8Array)) return { file: got };
        const bytes = got;
        // The host's copy is the caller's (AppsPlatform.file): handed over as it is when it is the whole buffer, where
        // copying it again doubled what a read cost the page.
        const whole = bytes.byteOffset === 0 && bytes.buffer instanceof ArrayBuffer && bytes.byteLength === bytes.buffer.byteLength;
        const buffer = whole ? bytes.buffer as ArrayBuffer : bytes.slice().buffer as ArrayBuffer;
        return { value: buffer, transfer: [buffer] };
      }
      case "storage.get": {
        const found = await host.storage.get(launch.ref, scope, storageKey(args[0]));
        return found ? { value: found.value } : {};
      }
      case "storage.set": {
        const key = storageKey(args[0]);
        const value = args[1];
        if (!isJsonValue(value) || utf8Bytes(JSON.stringify(value)) > MINI_APP_LIMITS.storageValueBytes) refuse("too-large");
        await host.storage.set(launch.ref, scope, key, value as MiniAppJson);
        return {};
      }
      case "storage.delete":
        await host.storage.delete(launch.ref, scope, storageKey(args[0]));
        return {};
      case "storage.keys":
        return { value: await host.storage.keys(launch.ref, scope) };
      case "chat.send": {
        if (!chatAllowed || !launch.chat) refuse("not-allowed");
        if (args.length !== 1 || utf8Bytes(JSON.stringify(args[0])) > MINI_APP_LIMITS.chatDataBytes) refuse("too-large");
        const error = await host.chat.send(launch.chat!.linkId, launch.ref, args[0] as MiniAppJson);
        if (error) refuse(error);
        return {};
      }
      case "files.pick": {
        const files = linkedFiles();
        if (!files) return refuse("not-allowed");
        const options = pickOptions(args[0]);
        if (picking) refuse("too-fast");
        picking = true;
        try {
          return { value: await files.pick(launch.ref, launch.title, options) as unknown as MiniAppJson };
        } finally {
          picking = false;
        }
      }
      case "files.list": {
        const files = linkedFiles();
        if (!files) return refuse("not-allowed");
        return { value: await files.list(launch.ref, launch.title) as unknown as MiniAppJson };
      }
      case "files.read": {
        const files = linkedFiles();
        if (!files) return refuse("not-allowed");
        const id = args[0];
        if (typeof id !== "string" || !LINK_ID.test(id)) refuse("bad-request");
        const { offset, length } = readRange(args[1]);
        const bytes = await counted(() => files.read(launch.ref, id as string, offset, length));
        if (bytes.byteLength > length) refuse("failed");
        const buffer = bytes.slice().buffer as ArrayBuffer;
        return { value: buffer, transfer: [buffer] };
      }
      case "files.forget": {
        const files = linkedFiles();
        if (!files) return refuse("not-allowed");
        const id = args[0];
        if (typeof id !== "string" || (id !== "all" && !LINK_ID.test(id))) refuse("bad-request");
        await files.forget(launch.ref, id as string);
        return {};
      }
      default:
        return refuse("unknown-type");
    }
  };

  const message = (data: unknown) => {
    if (phase === "stopped" || phase === "loading") return;
    if (phase === "starting") {
      // The runner's one word before the app, exactly: anything else first is not the runner.
      const first = data as { id?: unknown; type?: unknown; args?: unknown } | null;
      if (!first || typeof first !== "object" || first.type !== "writing" || !Number.isSafeInteger(first.id) || !Array.isArray(first.args) || first.args.length !== 0) return stop("protocol");
      recent.push(now());
      phase = "writing";
      openChat();
      post({ id: first.id, ok: true });
      return;
    }
    // The rate counts every message, malformed ones too.
    const at = now();
    recent.push(at);
    while (recent.length && recent[0]! <= at - 1000) recent.shift();
    // Before anything of the message is read: stopping closes the port, so `recent` never holds more than this.
    if (recent.length > STOP_REQUESTS_PER_SECOND) return stop("protocol");

    const id = data && typeof data === "object" && Number.isSafeInteger((data as { id?: unknown }).id) && (data as { id: number }).id >= 0 ? (data as { id: number }).id : null;
    const fail = (error: MiniAppErrorCode) => { if (id !== null) post({ id, ok: false, error }); };
    if (recent.length > MINI_APP_LIMITS.requestsPerSecond) return fail("too-fast");
    // A bounded count first: what passes it is small enough to write as JSON and measure exactly.
    const least = jsonBytesAtLeast(data, MINI_APP_LIMITS.requestBytes);
    if (least === NOT_JSON) return fail("bad-request");
    if (least > MINI_APP_LIMITS.requestBytes) return fail("too-large");
    let text: string;
    try { text = JSON.stringify(data) ?? ""; } catch { return fail("bad-request"); }
    if (utf8Bytes(text) > MINI_APP_LIMITS.requestBytes) return fail("too-large");
    const { type, args: raw } = data as { type?: unknown; args?: unknown };
    // The arguments as JSON writes them: undefined members left out (jsonValueOf), anything else not JSON refused.
    const args = Array.isArray(raw) ? jsonValueOf(raw) : NOT_JSON;
    if (id === null || typeof type !== "string" || !Array.isArray(args)) return fail("bad-request");

    if (type === "writing") return stop("protocol");
    if (type === "close") {
      post({ id, ok: true });
      return stop("closed");
    }

    answer(type, args).then(({ value, transfer, file }) => {
      if (phase === "stopped") return;
      if (file) return post({ id, ok: true, file });
      post(value === undefined ? { id, ok: true } : { id, ok: true, value }, transfer);
    }, (error: unknown) => {
      if (phase === "stopped") return;
      fail(refusalOf(error));
    });
  };

  return {
    get phase() { return phase; },
    load() {
      if (phase === "loading") { phase = "starting"; return; }
      if (phase === "writing") { phase = "running"; return; }
      stop("navigated");
    },
    message,
    stop,
  };
}

/**
 * The runner an app runs in, from what the person granted (`launch.permissions`, the engine's record), never from what
 * the app says: the network runner only for `internet`. Throws where this client has no network runner.
 */
export function runnerFor(host: AppsPlatform, launch: Pick<AppLaunch, "permissions">): string {
  if (!launch.permissions.includes("internet")) return host.runnerUrl;
  if (!host.netRunnerUrl) throw new Error("Apps with internet access cannot run in this app");
  return host.netRunnerUrl;
}

export interface RunningApp {
  readonly frame: HTMLIFrameElement;
  readonly phase: AppPhase;
  stop(): void;
}

/**
 * Runs an app in a sandboxed frame of the runner, inside `container`: the frame, its one port, the start and the
 * teardown. The frame is removed when the app stops, for whatever reason.
 */
export function startApp({ container, host, launch, view, onStop, startTimeoutMs = START_TIMEOUT_MS }: {
  container: HTMLElement;
  host: AppsPlatform;
  launch: AppLaunch;
  view: AppView;
  onStop?: (reason: AppStopReason) => void;
  startTimeoutMs?: number;
}): RunningApp {
  const runner = runnerFor(host, launch);
  const frame = document.createElement("iframe");
  // Scripts, and the pointer for mouse look (Esc always gives it back): nothing else of what a page may do.
  frame.setAttribute("sandbox", "allow-scripts allow-pointer-lock");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("allow", "");
  frame.title = launch.title;
  let port: MessagePort | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const broker = createBroker({
    host, launch, view,
    post: (message, transfer) => { try { port?.postMessage(message, transfer ?? []); } catch { /* closed */ } },
    stopped: (reason) => {
      if (timer) clearTimeout(timer);
      frame.removeEventListener("load", loaded);
      port?.close();
      port = null;
      frame.remove();
      onStop?.(reason);
    },
  });

  function loaded() {
    broker.load();
    if (broker.phase === "running" && timer) { clearTimeout(timer); timer = null; }
    if (broker.phase !== "starting" || port) return;
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = (event) => broker.message(event.data);
    port.onmessageerror = () => broker.message(null);
    frame.contentWindow?.postMessage({ ghostly: "port" }, "*", [channel.port2]);
    port.postMessage({ event: "start", data: launch.entry });
    timer = setTimeout(() => { if (broker.phase === "starting" || broker.phase === "writing") broker.stop("timeout"); }, startTimeoutMs);
  }

  frame.addEventListener("load", loaded);
  frame.src = runner;
  container.appendChild(frame);
  return {
    frame,
    get phase() { return broker.phase; },
    stop: () => broker.stop("stopped"),
  };
}
