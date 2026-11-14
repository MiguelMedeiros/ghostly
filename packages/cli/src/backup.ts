import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { link, mkdir, open, readdir, readFile, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { open as openEnvelope } from "@ghostly/browser/backup/envelope";
import { BackupReader, BackupWriter, FRAME_BYTES, readBackupHeader, type BackupSource } from "@ghostly/browser/backup/stream";
import { LIGHT_FILE_BYTES, LIGHT_VOICE_BYTES, keptInLight, type LightMark } from "@ghostly/browser/backup/light";
import { fileStore } from "@ghostly/browser/shared/idb";
import { bool, str, type Method } from "./apiKit";
import { CliError, localFileError } from "./errors";
import { RESTORED_MARK, profileExists, profilePaths, type ProfilePaths } from "./profiles";

/**
 * A headless profile's backup: the WISP 05 envelope around the profile itself, its store and its files, written and
 * read a piece at a time (envelope version 2), so a profile with large files never has to fit in memory. It restores
 * into a new headless profile; the app's own backups are made from its page's storage and are not this format
 * (WISP 1100 § Parity). A backup an older CLI made (version 1: everything in one sealed JSON document) still restores.
 */
const FORMAT = "ghostly-cli-profile/2";
const FORMAT_1 = "ghostly-cli-profile/1";

/** Version 1: the store and every file as base64 in one document. */
interface Payload1 { format: typeof FORMAT_1; createdAt: number; store: string; files: { path: string; data: string }[] }
/** Version 2, in order: the head, then each file (the store first) followed by its bytes, then the end. */
/**
 * `light`: a light backup (WISP 05 § Light backups) left the bytes of these files out. Their records are in the store;
 * the restored profile marks them when it first starts (`markLeftOutFiles`).
 */
type BackupRecord =
  | { t: "profile"; format: typeof FORMAT; createdAt: number; files: number; bytes: number; light?: LightMark & { ids: string[] } }
  | { t: "file"; kind: "store" | "file"; path?: string; size: number }
  | { t: "setting"; name: string; text: string }
  | { t: "end"; files: number; bytes: number };

/**
 * The profile's settings kept beside its store: auto-join (`groups.json`) and auto-answer (`calls.json`), which name its
 * chats and their contacts' keys, the chats held off their direct link (`holds.json`, `chat disconnect --hold`: the
 * store has such a chat on DHT only, and only this file says it comes back; the restored daemon ends a hold whose time
 * passed meanwhile at its start), and the apps it serves as a bot (`apps.json`, `app serve`: the engine offers apps/1
 * only while it holds one). Each travels as a `setting` record (an older CLI skips it); a backup without them restores
 * with auto-join and auto-answer off, no hold and no app served.
 */
const HOLDS = "holds.json";
const SETTINGS = ["groups.json", "calls.json", HOLDS, "apps.json"];

/** A setting's text, or null for one the profile never wrote. */
const readSetting = (dir: string, name: string) => readFile(join(dir, name), "utf8").catch(unlessGone);

/** The holds a read of holds.json names (`holds.ts`), none for a file that does not parse, as the daemon reads it. */
function parseHolds(text: string | undefined): Record<string, unknown> {
  try {
    const holds: unknown = JSON.parse(text ?? "{}");
    return holds && typeof holds === "object" && !Array.isArray(holds) ? holds as Record<string, unknown> : {};
  } catch { return {}; }
}

/**
 * Null for a file the profile removed since it was named (a deleted or disappearing message's, a group's files): the
 * daemon goes on while a backup runs, and such a file is left out of it, as one the profile no longer has.
 */
const unlessGone = (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; };

/**
 * The files a backup under way writes (the store in the clear, the backup not complete yet), removed if the process
 * leaves before the backup's own cleanup: Ctrl-C on a one-shot exits once the profile closed, the backup still running.
 */
const leftOnExit = new Set<string>();
process.on("exit", () => { for (const path of leftOnExit) rmSync(path, { force: true }); });

async function walk(root: string, dir = root, out: string[] = []): Promise<string[]> {
  let names: string[];
  try { names = await readdir(dir); } catch { return out; }
  for (const name of names) {
    const path = join(dir, name);
    const found = await stat(path).catch(unlessGone);
    if (!found) continue;
    if (found.isDirectory()) await walk(root, path, out);
    else out.push(relative(root, path));
  }
  return out;
}

/**
 * A backup whose client went away (`CallScope.gone`: Ctrl-C on `profile backup` sent through a daemon, which said it
 * stopped) stops here, and its cleanup removes what it wrote. The daemon went on and wrote the whole backup, unsealed
 * with --no-passphrase, where the person was told none was made.
 */
function stillAsked(gone: AbortSignal | undefined): void {
  if (gone?.aborted) throw new CliError("interrupted", "The backup was stopped: the command that asked for it went away before it was written");
}

/**
 * A file's first `size` bytes into the backup, a frame at a time. One that got shorter meanwhile stops the backup.
 * `buffer` (`FRAME_BYTES`) is the backup's one for every file: a new one each zero-filled 1 MiB, for a 1 KB file too,
 * and 50,000 small files took half a minute. The writer copies each frame before `bytes` returns.
 */
async function copyIn(writer: BackupWriter, buffer: Uint8Array, path: string, size: number, opened?: FileHandle, gone?: AbortSignal): Promise<void> {
  const handle = opened ?? await open(path, "r");
  try {
    for (let at = 0; at < size;) {
      stillAsked(gone);
      const { bytesRead } = await handle.read(buffer, 0, Math.min(FRAME_BYTES, size - at), at);
      if (!bytesRead) throw new CliError("unavailable", `${path} changed while it was backed up: try again`);
      await writer.bytes(buffer.subarray(0, bytesRead));
      at += bytesRead;
    }
  } finally { await handle.close(); }
}

export const BACKUP_METHODS: Record<string, Method> = {
  /**
   * Writes the backup to `path` (resolved by the command), sealed with `passphrase`, or not encrypted when
   * `noPassphrase` is true: one of the two, never a guess. The store is written whole for it, every value inline. It is
   * written beside `path` and only takes its name once it is complete: a backup that fails leaves no file. `light`:
   * the files over the cut (`keptInLight`) are left out, their records kept.
   */
  async "profile.backup"(ctx, params, call) {
    const gone = call?.gone;
    const asked = str(params, "path", true), path = resolve(asked);
    // A folder is no name for the backup: one there was "exists: choose another name", as if a file were in the way,
    // and one with a separator at its end and no folder there became a file of that name (resolve() drops the slash).
    if (asked.endsWith("/") || asked.endsWith(sep) || (await stat(path).catch(() => undefined))?.isDirectory()) {
      throw new CliError("bad_request", `${path} names a folder: name the backup's file in it, e.g. --out ${join(path, "<name>.ghostly-backup")} (path over the socket)`);
    }
    // `refused`, not `confirm` (exit 5, "pass --force"): backup takes no flag that writes over a file.
    if (existsSync(path)) throw new CliError("refused", `${path} exists: choose another name`);
    const passphrase = str(params, "passphrase"), unsealed = bool(params, "noPassphrase");
    if (!passphrase && !unsealed) throw new CliError("bad_request", "passphrase is required (or noPassphrase: true for a backup anyone can read)");
    if (passphrase && unsealed) throw new CliError("bad_request", "Give a passphrase or noPassphrase, not both");
    // The folder it goes in, checked first: a missing one is named, not the file written beside `path`.
    const folder = dirname(path);
    if (!(await stat(folder)).isDirectory()) throw new CliError("not_found", `No such file or folder: ${folder}`);
    const paths = ctx.runtime.paths;
    // The store as one snapshot with every value in it (the messages too, which the profile keeps in rows.db): a backup
    // any ghostly restores, this one or an older one. Its name is this backup's own: two at once in one daemon shared
    // one by the process id, and the first packed the other's store as its own, or removed it under the other.
    const store = join(paths.db, `backup-store-${process.pid}-${randomBytes(6).toString("hex")}.bin`);
    // The settings before the store, and the holds again after it, the backup keeping both reads' holds: a hold that
    // ends in between is in the backup with its chat already back on its live link (the restored daemon ends it,
    // nothing more), and one that starts in between (`holdChat` writes it before the chat goes on DHT only) is in it
    // too. Never the chat on DHT only with no hold to end.
    const settings: { name: string; text: string }[] = [];
    for (const name of SETTINGS) {
      const text = await readSetting(paths.dir, name);
      if (text !== null) settings.push({ name, text });
    }
    // Its own name too: two backups to one path in one daemon shared `<path>.partial-<pid>`, the second removed the
    // first's half-written file as one left by a stopped backup, and the first gave the path the second's file.
    const partial = `${path}.partial-${process.pid}-${randomBytes(6).toString("hex")}`;
    let out: FileHandle | null = null, writing = false;
    // From its export on, the store (every message and key in the clear) goes however the backup ends: an export cut
    // short, a failure before the backup is written, and a process that leaves first (Ctrl-C on a one-shot), the
    // half-written backup with it. One a killed process left goes at the profile's next start (`startRuntime`).
    leftOnExit.add(store).add(partial);
    try {
      await ctx.runtime.store.exportSnapshot(store);
      stillAsked(gone);
      const holds = settings.find((setting) => setting.name === HOLDS), after = await readSetting(paths.dir, HOLDS);
      if (after !== null && after !== holds?.text) {
        const text = JSON.stringify({ ...parseHolds(holds?.text), ...parseHolds(after) }) + "\n";
        if (holds) holds.text = text; else settings.push({ name: HOLDS, text });
      }
      const light = bool(params, "light");
      const found = await Promise.all((await walk(paths.files)).map(async (name) => {
        const file = await stat(join(paths.files, name)).catch(unlessGone);
        return file && { name, size: file.size };
      }));
      const all = found.filter((file) => file !== null);
      // A file's name is its id: only one that could be a voice message under its larger cut is looked up.
      const kept = async (file: { name: string; size: number }) => keptInLight(file.size, false) || (file.size <= LIGHT_VOICE_BYTES && !!(await fileStore.get(basename(file.name)).catch(() => undefined))?.metadata?.voice);
      const files: typeof all = [], leftOut: typeof all = [];
      for (const file of all) (!light || (await kept(file)) ? files : leftOut).push(file);
      const storeSize = (await stat(store)).size, bytes = files.reduce((sum, file) => sum + file.size, 0);
      const leftOutBytes = leftOut.reduce((sum, file) => sum + file.size, 0);

      writing = true;
      out = await open(partial, "wx", 0o600);
      const handle = out;
      let writer: BackupWriter;
      try { writer = await BackupWriter.start({ write: async (chunk) => { await handle.write(chunk); } }, unsealed ? null : passphrase!); } catch (error) { throw localFileError(error, path) ?? new CliError("bad_request", error instanceof Error ? error.message : String(error)); }
      const put = (record: BackupRecord) => writer.json(JSON.stringify(record));
      await put({ t: "profile", format: FORMAT, createdAt: Date.now(), files: files.length, bytes, ...(light && { light: { maxFileBytes: LIGHT_FILE_BYTES, maxVoiceBytes: LIGHT_VOICE_BYTES, files: leftOut.length, bytes: leftOutBytes, ids: leftOut.map((file) => basename(file.name)) } }) });
      await put({ t: "file", kind: "store", size: storeSize });
      const buffer = new Uint8Array(FRAME_BYTES);
      await copyIn(writer, buffer, store, storeSize, undefined, gone);
      // Each file opened before its record: one removed since the walk is left out, and the end counts what went in.
      let copied = 0, copiedBytes = 0;
      for (const file of files) {
        const path = join(paths.files, file.name), handle = await open(path, "r").catch(unlessGone);
        if (!handle) continue;
        await put({ t: "file", kind: "file", path: file.name.split(sep).join("/"), size: file.size });
        await copyIn(writer, buffer, path, file.size, handle, gone);
        copied++;
        copiedBytes += file.size;
      }
      for (const { name, text } of settings) await put({ t: "setting", name, text });
      await put({ t: "end", files: copied, bytes: copiedBytes });
      const written = await writer.finish();
      await handle.sync();
      await handle.close();
      out = null;
      // Its name only now, and never over a file that appeared meanwhile, nor once nobody asks for it.
      stillAsked(gone);
      try { await link(partial, path); } catch (error) { throw (error as NodeJS.ErrnoException).code === "EEXIST" ? new CliError("refused", `${path} exists: choose another name`) : error; }
      return { path, bytes: written, files: copied, protection: unsealed ? "none" : "passphrase", ...(light && { light: true, leftOut: leftOut.length, leftOutBytes }) };
    } catch (error) {
      // A write into the backup that found its disk full names the backup, not Node's bare "write". The store's export
      // writes into the profile, maybe on another disk: not named as the backup.
      const code = (error as NodeJS.ErrnoException)?.code;
      if (writing && (code === "ENOSPC" || code === "EDQUOT")) throw localFileError(error, path) ?? error;
      throw error;
    } finally {
      await out?.close().catch(() => {});
      await rm(partial, { force: true });
      await rm(store, { force: true });
      leftOnExit.delete(store);
      leftOnExit.delete(partial);
    }
  },
};

/** A file on disk as a backup's source: read in ranges, never whole. A folder opens, and is refused as one here. */
async function fileSource(path: string): Promise<BackupSource & { close(): Promise<void> }> {
  const handle = await open(path, "r");
  const found = await handle.stat();
  if (found.isDirectory()) { await handle.close(); throw new CliError("bad_request", `${path} is a folder: name a file`); }
  const { size } = found;
  return {
    size,
    read: async (offset, length) => {
      const buffer = new Uint8Array(Math.max(0, Math.min(length, size - offset)));
      let got = 0;
      while (got < buffer.length) { const { bytesRead } = await handle.read(buffer, got, buffer.length - got, offset + got); if (!bytesRead) break; got += bytesRead; }
      return buffer.subarray(0, got);
    },
    close: () => handle.close(),
  };
}

/** A version 1 backup is one JSON object, and `seal` writes its format first. */
const VERSION_1_START = /^\s*\{\s*"format"\s*:\s*"ghostly-backup"/;

/**
 * Whether the backup at `file` is sealed with a passphrase or was made without one, read from its clear header.
 * A file that is neither version is refused here, before any passphrase is asked for: the path is what is wrong.
 */
export async function backupFileProtection(file: string): Promise<"passphrase" | "none"> {
  const source = await fileSource(file);
  try {
    let found: Awaited<ReturnType<typeof readBackupHeader>>;
    try { found = await readBackupHeader(source); } catch (error) { throw new CliError("refused", error instanceof Error ? error.message : String(error)); }
    if (found) return found.header.protection;
    if (!VERSION_1_START.test(new TextDecoder().decode(await source.read(0, 256)))) throw new CliError("refused", "This is not a Ghostly backup");
    return "passphrase";
  } finally { await source.close(); }
}

/** Where a path named by a backup lands inside the new profile's files folder; never outside it. */
function inside(root: string, path: unknown): string {
  const target = typeof path === "string" && path ? resolve(root, path) : "";
  if (!target.startsWith(resolve(root) + sep)) throw new CliError("refused", "The backup names a file outside its folder");
  return target;
}

/** While a restore writes it, the profile's folder is not a profile: no profile name starts with a dot (`listProfiles`). */
const RESTORING = /^\.restoring-(.+)-(\d+)$/;

/**
 * The folder a restore writes into, beside the profiles: it takes the profile's name only once everything is in it,
 * so a restore that is stopped at any moment (Ctrl-C, a kill, the power) leaves no profile, whole or half-made.
 * What an earlier restore that was stopped left behind is removed here, once the process that made it is gone.
 */
async function restoringFolder(home: string, name: string): Promise<ProfilePaths> {
  const root = join(home, "profiles");
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(root)) {
    const pid = Number(RESTORING.exec(entry)?.[2]);
    if (!pid) continue;
    let alive = pid === process.pid;
    if (!alive) try { process.kill(pid, 0); alive = true; } catch (error) { alive = (error as NodeJS.ErrnoException).code === "EPERM"; }
    if (!alive) await rm(join(root, entry), { recursive: true, force: true });
  }
  const dir = join(root, `.restoring-${name}-${process.pid}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { mode: 0o700 });
  return { ...profilePaths(home, name), dir, db: join(dir, "db"), files: join(dir, "files") };
}

/**
 * The folder is whole: marked as a restored copy (`RESTORED_MARK`, which names the files a light backup left out),
 * then given the profile's name. Never over a profile.
 */
async function finishRestore(home: string, name: string, work: ProfilePaths, leftOut: string[] = []): Promise<ProfilePaths> {
  const paths = profilePaths(home, name);
  await writeFile(join(work.dir, RESTORED_MARK), leftOut.length ? JSON.stringify({ leftOut }) : "", { mode: 0o600 });
  if (existsSync(paths.dir)) throw new CliError("refused", `Profile ${name} exists: restore into a new name`);
  await rename(work.dir, paths.dir);
  return paths;
}

/**
 * Opens the backup at `file` into a new profile (never over an existing one), with its passphrase when it has one.
 * Runs with no engine: nothing is open yet. A backup that is refused, damaged or cut short leaves no profile behind,
 * and neither does a restore that is stopped while it runs (`restoringFolder`). The profile is marked as a restored
 * copy: its engine, the first time it starts, treats the money in it as a restore does (`RESTORED_MARK`).
 */
export async function restoreProfile(home: string, name: string, file: string, passphrase?: string): Promise<ProfilePaths> {
  if (profileExists(home, name)) throw new CliError("refused", `Profile ${name} exists: restore into a new name`);
  const source = await fileSource(file);
  let work: ProfilePaths | null = null;
  try {
    let reader: BackupReader | null;
    try { reader = await BackupReader.open(source, passphrase); } catch (error) { throw new CliError("refused", error instanceof Error ? error.message : String(error)); }
    if (!reader) {
      const payload = await readWhole(file, passphrase ?? "");
      work = await restoringFolder(home, name);
      await writeWhole(work, payload);
      return await finishRestore(home, name, work);
    }
    const next = async () => { try { return await reader.next(); } catch (error) { throw new CliError("refused", error instanceof Error ? error.message : String(error)); } };
    const parse = (json: string) => { try { return JSON.parse(json) as BackupRecord; } catch { throw new CliError("refused", "This backup is damaged: it was changed or cut short"); } };

    // The first record is read (and with it the passphrase checked) before any folder is made.
    const first = await next();
    const head = first?.json === undefined ? null : parse(first.json);
    if (head?.t !== "profile" || head.format !== FORMAT) throw new CliError("refused", "This backup is not a headless Ghostly profile");
    const leftOut = Array.isArray(head.light?.ids) ? head.light.ids.filter((id): id is string => typeof id === "string") : [];
    work = await restoringFolder(home, name);
    const paths = work;
    await mkdir(paths.db, { recursive: true, mode: 0o700 });
    let out: { handle: FileHandle; left: number } | null = null, files = 0, bytes = 0, ended = false, stored = false;
    try {
      for (let record = await next(); record; record = await next()) {
        if (ended) throw new CliError("refused", "This backup is damaged: it was changed or cut short");
        if (record.bytes) {
          if (!out || record.bytes.length > out.left) throw new CliError("refused", "This backup is damaged: it was changed or cut short");
          await out.handle.write(record.bytes);
          out.left -= record.bytes.length;
          continue;
        }
        if (out) { if (out.left) throw new CliError("refused", "This backup is damaged: it was changed or cut short"); await out.handle.close(); out = null; }
        const value = parse(record.json);
        if (value.t === "end") { ended = value.files === files && value.bytes === bytes; if (!ended) throw new CliError("refused", "This backup is damaged: it was changed or cut short"); continue; }
        if (value.t === "setting") {
          if (SETTINGS.includes(value.name) && typeof value.text === "string") {
            try { await writeFile(join(paths.dir, value.name), value.text, { mode: 0o600, flag: "wx" }); } catch (error) { throw (error as NodeJS.ErrnoException).code === "EEXIST" ? new CliError("refused", "This backup is damaged: it was changed or cut short") : error; }
          }
          continue;
        }
        if (value.t !== "file" || !Number.isSafeInteger(value.size) || value.size < 0) continue;
        let target: string;
        if (value.kind === "store") { target = join(paths.db, "snapshot.bin"); stored = true; }
        else { target = inside(paths.files, value.path); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); files += 1; bytes += value.size; }
        out = { handle: await open(target, "wx", 0o600), left: value.size };
      }
      if (out || !ended || !stored) throw new CliError("refused", "This backup is damaged: it was changed or cut short");
    } finally { await out?.handle.close().catch(() => {}); }
    return await finishRestore(home, name, work, leftOut);
  } catch (error) {
    if (work) await rm(work.dir, { recursive: true, force: true });
    throw error;
  } finally {
    await source.close();
  }
}

/** A version 1 backup: one sealed JSON document, read whole. */
async function readWhole(file: string, passphrase: string): Promise<Payload1> {
  let payload: Payload1;
  try { payload = JSON.parse(await openEnvelope(await readFile(file, "utf8"), passphrase)) as Payload1; } catch (error) { throw new CliError("refused", error instanceof Error ? error.message : String(error)); }
  if (payload?.format !== FORMAT_1 || typeof payload.store !== "string" || !Array.isArray(payload.files)) throw new CliError("refused", "This backup is not a headless Ghostly profile");
  return payload;
}

async function writeWhole(paths: ProfilePaths, payload: Payload1): Promise<void> {
  await mkdir(paths.db, { recursive: true, mode: 0o700 });
  await writeFile(join(paths.db, "snapshot.bin"), Buffer.from(payload.store, "base64"), { mode: 0o600 });
  for (const entry of payload.files) {
    const target = inside(paths.files, entry.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, Buffer.from(entry.data, "base64"), { mode: 0o600 });
  }
}
