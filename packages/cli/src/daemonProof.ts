import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { lockPath } from "./profiles";

/**
 * How a client knows the process on the profile's socket is the profile's daemon (WISP 1100 § Local control API).
 * On Windows the socket is a named pipe whose name follows from the profile's path, and any account of the machine
 * may open that name first; the pipe itself has no owner a client can check. So the daemon writes a fresh random
 * secret in the profile's owner-only folder at every start, and the client sends nothing but a `daemon.hello` with a
 * nonce of its own until the answer proves, over that nonce, that its sender read the secret. Same on every platform.
 *
 * Before even the hello, the daemon speaks first: a greeting that proves, with the same secret, its pid (the
 * profile's lock holder) and the time. The client writes nothing at all until the greeting checks out. A process
 * holding `SeImpersonatePrivilege` that opened the pipe's name first can impersonate the client from the first
 * message it reads (Node's pipe client sets no security quality of service, so the level is SecurityImpersonation),
 * and Windows refuses to impersonate a pipe's client until data has been read from it (ERROR_CANNOT_IMPERSONATE):
 * a client that writes nothing to it cannot be impersonated.
 */
export const HELLO = "daemon.hello";

/**
 * How far a greeting's time may be from the client's clock (the same machine's): a greeting is no fresh challenge, so
 * one copied from a daemon that has since died could otherwise stand in for it as long as its secret file is left.
 */
export const GREETING_WINDOW_MS = 10_000;

export interface Greeting { pid: number; at: number; proof: string }

export function daemonSecretPath(dir: string): string {
  return join(dir, "daemon.secret");
}

/** HMAC-SHA256 over the role's domain and the nonce, hex: a daemon's proof is never a client's, nor one for another nonce. */
export function proof(secret: Buffer, role: "daemon" | "client" | "greeting", nonce: string): string {
  return createHmac("sha256", secret).update(`ghostly-${role}:${nonce}`).digest("hex");
}

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

/**
 * The daemon's: a new secret, 32 random bytes as hex, made 0600 (`wx`, so a file or link put there in the meantime is
 * an error, not something written through). The one a daemon before it left is removed first: whoever could have
 * read that one learns nothing about this one.
 */
export function newDaemonSecret(dir: string): Buffer {
  const file = daemonSecretPath(dir);
  rmSync(file, { force: true });
  const secret = randomBytes(32);
  const fd = openSync(file, "wx", 0o600);
  try { writeSync(fd, secret.toString("hex") + "\n"); } finally { closeSync(fd); }
  return secret;
}

/** The daemon's, when it stops: a greeting copied from it proves nothing once it is gone. */
export function removeDaemonSecret(dir: string): void {
  rmSync(daemonSecretPath(dir), { force: true });
}

/** The daemon's first line on every connection, before it has read anything. */
export function greeting(secret: Buffer, pid = process.pid, at = Date.now()): { greeting: Greeting } {
  return { greeting: { pid, at, proof: proof(secret, "greeting", `${pid}:${at}`) } };
}

/**
 * Whether `message` (the first line the client read) is the profile's daemon's greeting: proved with the secret, made
 * within `GREETING_WINDOW_MS` of `now`, by the process that holds the profile's lock, alive and one this user may
 * signal (`process.kill(pid, 0)`: EPERM on Unix for another user's; on Windows libuv opens the process to terminate
 * it, which another account's process normally denies). A greeting copied from a daemon that died fails on its pid,
 * unless a process this user may signal took that pid within the window.
 */
export function provesGreeting(secret: Buffer, dir: string, message: unknown, now = Date.now()): boolean {
  const given = (message as { greeting?: Partial<Greeting> } | null)?.greeting;
  if (!given || !Number.isSafeInteger(given.pid) || (given.pid as number) <= 0 || !Number.isSafeInteger(given.at)) return false;
  if (typeof given.proof !== "string" || !/^[0-9a-f]{64}$/.test(given.proof)) return false;
  const { pid, at } = given as Greeting;
  if (Math.abs(now - at) > GREETING_WINDOW_MS) return false;
  if (!timingSafeEqual(Buffer.from(given.proof, "hex"), Buffer.from(proof(secret, "greeting", `${pid}:${at}`), "hex"))) return false;
  return holdsProfile(dir, pid);
}

/**
 * Whether a daemon of this release holds the profile: its secret is there (an older release's never writes one, and a
 * daemon removes its own when it stops) and the lock's holder is alive and this user's. One whose greeting is late is
 * busy (its event loop held by one long task), not something else on its socket: the client waits for it.
 */
export function daemonOfThisRelease(dir: string): boolean {
  if (!readDaemonSecret(dir)) return false;
  let pid: number;
  try { pid = Number(readFileSync(lockPath(dir), "utf8").trim()); } catch { return false; }
  return Number.isSafeInteger(pid) && pid > 0 && holdsProfile(dir, pid);
}

function holdsProfile(dir: string, pid: number): boolean {
  try {
    if (readFileSync(lockPath(dir), "utf8").trim() !== String(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

/**
 * The client's: the secret the profile's daemon wrote, or null when there is none, or it is not a file of this user's
 * alone (a link, another user's file, one others may read): then it proves nothing. On Windows the file has the
 * folder's ACL (owner-only in the user's home); Node can check no more than that it is a plain file.
 */
export function readDaemonSecret(dir: string): Buffer | null {
  const file = daemonSecretPath(dir);
  try {
    const info = lstatSync(file);
    if (!info.isFile()) return null;
    if (process.platform !== "win32" && ((process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0)) return null;
    const text = readFileSync(file, "utf8").trim();
    return /^[0-9a-f]{64}$/.test(text) ? Buffer.from(text, "hex") : null;
  } catch { return null; }
}

/** Whether `answer` (the result of a `daemon.hello` with `nonce`) is the daemon's proof over it, in constant time. */
export function provesDaemon(secret: Buffer, nonce: string, answer: unknown): boolean {
  const given = (answer as { proof?: unknown } | null)?.proof;
  if (typeof given !== "string" || !/^[0-9a-f]{64}$/.test(given)) return false;
  return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(proof(secret, "daemon", nonce), "hex"));
}
