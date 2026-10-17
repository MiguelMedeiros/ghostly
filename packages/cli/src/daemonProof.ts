import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

/**
 * How a client knows the process on the profile's socket is the profile's daemon (WISP 1100 § Local control API).
 * On Windows the socket is a named pipe whose name follows from the profile's path, and any account of the machine
 * may open that name first; the pipe itself has no owner a client can check. So the daemon writes a fresh random
 * secret in the profile's owner-only folder at every start, and the client sends nothing but a `daemon.hello` with a
 * nonce of its own until the answer proves, over that nonce, that its sender read the secret. Same on every platform.
 */
export const HELLO = "daemon.hello";

export function daemonSecretPath(dir: string): string {
  return join(dir, "daemon.secret");
}

/** HMAC-SHA256 over the role's domain and the nonce, hex: a daemon's proof is never a client's, nor one for another nonce. */
export function proof(secret: Buffer, role: "daemon" | "client", nonce: string): string {
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
