import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { ProfileKeyRecord } from "@ghostly/browser/shared/profileKey";
import { CliError, localFileError } from "./errors";
import { DEFAULT_PROFILE } from "./profiles";

/**
 * An encrypted profile on the CLI (WISP 04, Encrypted profile, Headless clients): the wrapped data key in
 * `<profile>/profile-key.json` (0600), opened with the profile's passphrase before the engine starts. The passphrase
 * comes from `--passphrase-file` (a path, or `/dev/fd/<n>`), else GHOSTLY_PROFILE_PASSPHRASE, else a prompt when stdin
 * is a terminal; never the command line. A profile without the file works as it always did.
 */
export const PROFILE_KEY = "profile-key.json";
export const PASSPHRASE_ENV = "GHOSTLY_PROFILE_PASSPHRASE";
/** Said by `profile backup` on an encrypted profile, before any passphrase is asked for. */
export const ENCRYPTED_BACKUP = "A backup of an encrypted profile is not supported yet: its secrets are sealed under the profile's key, which a backup does not carry";
/** `profile passphrase`'s new one, when it is not typed. */
export const NEW_PASSPHRASE_ENV = "GHOSTLY_PROFILE_NEW_PASSPHRASE";
/** Wrong passphrases in a row, kept beside the record: after FREE_ATTEMPTS, a wait that doubles from 1 s to 5 min. */
const ATTEMPTS = "profile-key.attempts";
const FREE_ATTEMPTS = 3;
const MAX_DELAY_MS = 5 * 60_000;
/** Tries a terminal gets before the command gives up. */
const PROMPTS = 3;

/** The id the record is bound to: the profile's name, empty for the default profile, as on the other clients. */
export const profileKeyId = (profile: string): string => (profile === DEFAULT_PROFILE ? "" : profile);

/** The profile's wrapped key record, or null when the profile is not encrypted. */
export function readProfileKey(dir: string): ProfileKeyRecord | null {
  let text: string;
  try { text = readFileSync(join(dir, PROFILE_KEY), "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw localFileError(error, join(dir, PROFILE_KEY)) ?? error;
  }
  try { return JSON.parse(text) as ProfileKeyRecord; } catch {
    throw new CliError("refused", `${join(dir, PROFILE_KEY)} is damaged: it is not the profile's key record`);
  }
}

/** Replaces the record in one write: a new file (0600), synced, renamed over the old one. */
export function writeProfileKey(dir: string, record: ProfileKeyRecord): void {
  const file = join(dir, PROFILE_KEY), next = `${file}.next`;
  rmSync(next, { force: true });
  const fd = openSync(next, "wx", 0o600);
  try { writeSync(fd, JSON.stringify(record) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(next, file);
  const folder = openSync(dir, "r");
  try { fsyncSync(folder); } catch { /* a file system that does not sync folders */ } finally { closeSync(folder); }
}

export interface PassphraseSource {
  /** `--passphrase-file`'s value, if given. */
  file?: unknown;
  /** The environment variable it may come from. */
  env: string;
  /** What a prompt says, and what the usage error names when there is no way to ask. */
  prompt: string;
  missing: string;
  /** A new passphrase is typed twice. */
  confirm?: boolean;
}

/** The I/O a prompt uses: the terminal, or a test's. */
export interface Terminal {
  isTTY: boolean;
  read(prompt: string): Promise<string>;
}

/** One passphrase, from the first of: the file, the environment, the terminal. Never from argv. */
export async function readPassphrase(source: PassphraseSource, terminal: Terminal = processTerminal()): Promise<string> {
  if (typeof source.file === "string") {
    let value: string;
    try { value = readFileSync(source.file, "utf8").replace(/\r?\n$/, ""); } catch (error) { throw localFileError(error, source.file) ?? error; }
    if (!value) throw new CliError("bad_request", `${source.file} is empty: it holds the profile's passphrase`);
    return value;
  }
  const value = process.env[source.env];
  if (value) return value;
  if (!terminal.isTTY) throw new CliError("usage", source.missing);
  const typed = await terminal.read(source.prompt);
  if (source.confirm && (await terminal.read("Type it again: ")) !== typed) throw new CliError("bad_request", "The two passphrases differ");
  if (!typed) throw new CliError("usage", source.missing);
  return typed;
}

interface Attempts { failures: number; retryAt: number }

function attempts(dir: string): Attempts {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, ATTEMPTS), "utf8")) as Partial<Attempts>;
    return { failures: Number(parsed.failures) || 0, retryAt: Number(parsed.retryAt) || 0 };
  } catch { return { failures: 0, retryAt: 0 }; }
}

/**
 * One try at the profile's passphrase, paced as the lock screen's are: three wrong ones are free, then each waits twice
 * as long as the last (1 s up to 5 min), across commands. It slows a person at the device, not a reader of the folder.
 */
export async function tryProfileKey<T>(dir: string, open: () => Promise<T>): Promise<T> {
  const before = attempts(dir), now = Date.now();
  if (before.retryAt > now) throw new CliError("refused", `Wrong passphrase. Try again in ${Math.ceil((before.retryAt - now) / 1000)} s`);
  let opened: T;
  try { opened = await open(); } catch (error) {
    if (!(error instanceof Error) || error.message !== "Wrong passphrase") throw new CliError("refused", error instanceof Error ? error.message : String(error));
    const failures = before.failures + 1;
    const retryAt = failures < FREE_ATTEMPTS ? 0 : Date.now() + Math.min(MAX_DELAY_MS, 1000 * 2 ** (failures - FREE_ATTEMPTS));
    try { writeSmall(join(dir, ATTEMPTS), JSON.stringify({ failures, retryAt })); } catch { /* a read-only folder: no pace */ }
    throw new CliError("refused", "Wrong passphrase");
  }
  if (before.failures) rmSync(join(dir, ATTEMPTS), { force: true });
  return opened;
}

function writeSmall(file: string, text: string): void {
  const fd = openSync(file, "w", 0o600);
  try { writeSync(fd, text); } finally { closeSync(fd); }
}

/**
 * The start gate: the profile's data key, unwrapped, before anything of the engine runs; null for a profile that is
 * not encrypted. A terminal gets PROMPTS tries; a file or the environment one.
 */
export function unlockProfile(dir: string, profile: string, file?: unknown, terminal: Terminal = processTerminal()): Promise<CryptoKey | null> {
  return withPassphrase(dir, profile, file, terminal, async (open) => (await open()).key);
}

/**
 * The passphrase, once it opened the record: `daemon --detach` checks it before it starts its child, which gets it on
 * a pipe (`/dev/fd/3`), never in its arguments or environment. Null for a profile that is not encrypted.
 */
export function checkedPassphrase(dir: string, profile: string, file?: unknown, terminal: Terminal = processTerminal()): Promise<string | null> {
  return withPassphrase(dir, profile, file, terminal, async (open) => (await open()).passphrase);
}

async function withPassphrase<T>(dir: string, profile: string, file: unknown, terminal: Terminal, take: (open: () => Promise<{ key: CryptoKey; passphrase: string }>) => Promise<T>): Promise<T | null> {
  const record = readProfileKey(dir);
  if (!record) return null;
  const { unlockProfileKey } = await import("@ghostly/browser/shared/profileKey");
  const source = profileSource(profile, file);
  const typed = typeof file !== "string" && !process.env[PASSPHRASE_ENV] && terminal.isTTY;
  for (let left = typed ? PROMPTS : 1; ; left--) {
    const passphrase = await readPassphrase(source, terminal);
    try {
      return await take(() => tryProfileKey(dir, async () => ({ key: await unlockProfileKey(record, passphrase, profileKeyId(profile)), passphrase })));
    } catch (error) {
      if (left <= 1 || !(error instanceof CliError) || error.message !== "Wrong passphrase") throw error;
      process.stderr.write("ghostly: Wrong passphrase\n");
    }
  }
}

/** Where an encrypted profile's passphrase comes from, as the usage error says it. */
export function profileSource(profile: string, file?: unknown): PassphraseSource {
  return {
    file, env: PASSPHRASE_ENV, prompt: `Passphrase of profile ${profile}: `,
    missing: `Profile ${profile} is encrypted: its passphrase comes from --passphrase-file, ${PASSPHRASE_ENV} or a terminal`,
  };
}

/**
 * `profile passphrase`: the same data key under a new passphrase, the record replaced in one write. Nothing else in
 * the profile is read or written, so it works while a daemon runs the profile.
 */
export async function changeProfilePassphrase(dir: string, profile: string, file: unknown, newFile: unknown, terminal: Terminal = processTerminal()): Promise<void> {
  const record = readProfileKey(dir);
  if (!record) throw new CliError("refused", `Profile ${profile} is not encrypted`);
  const { rewrapProfileKey } = await import("@ghostly/browser/shared/profileKey");
  const current = await readPassphrase({ ...profileSource(profile, file), prompt: `Current passphrase of profile ${profile}: ` }, terminal);
  const next = await readPassphrase({
    file: newFile, env: NEW_PASSPHRASE_ENV, prompt: "New passphrase (at least 12 characters): ", confirm: true,
    missing: `The new passphrase comes from --new-passphrase-file, ${NEW_PASSPHRASE_ENV} or a terminal`,
  }, terminal);
  if (next.length < 12) throw new CliError("bad_request", "Use at least 12 characters for the profile passphrase");
  writeProfileKey(dir, await tryProfileKey(dir, () => rewrapProfileKey(record, current, next, profileKeyId(profile))));
}

/** The process's terminal: stdin in raw mode, nothing echoed, the prompt on stderr. Ctrl-C leaves as an interrupt. */
export function processTerminal(): Terminal {
  const input = process.stdin;
  return {
    isTTY: input.isTTY === true && typeof input.setRawMode === "function",
    read: (prompt) => new Promise((resolve, reject) => {
      process.stderr.write(prompt);
      let typed = "";
      const done = (error?: CliError) => {
        input.off("data", onData);
        input.setRawMode(false);
        input.pause();
        process.stderr.write("\n");
        if (error) reject(error); else resolve(typed);
      };
      const onData = (chunk: Buffer) => {
        for (const char of chunk.toString("utf8")) {
          if (char === "\r" || char === "\n") return done();
          if (char === "\u0003") return done(new CliError("interrupted", "Stopped (Ctrl-C) before the passphrase was given"));
          if (char === "\u0004" && !typed) return done();
          if (char === "\u007f" || char === "\b") typed = typed.slice(0, -1);
          else if (char >= " ") typed += char;
        }
      };
      input.setRawMode(true);
      input.resume();
      input.on("data", onData);
    }),
  };
}
