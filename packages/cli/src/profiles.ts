import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CliError } from "./errors";

/**
 * Profiles on disk (WISP 1100 § Profiles and files): `<home>/profiles/<name>/`, 0700, one engine store each.
 * `<home>/current` names the profile commands use when none is given.
 */
export const DEFAULT_PROFILE = "default";
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function ghostlyHome(option?: string): string {
  return resolve(option ?? process.env.GHOSTLY_HOME ?? join(homedir(), ".ghostly"));
}

export function checkProfileName(name: string): string {
  if (!NAME.test(name) || name.includes("..")) throw new CliError("usage", `Not a profile name: ${JSON.stringify(name)} (letters, digits, ".", "_" and "-", up to 64)`);
  return name;
}

export function currentProfile(home: string, option?: string): string {
  if (option) return checkProfileName(option);
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
    name, dir, db: join(dir, "db"), socket: socketPath(dir), lock: join(dir, "daemon.lock"),
    events: join(dir, "events.jsonl"), files: join(dir, "files"), log: join(dir, "daemon.log"),
  };
}

/**
 * The daemon's socket: in the profile's folder, unless that path is longer than a Unix socket may be (104 bytes on
 * macOS); then in a folder of /tmp named after the profile's, which the daemon makes owner-only and checks before
 * use (`privateFolder`), and whose socket a client connects to only when it is this user's (`ownSocket`).
 */
function socketPath(dir: string): string {
  const inside = join(dir, "daemon.sock");
  if (process.platform === "win32") return `\\\\.\\pipe\\ghostly-${createHash("sha256").update(dir).digest("hex").slice(0, 24)}`;
  if (Buffer.byteLength(inside) <= 100) return inside;
  return join("/tmp", `ghostly-${createHash("sha256").update(dir).digest("hex").slice(0, 24)}`, "daemon.sock");
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
 */
export function acquireLock(paths: ProfilePaths): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(paths.lock, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { if (readFileSync(paths.lock, "utf8").trim() === String(process.pid)) rmSync(paths.lock, { force: true }); } catch { /* gone already */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = lockOwner(paths);
      if (owner !== null) throw new CliError("busy", `Profile ${paths.name} is in use by process ${owner}`, { pid: owner });
      rmSync(paths.lock, { force: true });
    }
  }
  throw new CliError("busy", `Profile ${paths.name} is in use`);
}

/** The pid holding the profile, or null when nobody (or a process that is gone) does. */
export function lockOwner(paths: ProfilePaths): number | null {
  let pid: number;
  try { pid = Number(readFileSync(paths.lock, "utf8").trim()); } catch { return null; }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return pid; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" ? pid : null; }
}
