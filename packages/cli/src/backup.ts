import { existsSync } from "node:fs";
import { link, mkdir, open, readdir, readFile, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { open as openEnvelope } from "@ghostly/browser/backup/envelope";
import { BackupReader, BackupWriter, FRAME_BYTES, backupProtection, type BackupSource } from "@ghostly/browser/backup/stream";
import { LIGHT_FILE_BYTES, LIGHT_VOICE_BYTES, keptInLight, type LightMark } from "@ghostly/browser/backup/light";
import { fileStore } from "@ghostly/browser/shared/idb";
import { bool, str, type Method } from "./apiKit";
import { CliError } from "./errors";
import { RESTORED_MARK, profileExists, profilePaths, type ProfilePaths } from "./profiles";

/**
 * A headless profile's backup: the WISP 05 envelope around the profile itself, its store and its files, written and
 * read a piece at a time (envelope version 2), so a profile with large files never has to fit in memory. It restores
 * into a new headless profile; the app's own backups are made from its page's storage and are not this format
 * (WISP 11xx § Parity). A backup an older CLI made (version 1: everything in one sealed JSON document) still restores.
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
  | { t: "end"; files: number; bytes: number };

async function walk(root: string, dir = root, out: string[] = []): Promise<string[]> {
  let names: string[];
  try { names = await readdir(dir); } catch { return out; }
  for (const name of names) {
    const path = join(dir, name);
    if ((await stat(path)).isDirectory()) await walk(root, path, out);
    else out.push(relative(root, path));
  }
  return out;
}

/** A file's first `size` bytes into the backup, a frame at a time. One that got shorter meanwhile stops the backup. */
async function copyIn(writer: BackupWriter, path: string, size: number): Promise<void> {
  const handle = await open(path, "r");
  try {
    const buffer = new Uint8Array(FRAME_BYTES);
    for (let at = 0; at < size;) {
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
   * `noPassphrase` is true: one of the two, never a guess. The store is folded first, so the copy is whole. It is
   * written beside `path` and only takes its name once it is complete: a backup that fails leaves no file. `light`:
   * the files over the cut (`keptInLight`) are left out, their records kept.
   */
  async "profile.backup"(ctx, params) {
    const path = resolve(str(params, "path", true));
    if (existsSync(path)) throw new CliError("confirm", `${path} exists: choose another name`);
    const passphrase = str(params, "passphrase"), unsealed = bool(params, "noPassphrase");
    if (!passphrase && !unsealed) throw new CliError("bad_request", "passphrase is required (or noPassphrase: true for a backup anyone can read)");
    if (passphrase && unsealed) throw new CliError("bad_request", "Give a passphrase or noPassphrase, not both");
    await ctx.runtime.store.compact();
    const paths = ctx.runtime.paths;
    const store = join(paths.db, "snapshot.bin");
    const light = bool(params, "light");
    const all = await Promise.all((await walk(paths.files)).map(async (name) => ({ name, size: (await stat(join(paths.files, name))).size })));
    // A file's name is its id: only one that could be a voice message under its larger cut is looked up.
    const kept = async (file: { name: string; size: number }) => keptInLight(file.size, false) || (file.size <= LIGHT_VOICE_BYTES && !!(await fileStore.get(basename(file.name)).catch(() => undefined))?.metadata?.voice);
    const files: typeof all = [], leftOut: typeof all = [];
    for (const file of all) (!light || (await kept(file)) ? files : leftOut).push(file);
    const storeSize = (await stat(store)).size, bytes = files.reduce((sum, file) => sum + file.size, 0);
    const leftOutBytes = leftOut.reduce((sum, file) => sum + file.size, 0);

    const partial = `${path}.partial-${process.pid}`;
    let out: FileHandle | null = null;
    try {
      out = await openFile(partial);
      const handle = out;
      let writer: BackupWriter;
      try { writer = await BackupWriter.start({ write: async (chunk) => { await handle.write(chunk); } }, unsealed ? null : passphrase!); } catch (error) { throw new CliError("bad_request", error instanceof Error ? error.message : String(error)); }
      const put = (record: BackupRecord) => writer.json(JSON.stringify(record));
      await put({ t: "profile", format: FORMAT, createdAt: Date.now(), files: files.length, bytes, ...(light && { light: { maxFileBytes: LIGHT_FILE_BYTES, maxVoiceBytes: LIGHT_VOICE_BYTES, files: leftOut.length, bytes: leftOutBytes, ids: leftOut.map((file) => basename(file.name)) } }) });
      await put({ t: "file", kind: "store", size: storeSize });
      await copyIn(writer, store, storeSize);
      for (const file of files) {
        await put({ t: "file", kind: "file", path: file.name.split(sep).join("/"), size: file.size });
        await copyIn(writer, join(paths.files, file.name), file.size);
      }
      await put({ t: "end", files: files.length, bytes });
      const written = await writer.finish();
      await handle.sync();
      await handle.close();
      out = null;
      // Its name only now, and never over a file that appeared meanwhile.
      try { await link(partial, path); } catch (error) { throw (error as NodeJS.ErrnoException).code === "EEXIST" ? new CliError("confirm", `${path} exists: choose another name`) : error; }
      return { path, bytes: written, files: files.length, protection: unsealed ? "none" : "passphrase", ...(light && { light: true, leftOut: leftOut.length, leftOutBytes }) };
    } finally {
      await out?.close().catch(() => {});
      await rm(partial, { force: true });
    }
  },
};

async function openFile(path: string): Promise<FileHandle> {
  try { return await open(path, "wx", 0o600); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") { await rm(path, { force: true }); return open(path, "wx", 0o600); }
    throw error;
  }
}

/** A file on disk as a backup's source: read in ranges, never whole. */
async function fileSource(path: string): Promise<BackupSource & { close(): Promise<void> }> {
  const handle = await open(path, "r");
  const { size } = await handle.stat();
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

/** Whether the backup at `file` is sealed with a passphrase or was made without one, read from its clear header. */
export async function backupFileProtection(file: string): Promise<"passphrase" | "none"> {
  const source = await fileSource(file);
  try { return await backupProtection(source); } finally { await source.close(); }
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
