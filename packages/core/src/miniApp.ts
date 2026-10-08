/**
 * The mini-app API: what an app in the runner's sandbox can ask the client's broker for, and nothing more.
 *
 * Matches the broker table of WISP 1200 (docs/wisps/1200-marketplace.md, "The runner and the broker"). Types, limits and refusal codes only, with no imports: the broker (apps/ui) and
 * the apps (apps/mini/*) import this one module, so neither side can drift from the other, and app developers get it as
 * `@ghostlytools/sdk/app`. It is imported as `@ghostly/core/miniApp`, outside the
 * core barrel, because apps bundle it into their single HTML file.
 */

/** A JSON value: what `storage` keeps and what `chat.send` carries. */
export type MiniAppJson = null | boolean | number | string | MiniAppJson[] | { [key: string]: MiniAppJson };

/** `ghostly.context()`. */
export interface MiniAppContext {
  /** This app's version (its manifest's `version`). */
  version: string;
  /** Opened in a chat (true) or alone (false). */
  inChat: boolean;
  /** The same app on the contact's side, while it is open there; null when it is not. */
  peer: { version: string } | null;
  /** The person's display name in this chat, only with the `name` permission. */
  name?: string;
  /** The client's theme, so the app can match it. An app may fall back to `prefers-color-scheme` when it is missing. */
  theme?: "light" | "dark";
  /** The client's language (BCP 47, for example "pt-BR"). An app may fall back to `navigator.language` when it is missing. */
  locale?: string;
}

/** `chat.peer`: the peer opened the app (again, or in another version) or closed it. */
export type MiniAppPeerEvent = { open: true; version: string } | { open: false };

/** `window.ghostly` inside the sandbox. */
export interface MiniAppApi {
  context(): Promise<MiniAppContext>;
  /** The bytes of a file of the bundle. */
  file(path: string): Promise<ArrayBuffer>;
  /** The app's storage in its scope: this app in this chat, or this app alone. */
  storage: {
    /** The value, or undefined when the key is not set. */
    get(key: string): Promise<MiniAppJson | undefined>;
    set(key: string, value: MiniAppJson): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
  };
  chat: {
    /** One `apps/1` data frame to the same app on the contact's side. Refused unless the chat is live and the peer has the app open. */
    send(value: MiniAppJson): Promise<void>;
    /** A data frame from the peer, as the peer's app sent it: untrusted. Returns a function that removes the listener. */
    on(event: "message", listener: (data: MiniAppJson) => void): () => void;
    on(event: "peer", listener: (peer: MiniAppPeerEvent) => void): () => void;
  };
  /** Ends the app. */
  close(): Promise<void>;
}

/** The message types on the port (web, extension) or through `app_broker` (Desktop). */
export type MiniAppRequestType =
  | "context"
  | "file"
  | "storage.get"
  | "storage.set"
  | "storage.delete"
  | "storage.keys"
  | "chat.send"
  | "close";

/** A request from the app: `{id, type, args}`. The broker refuses an unknown `type`. */
export interface MiniAppRequest {
  id: number;
  type: MiniAppRequestType;
  args: MiniAppJson[];
}

/**
 * Every code a refused request answers with (WISP 1200, "The runner and the broker"). In the sandbox every failed
 * `ghostly.*` call rejects with an `Error` whose `message` is one of these codes; `miniAppErrorCode` reads it back. The
 * runner turns its own failures (no answer from the client, a lost broker) into `failed`, and arguments that are not
 * JSON into `bad-request`.
 *
 * - `bad-key`: a storage key that is not a string of 1 to 256 bytes.
 * - `bad-path`: a `file` path that is not a string of 1 to 1024 characters.
 * - `bad-request`: a request that is not `{id, type, args}` with JSON arguments.
 * - `failed`: anything else; the client's own words never reach the app.
 * - `full`: a storage write would take the scope past 5 MiB, so the app can make room.
 * - `no-file`: the bundle has no such file.
 * - `not-allowed`: `chat.send` without the `chat` permission, or with the app opened alone.
 * - `not-open`: `chat.send` before this side's chat has the app open.
 * - `offline`: `chat.send` while the chat's session is not live. Nothing is kept to send later.
 * - `peer-closed`: `chat.send` while the contact has not opened the app (or its client does not offer `apps/1`).
 * - `stopped`: a store removed or the publisher revoked the version running.
 * - `too-fast`: past 50 requests a second, or past 48 `chat.send` frames a second.
 * - `too-large`: a request, a stored value or a `chat.send` value past its bound (`MINI_APP_LIMITS`).
 * - `unknown-type`: a request `type` the broker does not answer.
 *
 * A later client may add a code: treat one you do not know as `failed`.
 */
export const MINI_APP_ERROR_CODES = [
  "bad-key", "bad-path", "bad-request", "failed", "full", "no-file", "not-allowed", "not-open", "offline", "peer-closed", "stopped",
  "too-fast", "too-large", "unknown-type",
] as const;
export type MiniAppErrorCode = typeof MINI_APP_ERROR_CODES[number];

/** The code of a refused `ghostly.*` call (the rejection's `Error`), or null for anything that is not one. */
export function miniAppErrorCode(error: unknown): MiniAppErrorCode | null {
  const code = error instanceof Error ? error.message : undefined;
  return (MINI_APP_ERROR_CODES as readonly string[]).includes(code as string) ? code as MiniAppErrorCode : null;
}

/**
 * The broker's answer to one request. `value` is JSON, or an `ArrayBuffer` for `file` on the port (web, extension). On
 * Desktop `app_broker` answers `file` with `bytes` instead, the file in base64, and the runner hands the app an
 * `ArrayBuffer` either way.
 *
 * `error` is one of `MINI_APP_ERROR_CODES` from this client; a later client may send a code this list does not have yet,
 * which an app reads as `failed`.
 */
export type MiniAppAnswer =
  | { id: number; ok: true; value?: MiniAppJson | ArrayBuffer }
  | { id: number; ok: true; bytes: string }
  | { id: number; ok: false; error: MiniAppErrorCode | (string & {}) };

/** An event from the broker. */
export type MiniAppEvent = { event: "chat.message"; data: MiniAppJson } | { event: "chat.peer"; data: MiniAppPeerEvent };

/** Limits the broker enforces (and an app can plan for). */
export const MINI_APP_LIMITS = {
  /** One request, serialized. */
  requestBytes: 64 * 1024,
  /** Requests per second, per app. */
  requestsPerSecond: 50,
  /** A storage key, UTF-8. */
  storageKeyBytes: 256,
  /** One stored JSON value, serialized. */
  storageValueBytes: 64 * 1024,
  /** Everything an app keeps in one scope (per app and per chat, or alone). */
  storageScopeBytes: 5 * 1024 * 1024,
  /** One `chat.send` value, serialized: the `paired-app` data cap (decision D5 of the plan). */
  chatDataBytes: 32 * 1024,
} as const;
