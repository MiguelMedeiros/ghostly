import { lstatSync, mkdirSync } from "node:fs";

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

/** False when `path` is there but is not a socket of this user's: nothing to connect to. */
export function ownSocket(path: string): boolean {
  if (process.platform === "win32") return true;
  let info;
  try { info = lstatSync(path); } catch { return true; }
  return info.isSocket() && (!process.getuid || info.uid === process.getuid());
}
