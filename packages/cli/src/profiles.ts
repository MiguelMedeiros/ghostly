import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CliError } from "./errors";
import { runtimePath } from "./privateFolder";

/**
 * Profiles on disk (WISP 1100 § Profiles and files): `<home>/profiles/<name>/`, 0700, one engine store each.
 * `<home>/current` names the profile commands use when none is given.
 */
export const DEFAULT_PROFILE = "default";
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * An empty `--home` or `--profile` (an unset variable in a script) is a usage error: taken as not given, it ran the
 * command in the current folder, or as the current profile. An empty variable of the environment counts as unset.
 */
export function ghostlyHome(option?: string): string {
  if (option === "") throw new CliError("usage", "--home needs a folder");
  return userPath(option ?? (process.env.GHOSTLY_HOME || join(homedir(), ".ghostly")), true);
}

/**
 * A path the CLI was given, made absolute. A `~` the shell left alone (`--home=~/bots`, a quoted variable, a unit
 * file's `Environment=` line) is the user's home, as the shell reads it: it was a folder named `~` in the current one.
 * `~user/…` is a usage error, not a guess at another user's home, unless it is there under this folder. Any other name
 * that starts with `~` is a file here, as the shell and every other tool read it (`~notes.txt`, Office's
 * `~$report.docx`, a new `~cursor`): all of them were refused (agents#1604). `home`: the profiles' folder, where a bare
 * `~bob` that is not there is refused too, as a new profile would be made in a folder of that name.
 */
export function userPath(path: string, home = false): string {
  if (path === "~" || path.startsWith("~/")) return join(homedir(), path.slice(1));
  if (path.startsWith("~") && (home || path.includes("/")) && !existsSync(resolve(path))) {
    throw new CliError("usage", `${path}: ~user is not read here: write the ${home || path.endsWith("/") ? "folder" : "path"} in full`);
  }
  return resolve(path);
}

export function checkProfileName(name: string): string {
  if (!NAME.test(name) || name.includes("..")) throw new CliError("usage", `Not a profile name: ${JSON.stringify(name)} (letters, digits, ".", "_" and "-", up to 64)`);
  return name;
}

/**
 * The name a profile shows its contacts, whichever command sets it (`--name`, `profile.set`, `settings set nick`):
 * trimmed, up to 64 characters on one line, as a group's name; empty is no name. `settings set nick` took any length
 * and every one took a line break, printed whole by `status`. `field` names it in the refusal.
 */
export function checkShownName(name: unknown, field = "name"): string {
  const shown = typeof name === "string" ? name.trim() : undefined;
  // Core's MAX_NICK_LENGTH: this file loads before any command, without the engine.
  if (shown === undefined || [...shown].length > 64 || /\p{Cc}/u.test(shown)) {
    throw new CliError("bad_request", `${field} must be up to 64 characters on one line`);
  }
  return shown;
}

export function currentProfile(home: string, option?: string): string {
  if (option === "") throw new CliError("usage", "--profile needs a profile name");
  if (option !== undefined) return checkProfileName(option);
  if (process.env.GHOSTLY_PROFILE) return checkProfileName(process.env.GHOSTLY_PROFILE);
  const file = join(home, "current");
  if (existsSync(file)) {
    const name = readFileSync(file, "utf8").trim();
    if (name) return checkProfileName(name);
  }
  return DEFAULT_PROFILE;
}

export function profileDir(home: string, name: string): string {
  return join(home, "profiles", checkProfileName(name));
}

export interface ProfilePaths { name: string; dir: string; db: string; socket: string; lock: string; events: string; files: string; log: string }
export function profilePaths(home: string, name: string): ProfilePaths {
  const dir = profileDir(home, name);
  return {
    name, dir, db: join(dir, "db"), socket: socketPath(dir), lock: lockPath(dir),
    events: join(dir, "events.jsonl"), files: join(dir, "files"), log: join(dir, "daemon.log"),
  };
}

/** The file that says which process holds the profile (`acquireLock`). */
export function lockPath(dir: string): string {
  return join(dir, "daemon.lock");
}

/**
 * The daemon's socket: in the profile's folder, unless that path is longer than a Unix socket may be (104 bytes on
 * macOS); then in a folder of the user's runtime folder named after the profile's (`runtimePath`), which the daemon
 * makes owner-only and checks before use (`privateFolder`), and whose socket a client connects to only when it is this
 * user's (`ownSocket`).
 */
function socketPath(dir: string): string {
  const inside = join(dir, "daemon.sock");
  if (process.platform === "win32") return `\\\\.\\pipe\\ghostly-${createHash("sha256").update(dir).digest("hex").slice(0, 24)}`;
  if (Buffer.byteLength(inside) <= 100) return inside;
  return runtimePath("ghostly", dir, "daemon.sock");
}

function ensureFolder(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/** Makes the profile's folder; refused when it exists and `existing` is not allowed. */
export function createProfile(home: string, name: string, { existing = false } = {}): ProfilePaths {
  const paths = profilePaths(home, name);
  if (existsSync(paths.dir) && !existing) throw new CliError("refused", `Profile ${name} exists`);
  ensureFolder(join(home, "profiles"));
  ensureFolder(paths.dir);
  return paths;
}

/**
 * A file in the folder of a profile a restore made, until its engine starts for the first time: the store came back
 * whole, as the backup held it, and the money in it is then treated as every restore treats it (WISP 05 § Restoring).
 */
export const RESTORED_MARK = "restored";

export function profileExists(home: string, name: string): boolean {
  return existsSync(profileDir(home, name));
}

export function listProfiles(home: string): string[] {
  const root = join(home, "profiles");
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => NAME.test(name) && statSync(join(root, name)).isDirectory()).sort();
}

export function selectProfile(home: string, name: string): void {
  if (!profileExists(home, name)) throw new CliError("not_found", `No profile ${name}`);
  ensureFolder(home);
  writeFileSync(join(home, "current"), name + "\n", { mode: 0o600 });
}

/**
 * One process per profile: the daemon or a one-shot command. The lock holds the owner's pid; a lock whose
 * process is gone is taken over.
 *
 * The lock is a link to a file that already holds the pid, so it never exists empty (agents#1642): one made by
 * `openSync` + `writeSync` was empty for a moment, and another process read that as nobody's and removed it under its
 * owner. An empty lock younger than `EMPTY_LOCK_GRACE_MS` is still an older release's being written: busy. A stale
 * lock is moved aside before it is removed, and only when what was moved is the file judged stale: one that vanished,
 * or that another process made since, is no longer removed.
 */
export function acquireLock(paths: ProfilePaths): () => void {
  const mine = String(process.pid);
  const draft = `${paths.lock}.${mine}`;
  writeFileSync(draft, mine, { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (placeLock(draft, paths.lock, mine)) {
        let released = false;
        return () => {
          if (released) return;
          released = true;
          try { if (readFileSync(paths.lock, "utf8").trim() === mine) rmSync(paths.lock, { force: true }); } catch { /* gone already */ }
        };
      }
      let seen: Stats;
      try { seen = lstatSync(paths.lock); } catch { continue; }
      const owner = lockOwner(paths);
      if (owner !== null) throw new CliError("busy", `Profile ${paths.name} is in use by process ${owner}`, { pid: owner });
      if (seen.size === 0 && Date.now() - seen.mtimeMs < EMPTY_LOCK_GRACE_MS) break;
      removeStaleLock(paths.lock, seen);
    }
  } finally {
    rmSync(draft, { force: true });
  }
  throw new CliError("busy", `Profile ${paths.name} is in use`);
}

/** How long an empty lock is taken for one an older release is still writing its pid into. */
const EMPTY_LOCK_GRACE_MS = 1_000;

/**
 * Links `draft` (which holds `mine`) as the lock; false when there is a lock already. Where the file system has no
 * hard links, the lock is made in place, as before.
 */
function placeLock(draft: string, lock: string, mine: string): boolean {
  try {
    linkSync(draft, lock);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(code ?? "")) throw error;
  }
  let fd: number;
  try { fd = openSync(lock, "wx", 0o600); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  writeSync(fd, mine);
  closeSync(fd);
  return true;
}

/**
 * Removes the lock judged stale (`seen`): it is moved aside first, and removed only when what was moved is that same
 * file and holds no live pid (a freed inode is soon reused). A lock another process made in the meantime is put back.
 */
function removeStaleLock(lock: string, seen: Stats): void {
  const aside = `${lock}.stale.${process.pid}`;
  try { renameSync(lock, aside); } catch { return; }
  try {
    const moved = lstatSync(aside);
    if (moved.ino === seen.ino && moved.dev === seen.dev && holder(aside) === null && moved.size === seen.size) return;
    try { linkSync(aside, lock); } catch { /* another lock is there already */ }
  } finally {
    rmSync(aside, { force: true });
  }
}

/** The pid holding the profile, or null when nobody (or a process that is gone) does. */
export function lockOwner(paths: ProfilePaths): number | null {
  return holder(paths.lock);
}

function holder(file: string): number | null {
  let pid: number;
  try { pid = Number(readFileSync(file, "utf8").trim()); } catch { return null; }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return pid; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" ? pid : null; }
}
