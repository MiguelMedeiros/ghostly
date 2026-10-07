/**
 * What the service worker does with a request. Pure, so it is tested without a worker (apps/ui/src/test/pwa/).
 *
 * An allowlist: the worker answers from its cache only what the build made (the app shell and the hashed
 * files under `/assets/`), and the share target's POST. Everything else goes to the network as if there were
 * no worker, and nothing it fetches is ever stored: messages, relay and DHT traffic, wallet and API calls,
 * other origins, the update check, the sign-in callback. An invite's keys ride in the address's fragment,
 * which never reaches a worker at all; the shell is the same file for every address.
 */

/** Where the operating system posts what is shared into the installed app (manifest `share_target`). */
export const SHARE_TARGET_PATH = "/share-target";

/** Where the app picks a shared item up once the worker has it. */
export const SHARED_ROUTE = "/#/shared";

/** The prefix of every cache this worker owns; the build id follows it. */
export const CACHE_PREFIX = "ghostly-shell-";

export type Route =
  /** The app's page, from the cache (the version this worker was built with). */
  | "shell"
  /** A file of the build, precached at install. */
  | "precache"
  /** A hashed file of the build that was not precached (wallet wasm, …): cached the first time it is fetched. */
  | "asset"
  /** Something shared into the app from another one. */
  | "share"
  /** Not the worker's business: the network, uncached. */
  | "pass";

export interface RequestLike {
  method: string;
  url: string;
  mode?: string;
  /** Whether it asks for part of a file (a media element does): answered by the server, which answers 206. */
  range?: boolean;
}

/**
 * Paths of this origin that always go to the network, whatever else would match. `/version.json` is how a
 * tab learns about a deploy, so a cached answer would hide every update; the sign-in callback carries a
 * provider's answer; the worker's own script is the browser's to fetch; the mini-app runner's sandbox is in its
 * server's header (WISP 1200), which a cached copy could lose.
 */
const NEVER = new Set(["/version.json", "/oidc-callback.html", "/sw.js", "/app-frame.html", "/app-frame-net.html", "/app-frame-unguarded.html"]);

/** Pages that are the app: its root and its file. Any other path is a static file, or nothing. */
const APP_PAGES = new Set(["/", "/index.html"]);

export function classify(request: RequestLike, origin: string, precached: ReadonlySet<string>): Route {
  let url: URL;
  try { url = new URL(request.url); } catch { return "pass"; }
  if (url.origin !== origin) return "pass";
  const path = url.pathname;

  if (request.method === "POST") return path === SHARE_TARGET_PATH ? "share" : "pass";
  if (request.method !== "GET") return "pass";
  if (NEVER.has(path) || request.range) return "pass";

  // A page load of the app (the router lives in the fragment, so every screen is `/`). A query on it is not the
  // app's (the app puts nothing there), so it goes to the server as it is.
  if (request.mode === "navigate") return APP_PAGES.has(path) && !url.search ? "shell" : "pass";

  // Precached files are stored under their bare path; a query string makes it another request.
  if (url.search) return "pass";
  if (precached.has(path)) return "precache";
  if (path.startsWith("/assets/") && !path.includes("..")) return "asset";
  return "pass";
}

/**
 * What the build precaches: the app's page, its hashed files except the WebAssembly (wallets load theirs when
 * one is used, and they are most of the build's weight), and the static files beside it. Never the update
 * check, the sign-in callback or the worker itself.
 */
export function precacheList(files: readonly string[]): string[] {
  const paths = files
    .map((file) => "/" + file.replace(/^\/+/, ""))
    .filter((path) => !NEVER.has(path))
    .filter((path) => !/\.(wasm|map)$/.test(path))
    .filter((path) => path !== "/index.html");
  return ["/", ...new Set(paths)].sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b)));
}

/** A shared item as the manifest's `share_target` params name it. */
export interface SharedItem {
  title: string;
  text: string;
  url: string;
  files: File[];
}

/** Most files one share brings; larger shares keep their first ones. */
export const MAX_SHARED_FILES = 32;

/**
 * The most one share may bring, all of it together. Any website can post to the share target (a form can), and the
 * worker holds what arrives in memory, so a larger body is not read on: it is dropped whole.
 */
export const MAX_SHARE_BYTES = 64 * 1024 * 1024;

/**
 * A share target POST's body, read up to `max` bytes: null past that (the rest is never read), or when the body
 * says up front that it is larger.
 */
export async function readShareBody(request: { body: ReadableStream<Uint8Array> | null; headers: { get(name: string): string | null } }, max = MAX_SHARE_BYTES): Promise<Blob | null> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return new Blob([]);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) return null;
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return new Blob(chunks as BlobPart[]);
}

/** What a share target POST carries, bounded: strings of a sane length, files that are files, `max` bytes of them in all. */
export function readShare(form: FormData, max = MAX_SHARE_BYTES): SharedItem {
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value.slice(0, 64 * 1024) : "";
  };
  let room = max;
  const files: File[] = [];
  for (const value of form.getAll("files")) {
    if (typeof value === "string" || !(value.size >= 0)) continue;
    if (files.length >= MAX_SHARED_FILES || value.size > room) break;
    room -= value.size;
    files.push(value);
  }
  return { title: text("title"), text: text("text"), url: text("url"), files };
}

/** Where a profile's push-only worker is registered: its own scope, so each profile has its own subscription. */
export const PUSH_SCOPE_PREFIX = "/push/";

/** The scope of a profile's push worker (`""` is the default profile). */
export function pushScope(profile: string): string {
  return `${PUSH_SCOPE_PREFIX}${encodeURIComponent(profile || "default")}/`;
}

/** The profile a worker's scope is for, or null for the app's own worker (scope `/`). */
export function pushScopeProfile(scope: string): string | null {
  let path: string;
  try { path = new URL(scope).pathname; } catch { return null; }
  const match = path.match(/^\/push\/([^/]+)\/$/);
  if (!match) return null;
  const profile = decodeURIComponent(match[1]!);
  return profile === "default" ? "" : profile;
}

/**
 * How often one token may make a wake-up buzz. Senders keep to one wake-up per contact per 5 minutes, but a contact
 * who does not could otherwise fill the screen with "Incoming call" notices that stay until dismissed. Past the gap
 * the next one shows; inside it the notice already on screen is kept, with no new sound.
 */
export const WAKE_NOTICE_GAP_MS = { call: 30_000, message: 5 * 60_000 } as const;

/** Whether a wake-up of this kind may show now, given when this token last showed one of its kind. */
export function wakeNoticeDue(lastShown: number | undefined, call: boolean, now: number): boolean {
  if (lastShown === undefined || lastShown > now) return true;
  return now - lastShown >= WAKE_NOTICE_GAP_MS[call ? "call" : "message"];
}

/** A notice the push worker shows. `quiet`: no sound, no vibration, nothing that stays up (a device that is not the active one). */
export interface PushNotice {
  title: string;
  body: string;
  tag: string;
  call: boolean;
  quiet?: true;
  data: { path: string; profile: string };
}

/** The device state as the worker read it (`deviceState.ts`); null for a profile on one device. */
export interface NoticeDevice {
  state: string;
  /** The active device's name, when it is another one. */
  active?: string;
  /** The tokens this device gave its other devices, each with that device's name. */
  tokens: Record<string, string>;
  /** The chats' tokens the active device still hands out; a token not among them shows nothing. Absent: any. */
  allowed?: string[];
}

/** Words the worker uses when no page of this profile ever wrote its own (a device that was never active). */
export const DEVICE_NOTICE_DEFAULTS = {
  standby: "New message. Active on {device}.",
  standbyCall: "Call for you. Active on {device}.",
  standbyUnnamed: "New message. Open Ghostly on your active device.",
  standbyCallUnnamed: "Call for you. Open Ghostly on your active device.",
  takeover: "{device} wants to take over. Open Ghostly.",
  moveHere: "{device} wants to move this profile here. Open Ghostly.",
} as const;

const fill = (template: string, device: string) => template.split("{device}").join(device);

/**
 * What a push shows in a profile on several devices (WISP 06 § Push and the phone), on top of `wakeNotice`:
 *
 * - **A wake-up from another of the person's devices** (`device`): shown only for a token this device gave one of its
 *   own devices, naming it: "<device> wants to take over" where this one is active, "<device> wants to move this profile
 *   here" where it is not. The `d` flag alone proves nothing: anyone holding the subscription could set it.
 * - **A device that is not the active one never rings**: a message or a call shows "New message. Active on <device>." or
 *   "Call for you. Active on <device>.", quietly, and a tap opens the standby screen. Once the active device said which
 *   chats' tokens it hands out (`allowed`), only those show: a chat deleted or muted there stays quiet here. Before it
 *   said, any well-formed wake-up shows (a chat made on the active device has a token this one never knew), except one
 *   this device knows for a muted chat. A removed device shows nothing.
 * - **The active device, or a profile on one device**: today's notices (`wakeNotice`).
 */
export function pushNotice(
  wake: { token: string; kind: "message" | "call" | "device" } | null,
  found: Parameters<typeof wakeNotice>[0],
  device: NoticeDevice | null,
  options: { now: number; appVisible: boolean; profile: string; text?: Partial<Record<keyof typeof DEVICE_NOTICE_DEFAULTS, string>> & { title?: string } },
): PushNotice | null {
  if (!wake) return null;
  const text = { ...DEVICE_NOTICE_DEFAULTS, ...Object.fromEntries(Object.entries(options.text ?? {}).filter(([, value]) => typeof value === "string" && value)) };
  const title = options.text?.title || "Ghostly";
  const home = { path: "/", profile: options.profile };
  const runs = !device || device.state === "active";
  if (wake.kind === "device") {
    const asker = device?.tokens[wake.token];
    if (asker === undefined || options.appVisible) return null;
    const name = asker || "Ghostly";
    return { title, body: fill(runs ? text.takeover : text.moveHere, name), tag: `device:${options.profile}`, call: false, data: home };
  }
  if (runs) return wakeNotice(found, { now: options.now, appVisible: options.appVisible, profile: options.profile, kind: wake.kind });
  if (device.state === "removed" || options.appVisible) return null;
  // A chat deleted or muted on the active device, or a token nobody hands out any more (a removed device's): nothing.
  if (device.allowed && !device.allowed.includes(wake.token)) return null;
  const muted = found?.entry.mutedUntil;
  if (muted === "forever" || (typeof muted === "number" && muted > options.now)) return null;
  const call = wake.kind === "call" && (!found || found.entry.path.startsWith("/chat/"));
  const body = device.active ? fill(call ? text.standbyCall : text.standby, device.active) : (call ? text.standbyCallUnnamed : text.standbyUnnamed);
  return { title, body, tag: `standby:${options.profile}`, call: false, quiet: true, data: home };
}

/**
 * What a wake-up shows (WISP 401 § Wake-up push): "New message" for a chat the token names, or nothing at all
 * for a token this profile no longer knows (a contact it stopped sharing with), for a muted chat, and while the
 * app is on screen (it is live, and the message arrives by itself). Never a sender or any text of the message.
 */
export function wakeNotice(found: { entry: { path: string; mutedUntil?: number | "forever" }; text: { title: string; body: string; call?: string } } | undefined, options: { now: number; appVisible: boolean; profile: string; kind?: "message" | "call" }):
  { title: string; body: string; tag: string; call: boolean; data: { path: string; profile: string } } | null {
  if (!found || options.appVisible) return null;
  const { entry, text } = found;
  if (entry.mutedUntil === "forever" || (typeof entry.mutedUntil === "number" && entry.mutedUntil > options.now)) return null;
  if (!/^\/(chat|group)\/[^/?#]+$/.test(entry.path)) return null;
  // A call says so ("Incoming call", the app's own words): the caller is waiting for the chat to go live.
  // Groups have no calls: a group's token woken as a call is a message wake-up (WISP 902 · Group Mesh § Wake-up push).
  const call = options.kind === "call" && entry.path.startsWith("/chat/");
  return {
    title: text.title, body: call ? text.call || "Incoming call" : text.body, tag: `${call ? "wake-call" : "wake"}:${options.profile}:${entry.path}`, call,
    data: { path: entry.path, profile: options.profile },
  };
}
