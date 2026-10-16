import { t as CliError } from "./errors-B-zMxbcd.js";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
//#region src/profiles.ts
/**
* Profiles on disk (WISP 1100 § Profiles and files): `<home>/profiles/<name>/`, 0700, one engine store each.
* `<home>/current` names the profile commands use when none is given.
*/
var DEFAULT_PROFILE = "default";
var NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
/**
* An empty `--home` or `--profile` (an unset variable in a script) is a usage error: taken as not given, it ran the
* command in the current folder, or as the current profile. An empty variable of the environment counts as unset.
*/
function ghostlyHome(option) {
	if (option === "") throw new CliError("usage", "--home needs a folder");
	return resolve(option ?? (process.env.GHOSTLY_HOME || join(homedir(), ".ghostly")));
}
function checkProfileName(name) {
	if (!NAME.test(name) || name.includes("..")) throw new CliError("usage", `Not a profile name: ${JSON.stringify(name)} (letters, digits, ".", "_" and "-", up to 64)`);
	return name;
}
/**
* The name a profile shows its contacts, whichever command sets it (`--name`, `profile.set`, `settings set nick`):
* trimmed, up to 64 characters on one line, as a group's name; empty is no name. `settings set nick` took any length
* and every one took a line break, printed whole by `status`. `field` names it in the refusal.
*/
function checkShownName(name, field = "name") {
	const shown = typeof name === "string" ? name.trim() : void 0;
	if (shown === void 0 || [...shown].length > 64 || /\p{Cc}/u.test(shown)) throw new CliError("bad_request", `${field} must be up to 64 characters on one line`);
	return shown;
}
function currentProfile(home, option) {
	if (option === "") throw new CliError("usage", "--profile needs a profile name");
	if (option !== void 0) return checkProfileName(option);
	if (process.env.GHOSTLY_PROFILE) return checkProfileName(process.env.GHOSTLY_PROFILE);
	const file = join(home, "current");
	if (existsSync(file)) {
		const name = readFileSync(file, "utf8").trim();
		if (name) return checkProfileName(name);
	}
	return DEFAULT_PROFILE;
}
function profileDir(home, name) {
	return join(home, "profiles", checkProfileName(name));
}
function profilePaths(home, name) {
	const dir = profileDir(home, name);
	return {
		name,
		dir,
		db: join(dir, "db"),
		socket: socketPath(dir),
		lock: join(dir, "daemon.lock"),
		events: join(dir, "events.jsonl"),
		files: join(dir, "files"),
		log: join(dir, "daemon.log")
	};
}
/**
* The daemon's socket: in the profile's folder, unless that path is longer than a Unix socket may be (104 bytes on
* macOS); then in a folder of /tmp named after the profile's, which the daemon makes owner-only and checks before
* use (`privateFolder`), and whose socket a client connects to only when it is this user's (`ownSocket`).
*/
function socketPath(dir) {
	const inside = join(dir, "daemon.sock");
	if (process.platform === "win32") return `\\\\.\\pipe\\ghostly-${createHash("sha256").update(dir).digest("hex").slice(0, 24)}`;
	if (Buffer.byteLength(inside) <= 100) return inside;
	return join("/tmp", `ghostly-${createHash("sha256").update(dir).digest("hex").slice(0, 24)}`, "daemon.sock");
}
function ensureFolder(path) {
	mkdirSync(path, {
		recursive: true,
		mode: 448
	});
}
/** Makes the profile's folder; refused when it exists and `existing` is not allowed. */
function createProfile(home, name, { existing = false } = {}) {
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
var RESTORED_MARK = "restored";
function profileExists(home, name) {
	return existsSync(profileDir(home, name));
}
function listProfiles(home) {
	const root = join(home, "profiles");
	if (!existsSync(root)) return [];
	return readdirSync(root).filter((name) => NAME.test(name) && statSync(join(root, name)).isDirectory()).sort();
}
function selectProfile(home, name) {
	if (!profileExists(home, name)) throw new CliError("not_found", `No profile ${name}`);
	ensureFolder(home);
	writeFileSync(join(home, "current"), name + "\n", { mode: 384 });
}
/**
* One process per profile: the daemon or a one-shot command. The lock holds the owner's pid; a lock whose
* process is gone is taken over.
*/
function acquireLock(paths) {
	for (let attempt = 0; attempt < 2; attempt++) try {
		const fd = openSync(paths.lock, "wx", 384);
		writeSync(fd, String(process.pid));
		closeSync(fd);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			try {
				if (readFileSync(paths.lock, "utf8").trim() === String(process.pid)) rmSync(paths.lock, { force: true });
			} catch {}
		};
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		const owner = lockOwner(paths);
		if (owner !== null) throw new CliError("busy", `Profile ${paths.name} is in use by process ${owner}`, { pid: owner });
		rmSync(paths.lock, { force: true });
	}
	throw new CliError("busy", `Profile ${paths.name} is in use`);
}
/** The pid holding the profile, or null when nobody (or a process that is gone) does. */
function lockOwner(paths) {
	let pid;
	try {
		pid = Number(readFileSync(paths.lock, "utf8").trim());
	} catch {
		return null;
	}
	if (!Number.isInteger(pid) || pid <= 0) return null;
	try {
		process.kill(pid, 0);
		return pid;
	} catch (error) {
		return error.code === "EPERM" ? pid : null;
	}
}
//#endregion
export { checkShownName as a, ghostlyHome as c, profileExists as d, profilePaths as f, checkProfileName as i, listProfiles as l, RESTORED_MARK as n, createProfile as o, selectProfile as p, acquireLock as r, currentProfile as s, DEFAULT_PROFILE as t, lockOwner as u };

//# sourceMappingURL=profiles-CI6Z0_ww.js.map