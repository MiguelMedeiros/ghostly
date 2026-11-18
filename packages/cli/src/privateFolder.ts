import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmdirSync, statSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { CliError } from "./errors";

/**
 * Where a socket goes when its path in the profile is longer than a Unix socket may be: `<base>/<prefix>-<hash of the
 * profile>/<leaf>`, in `$XDG_RUNTIME_DIR` or else the temp folder (macOS gives each user one) when that folder is the
 * user's alone, so no other user can make the folder first. When neither is, or the path would still be too long:
 * `/tmp/<prefix>-<uid>-<hash>/<leaf>`. Either way `privateFolder` checks the folder before use, and
 * `dropRuntimeFolder` removes it once its socket is gone.
 */
export function runtimePath(prefix: string, profileDir: string, leaf: string): string {
  const hash = createHash("sha256").update(profileDir).digest("hex").slice(0, 24);
  for (const base of [process.env.XDG_RUNTIME_DIR, tmpdir()]) {
    if (!base || !isAbsolute(base) || !usersAlone(base)) continue;
    const path = join(base, `${prefix}-${hash}`, leaf);
    if (Buffer.byteLength(path) <= 100) return runtimeFolder(path);
  }
  return runtimeFolder(join("/tmp", `${prefix}-${process.getuid?.() ?? 0}-${hash}`, leaf));
}

/** The folders `runtimePath` gave in this process: the only ones `dropRuntimeFolder` removes. */
const runtimeFolders = new Set<string>();

function runtimeFolder(path: string): string {
  runtimeFolders.add(dirname(path));
  return path;
}

/**
 * Removes the folder `runtimePath` gave for `socket`, once that socket is gone (a daemon that stopped, a call that
 * ended): left behind, one empty folder per long-path profile piled up in the temp folder. Only an empty folder of this
 * user's that is not a link goes (`rmdir`, never what is in it): another socket in it (another call of the daemon's)
 * keeps it, and it goes with the last one. Any other folder (the profile's own, `GHOSTLY_CALL_SOCKET_DIR`) is left
 * alone. Nothing here fails the stop: a folder that cannot go stays, and is used again.
 */
export function dropRuntimeFolder(socket: string): void {
  const folder = dirname(socket);
  if (process.platform === "win32" || !runtimeFolders.has(folder)) return;
  try {
    const info = lstatSync(folder);
    if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) return;
    rmdirSync(folder);
  } catch {
    // Not empty (ENOTEMPTY: another socket or file in it), or gone already (ENOENT): it stays as it is.
  }
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
 * refused when it is a link, someone else made it, or anyone else may enter it: `refused`, as the profile's own checks
 * (`ownProfile`), with the way out. It holds only sockets, so removing it loses nothing; it is made again.
 */
export function privateFolder(path: string, what: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) {
    throw new CliError("refused", `${path} is not a folder of this user's alone: ${what}. Run \`rm -r ${path}\` (ghostly makes it again), or if it is this user's folder, \`chmod 700 ${path}\`, then try again`);
  }
}

/**
 * The profile's own folder, made owner-only again before the daemon's socket goes in it: a folder made by an older
 * release, or opened up by hand, is closed rather than trusted. Refused when it is a link or someone else's.
 */
export function ownFolder(path: string, what: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) throw new CliError("refused", `${path} is not a folder of this user's: ${what}`);
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
      // Another command at once on the profile removes its lock's draft, start and stale files as it goes: one gone
      // since the listing is passed over, not the command's error.
      const path = join(folder, name), entry = lstatSync(path, { throwIfNoEntry: false });
      if (!entry) continue;
      if (entry.isSymbolicLink() || !mine(entry)) throw new CliError("refused", `${path} is a link or another user's: ${what}`);
      if (entry.isFile() && (entry.mode & 0o077) !== 0) {
        try { chmodSync(path, 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
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
