import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { open as openEnvelope, seal } from "@ghostly/browser/backup/envelope";
import { str, type Method } from "./apiKit";
import { CliError } from "./errors";
import { createProfile, profileExists, type ProfilePaths } from "./profiles";

/**
 * A headless profile's backup: the WISP 05 envelope (PBKDF2 + AES-256-GCM, gzip) around the profile itself, its store
 * and its files. It restores into a new headless profile; the app's own backups are made from its page's storage and
 * are not this format (WISP 11xx § Parity).
 */
const FORMAT = "ghostly-cli-profile/1";

interface Payload { format: typeof FORMAT; createdAt: number; store: string; files: { path: string; data: string }[] }

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

export const BACKUP_METHODS: Record<string, Method> = {
  /** Writes the sealed backup to `path` (resolved by the command). The store is folded first, so the copy is whole. */
  async "profile.backup"(ctx, params) {
    const path = resolve(str(params, "path", true));
    if (existsSync(path)) throw new CliError("confirm", `${path} exists: choose another name`);
    const passphrase = str(params, "passphrase", true);
    await ctx.runtime.store.compact();
    const paths = ctx.runtime.paths;
    const files = await Promise.all((await walk(paths.files)).map(async (name) => ({ path: name.split(sep).join("/"), data: (await readFile(join(paths.files, name))).toString("base64") })));
    const payload: Payload = { format: FORMAT, createdAt: Date.now(), store: (await readFile(join(paths.db, "snapshot.bin"))).toString("base64"), files };
    let sealed: string;
    try { sealed = await seal(JSON.stringify(payload), passphrase); } catch (error) { throw new CliError("bad_request", error instanceof Error ? error.message : String(error)); }
    await writeFile(path, sealed, { mode: 0o600, flag: "wx" });
    return { path, bytes: Buffer.byteLength(sealed), files: files.length };
  },
};

/** Opens a backup into a new profile (never over an existing one). Runs with no engine: nothing is open yet. */
export async function restoreProfile(home: string, name: string, text: string, passphrase: string): Promise<ProfilePaths> {
  if (profileExists(home, name)) throw new CliError("refused", `Profile ${name} exists: restore into a new name`);
  let payload: Payload;
  try { payload = JSON.parse(await openEnvelope(text, passphrase)) as Payload; } catch (error) { throw new CliError("refused", error instanceof Error ? error.message : String(error)); }
  if (payload?.format !== FORMAT || typeof payload.store !== "string" || !Array.isArray(payload.files)) throw new CliError("refused", "This backup is not a headless Ghostly profile");
  const paths = createProfile(home, name);
  try {
    await mkdir(paths.db, { recursive: true, mode: 0o700 });
    await writeFile(join(paths.db, "snapshot.bin"), Buffer.from(payload.store, "base64"), { mode: 0o600 });
    for (const file of payload.files) {
      const target = resolve(paths.files, file.path);
      if (!target.startsWith(resolve(paths.files) + sep)) throw new CliError("refused", "The backup names a file outside its folder");
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, Buffer.from(file.data, "base64"), { mode: 0o600 });
    }
  } catch (error) {
    await rm(paths.dir, { recursive: true, force: true });
    throw error;
  }
  return paths;
}
