import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, statSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { CliError } from "./errors";

/**
 * Where a socket goes when its path in the profile is longer than a Unix socket may be: `<base>/<prefix>-<hash of the
 * profile>/<leaf>`, in `$XDG_RUNTIME_DIR` or else the temp folder (macOS gives each user one) when that folder is the
 * user's alone, so no other user can make the folder first. When neither is, or the path would still be too long:
 * `/tmp/<prefix>-<uid>-<hash>/<leaf>`. Either way `privateFolder` checks the folder before use.
 */
export function runtimePath(prefix: string, profileDir: string, leaf: string): string {
  const hash = createHash("sha256").update(profileDir).digest("hex").slice(0, 24);
  for (const base of [process.env.XDG_RUNTIME_DIR, tmpdir()]) {
    if (!base || !isAbsolute(base) || !usersAlone(base)) continue;
    const path = join(base, `${prefix}-${hash}`, leaf);
    if (Buffer.byteLength(path) <= 100) return path;
  }
  return join("/tmp", `${prefix}-${process.getuid?.() ?? 0}-${hash}`, leaf);
}

function usersAlone(path: string): boolean {
  try {
    const info = statSync(path);
    return info.isDirectory() && (!process.getuid || info.uid === process.getuid()) && (info.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

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

/**
 * A profile's folders and files, checked before a command (a one-shot as much as the daemon) takes its lock or opens
 * its store, which append to the files in place and follow a link: the home and its `profiles/` must be this user's
 * (a link to a folder of this user's is one); the home is closed to others' writes, `profiles/` to 0700. The profile's
 * folder and its `db/` must be this user's and not links, and are closed to 0700; what is in them must be this user's
 * and not a link, and a file is closed to 0600. A home, profile or journal opened up by hand, or made by another
 * account in a folder it could write, was used as it was: the events journal (message texts) stayed readable by others.
 */
export function ownProfile(dir: string): void {
  if (process.platform === "win32") return;
  const what = "ghostly will not open the profile there";
  const profiles = dirname(dir), home = dirname(profiles);
  const mine = (info: Stats) => !process.getuid || info.uid === process.getuid();
  for (const folder of [home, profiles]) {
    const info = statSync(folder);
    if (!info.isDirectory() || !mine(info)) throw new CliError("refused", `${folder} is not a folder of this user's: ${what}`);
    const open = folder === home ? 0o022 : 0o077;
    if ((info.mode & open) !== 0) chmodSync(folder, info.mode & 0o777 & ~open);
  }
  const db = join(dir, "db");
  for (const folder of [dir, db]) {
    let info;
    try { info = lstatSync(folder); } catch (error) { if (folder === db && (error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (!info.isDirectory() || !mine(info)) throw new CliError("refused", `${folder} is not a folder of this user's: ${what}`);
    if ((info.mode & 0o077) !== 0) chmodSync(folder, 0o700);
    for (const name of readdirSync(folder)) {
      const path = join(folder, name), entry = lstatSync(path);
      if (entry.isSymbolicLink() || !mine(entry)) throw new CliError("refused", `${path} is a link or another user's: ${what}`);
      if (entry.isFile() && (entry.mode & 0o077) !== 0) chmodSync(path, 0o600);
    }
  }
}

/** False when `path` is there but is not a socket of this user's: nothing to connect to. */
export function ownSocket(path: string): boolean {
  if (process.platform === "win32") return true;
  let info;
  try { info = lstatSync(path); } catch { return true; }
  return info.isSocket() && (!process.getuid || info.uid === process.getuid());
}
