/**
 * The mini-app broker on the web (WISP 1200, "The runner and the broker"): what an app in the runner's sandbox
 * (apps/web/public/app-frame.html) may ask the client for, and nothing more.
 *
 * - The app is known by its port: one MessageChannel per app instance, handed to the frame once, after its first
 *   `load`. Nothing an app sends names it; extra fields in a request are never read.
 * - The frame loads twice: the runner, then the app the runner writes into itself after `writing`. Any other load is a
 *   navigation, and tears the app down.
 * - Requests are `{id, type, args}`, at most 64 KiB as JSON and 50 a second; answers `{id, ok, value | error}`; events
 *   `{event, data}`. An unknown type is refused.
 *
 * `createBroker` is the protocol alone (tested without a browser); `startApp` frames it in a page.
 */
import { MINI_APP_LIMITS, type MiniAppContext, type MiniAppJson, type MiniAppPeerEvent, type MiniAppRequestType } from "@ghostly/core/miniApp";
import type { AppsPlatform } from "../platform";

/** An app to run: its checked entry (the engine's `appEntry`), what the person granted it, and where it opens. */
export interface AppLaunch {
  /** `<publisher key in z-base32>/<name>`. */
  ref: string;
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
 * protocol before it started (`protocol`), it never started (`timeout`), or the client stopped it (`stopped`).
 */
export type AppStopReason = "closed" | "navigated" | "protocol" | "timeout" | "stopped";

export type AppPhase = "loading" | "starting" | "writing" | "running" | "stopped";

/** Every request type the broker answers: the whole `ghostly.*` API (WISP 1200). */
export const BROKER_REQUESTS: readonly MiniAppRequestType[] = ["context", "file", "storage.get", "storage.set", "storage.delete", "storage.keys", "chat.send", "close"];

/** How long the runner has to say `writing` once it has the port. */
export const START_TIMEOUT_MS = 15_000;

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
    out[key] = next;
  }
  return out;
}

class Refusal extends Error {}
const refuse = (code: string): never => { throw new Refusal(code); };

/**
 * The engine's refusals an app is told by their code (its errors cross the RPC as "<code>: words", engine/apps.ts):
 * `full` (its storage in this scope holds 5 MiB), `no-file` (no such file in its bundle), and the bounds the broker
 * checks too. Any other failure is `failed`, without the words.
 */
const ENGINE_REFUSALS: ReadonlySet<string> = new Set(["full", "no-file", "too-large", "bad-key"]);

function refusalOf(error: unknown): string {
  if (error instanceof Refusal) return error.message;
  const code = error instanceof Error ? /^([a-z][a-z-]*): /.exec(error.message)?.[1] : undefined;
  return code && ENGINE_REFUSALS.has(code) ? code : "failed";
}

function storageKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || utf8Bytes(value) > MINI_APP_LIMITS.storageKeyBytes) refuse("bad-key");
  return value as string;
}

export function createBroker({ host, launch, view, post, stopped, now = Date.now }: BrokerOptions): Broker {
  let phase: AppPhase = "loading";
  const recent: number[] = [];
  const scope = launch.chat?.linkId ?? "alone";
  const chatAllowed = !!launch.chat && launch.permissions.includes("chat");
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

  const answer = async (type: string, args: unknown[]): Promise<{ value?: MiniAppJson | ArrayBuffer; transfer?: Transferable[] }> => {
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
        const bytes = await host.file(launch.ref, path as string);
        const buffer = bytes.slice().buffer as ArrayBuffer;
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

    const id = data && typeof data === "object" && Number.isSafeInteger((data as { id?: unknown }).id) && (data as { id: number }).id >= 0 ? (data as { id: number }).id : null;
    const fail = (error: string) => { if (id !== null) post({ id, ok: false, error }); };
    if (recent.length > MINI_APP_LIMITS.requestsPerSecond) return fail("too-fast");
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

    answer(type, args).then(({ value, transfer }) => {
      if (phase === "stopped") return;
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
  frame.setAttribute("sandbox", "allow-scripts");
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
