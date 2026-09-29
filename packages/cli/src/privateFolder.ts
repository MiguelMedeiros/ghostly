import { chmodSync, lstatSync, mkdirSync } from "node:fs";

/**
 * A folder for a socket outside the profile (when the profile's path is too long for one): made owner-only, and
 * refused when it is a link, someone else made it, or anyone else may enter it.
 */
export function privateFolder(path: string, what: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) {
    throw new Error(`${path} is not a folder of this user's alone: ${what}`);
  }
}

/**
 * The profile's own folder, made owner-only again before the daemon's socket goes in it: a folder made by an older
 * release, or opened up by hand, is closed rather than trusted. Refused when it is a link or someone else's.
 */
export function ownFolder(path: string, what: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) throw new Error(`${path} is not a folder of this user's: ${what}`);
  if ((info.mode & 0o077) !== 0) chmodSync(path, 0o700);
}

/** False when `path` is there but is not a socket of this user's: nothing to connect to. */
export function ownSocket(path: string): boolean {
  if (process.platform === "win32") return true;
  let info;
  try { info = lstatSync(path); } catch { return true; }
  return info.isSocket() && (!process.getuid || info.uid === process.getuid());
}
