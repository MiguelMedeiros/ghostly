import { spawn } from "node:child_process";
import { connect } from "node:net";
import { openSync, readFileSync } from "node:fs";
import packageJson from "../package.json" with { type: "json" };
import { GLOBAL_OPTIONS, liftGlobals, parseArgs, type OptionSpec, type Parsed } from "./args";
import { callApi, redactSettings } from "./api";
import { connectDaemon, type DaemonClient } from "./client";
import { COMMANDS, idSlot, positionals, TEXT_COMMANDS } from "./commands";
import { ENGINE_METHODS, ENGINE_READS, SECRET_RESULTS } from "./engineMethods";
import { asCliError, CliError, EXIT } from "./errors";
import type { GhostlyEvent } from "./events";
import { keepServing, openHost, serve, type Host } from "./host";
import { allowlist, checkWebhook, eventHandler, readCursor } from "./listen";
import { resolve } from "node:path";
import { format } from "node:util";
import { backupFileProtection, restoreProfile } from "./backup";
import { buttonsOf } from "./buttons";
import { secretsFromStdin } from "./secretInput";
import {
  checkProfileName, createProfile, currentProfile, DEFAULT_PROFILE, ghostlyHome, listProfiles, lockOwner, profileExists, profilePaths, selectProfile,
  type ProfilePaths,
} from "./profiles";

const VERSION = packageJson.version;

interface Globals { home: string; profile: string; paths: ProfilePaths; pretty: boolean }

let pretty = false;
function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, pretty ? 2 : undefined) + "\n");
}

function globals(parsed: Parsed): Globals {
  const home = ghostlyHome(parsed.options.home as string | undefined);
  const profile = currentProfile(home, parsed.options.profile as string | undefined);
  return { home, profile, paths: profilePaths(home, profile), pretty: parsed.options.pretty === true };
}

/** The profile must exist; `default` is made on first use, any other with `profile create`. */
function requireProfile(g: Globals): void {
  if (profileExists(g.home, g.profile)) return;
  if (g.profile === DEFAULT_PROFILE) { createProfile(g.home, g.profile); return; }
  throw new CliError("not_found", `No profile ${g.profile}: make it with \`ghostly profile create ${g.profile}\``);
}

/** A way to call the API: the daemon's socket when one runs the profile, else the profile in this process. */
interface Session { mode: "daemon" | "one-shot"; call(method: string, params?: unknown): Promise<unknown>; close(): Promise<void> }

/** Said on stderr when the daemon runs another release than this command (it started before an upgrade). */
export function versionWarning(daemon: unknown, cli: string): string | null {
  if (typeof daemon !== "string" || daemon === cli) return null;
  return `ghostly: the daemon runs ${daemon} and this command is ${cli}: \`ghostly daemon restart\` runs the new code`;
}

async function warnVersion(client: DaemonClient): Promise<void> {
  const status = await client.call("status").catch(() => null) as { version?: unknown } | null;
  const warning = versionWarning(status?.version, VERSION);
  if (warning) process.stderr.write(warning + "\n");
}

/**
 * A command about one 1:1 chat: a one-shot for it leaves the groups' sessions unstarted. A fresh process starts an edge
 * per group member, and their first polls spent the relays' 30 requests a minute in seconds: the chat's message then
 * waited for the next minute (60 s and more instead of 3 to 5).
 */
export function chatOnly(method: string, params: Record<string, unknown>): boolean {
  // A status card's `chat` may name a group as well (WISP 4xx · Status Cards): its sessions must start.
  if (method.startsWith("task.") || method.startsWith("routine.") || method.startsWith("button.")) return false;
  return method.startsWith("chat.") || (params.chat !== undefined && params.group === undefined && !method.startsWith("group."));
}

async function session(g: Globals, chat = false): Promise<Session> {
  requireProfile(g);
  const client = await connectDaemon(g.paths.socket);
  if (client) await warnVersion(client);
  if (client) return { mode: "daemon", call: (m, p) => client.call(m, p), close: async () => client.close() };
  const host = await openHost(g.paths, "one-shot", VERSION, { deferGroups: chat });
  return { mode: "one-shot", call: (m, p) => callApi(host.ctx, m, p ?? {}), close: () => host.close() };
}

/** `chat`: the command is about one 1:1 chat (`chatOnly`), and a one-shot needs nothing of the groups. */
async function withSession<T>(g: Globals, work: (s: Session) => Promise<T>, chat = false): Promise<T> {
  const s = await session(g, chat);
  try { return await work(s); } finally { await s.close(); }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// ---------- help ----------

const o = (type: OptionSpec["type"], description: string): OptionSpec => ({ type, description });

/** Commands with their own flow (main.ts), as help shows them. */
const SPECIAL: [usage: string, summary: string, options?: Record<string, OptionSpec>][] = [
  ["profile create <name> [--use] [--name <shown name>]", "Make a profile (its own keys, chats and wallets)", { use: o("boolean", "Make it the current profile"), name: o("string", "The name contacts see") }],
  ["profile list", "Profiles, and which one is current"],
  ["profile use <name>", "Make a profile the current one"],
  ["profile show", "The name contacts see, and whether it is shared"],
  ["profile set [--name <name>] [--share-profile | --no-share-profile]", "Change the name contacts see", { name: o("string", "The name contacts see"), "share-profile": o("boolean", "Share the name and picture with contacts (--no-share-profile: do not)") }],
  ["profile backup --out <file> [--passphrase-file f | --no-passphrase]", "A backup of the profile, encrypted with a passphrase (from a file or GHOSTLY_BACKUP_PASSPHRASE); --no-passphrase makes one anyone can read", { out: o("string", "The backup file to write"), "passphrase-file": o("string", "The passphrase, from this file (else GHOSTLY_BACKUP_PASSPHRASE)"), passphrase: o("boolean", "--no-passphrase: do not encrypt. The file then holds the profile's keys and wallet secrets in the clear") }],
  ["profile restore <file> <new profile> [--passphrase-file f] [--use]", "A backup into a new profile (a backup made with --no-passphrase needs none)", { "passphrase-file": o("string", "The passphrase, from this file (else GHOSTLY_BACKUP_PASSPHRASE)"), use: o("boolean", "Make it the current profile") }],
  ["daemon [--detach]", "Keep the profile online (foreground; --detach runs it in the background)", { detach: o("boolean", "Run in the background (log in the profile folder)"), timeout: o("number", "Seconds --detach waits for it to start (default 60)") }],
  ["daemon status", "Whether a daemon runs the profile, its version, and its socket (for the socket API)"],
  ["daemon stop", "Stop the profile's daemon", { timeout: o("number", "Seconds to wait for it to stop (default 20)") }],
  ["daemon restart", "Stop the profile's daemon and start it again in the background (after an upgrade: the new code)", { timeout: o("number", "Seconds to wait for each step") }],
  ["listen [--since seq] [--cursor file] [--type t]... [--turns] [--from <chat|key>]... [--group <group>]... [--exec cmd] [--webhook url] [--print]", "Stream events as JSON lines (starts the profile here if no daemon runs it)", {
    since: o("number", "Replay events after this seq first"), cursor: o("string", "A file that keeps the last seq handled (read at start, written after each event)"),
    type: o("list", "Only events of this type, or starting with it (repeat for more)"),
    turns: o("boolean", "Only agent turns: each message received, and each group message that mentions you, as one agent.turn event"),
    from: o("list", "Only this chat's events (id, prefix, name or the contact's key; again for more)"),
    group: o("list", "Only this group's events (again for more); with --from or --group, nobody else's event gets through"),
    exec: o("string", "Run this command per event, the event as JSON on stdin"),
    webhook: o("string", "POST each event to this URL"), print: o("boolean", "Print events too when --exec or --webhook handles them"),
  }],
  ["settings get [--show-secret]", "The profile's settings", { "show-secret": o("boolean", "Show credentials too") }],
  ["settings set <key> <json-value>", "Change one: relays, irohRelays, hyperdhtRelay, readRelays, iceServers, publicProfiles, online, shareProfile, sendTyping, nick"],
  ["engine <method> [json-params | -] [--confirm-real] [--show-secret]", "Any call of the app's engine, with its own parameters", { "confirm-real": o("boolean", "Confirm a Mainnet (real money) spend"), "show-secret": o("boolean", "Print a call's secrets") }],
  ["engine --list", "The engine's calls"],
  ["call pipe [<chat|call>]", "A call's audio on stdin/stdout: raw s16le mono PCM at the call's rate (e.g. with sox or ffmpeg)"],
  ["identity add <provider> [subject] [--signer id] [--field name=value]... [--days n]", "Make an identity proof (a tool's or a published one finishes with identity complete)", {
    signer: o("string", "Which signer makes the proof (identity providers lists them)"), field: o("list", "A field of the provider's form, name=value"),
    days: o("number", "How long the proof holds"), timeout: o("number", "Seconds to wait for an approval"),
  }],
];

function help(): string {
  const rows: [string, string][] = [
    ...SPECIAL.slice(0, 7).map(([usage, summary]) => [usage, summary] as [string, string]),
    ...Object.values(COMMANDS).filter((c) => c.method !== "events.replay").map((c) => [c.usage, c.summary] as [string, string]),
    ...Object.values(TEXT_COMMANDS).map((c) => [c.usage, c.summary] as [string, string]),
    ...SPECIAL.slice(7).map(([usage, summary]) => [usage, summary] as [string, string]),
    [COMMANDS.events.usage, COMMANDS.events.summary],
  ];
  const width = 58;
  return [
    `ghostly ${VERSION}: Ghostly for bots and terminals, the app's own engine without a screen.`,
    "",
    "Usage: ghostly <command> [options]   (JSON on stdout; errors as {\"error\":{code,message}} with an exit code)",
    "",
    ...rows.map(([usage, summary]) => `  ${usage.length > width ? usage + "\n  " + " ".repeat(width) : usage.padEnd(width)}  ${summary}`),
    "",
    "Options for every command:",
    ...Object.entries(GLOBAL_OPTIONS).map(([name, o]) => `  --${name}${o.short ? `, -${o.short}` : ""}`.padEnd(24) + o.description),
    "",
    "A <chat> is its id, a unique prefix of it, or its name; a <group> the same. Exit codes: 0 done, 1 failed,",
    "2 usage, 3 not found, 4 timed out, 5 needs --force/--yes/--confirm-real. See packages/cli/README.md.",
  ].join("\n");
}

/** Every command's help row: usage, summary and, for the table and text commands, their options. */
function helpRows(): { usage: string; summary: string; options?: Record<string, OptionSpec> }[] {
  return [
    ...SPECIAL.map(([usage, summary, options]) => ({ usage, summary, options })),
    ...Object.values(COMMANDS),
    ...Object.values(TEXT_COMMANDS),
  ];
}

/** The words that name a command in its usage line: up to the first argument or option. */
function commandWords(usage: string): string[] {
  const words: string[] = [];
  for (const word of usage.split(" ")) {
    if (!/^[a-z][a-z-]*$/.test(word)) break;
    words.push(word);
  }
  return words;
}

/**
 * Help for one command (`ghostly help file send`, `ghostly file send --help`): its usage, what it does and its
 * options; for a group (`ghostly help file`), the group's commands.
 */
export function commandHelp(words: readonly string[]): string {
  const named = (list: readonly string[]) => helpRows().filter((row) => { const own = commandWords(row.usage); return list.every((word, i) => own[i] === word); });
  // Arguments after the command's words (`ghostly send bob hi --help`) are not part of its name.
  let rows = named(words);
  while (!rows.length && words.length > 1) rows = named(words = words.slice(0, -1));
  const asked = words.join(" ");
  if (!rows.length) throw new CliError("usage", `Unknown command: ${asked} (ghostly help)`);
  const exact = rows.filter((row) => commandWords(row.usage).join(" ") === asked);
  const lines: string[] = [];
  if (exact.length && exact.length === rows.length) {
    for (const row of exact) {
      lines.push(`Usage: ghostly ${row.usage}`, "", `  ${row.summary}`);
      const options = Object.entries(row.options ?? {}).filter(([, o]) => o.description);
      if (options.length) {
        lines.push("", "Options:");
        for (const [name, o] of options) lines.push(`  --${name}${o.type === "boolean" ? "" : ` <${o.type === "number" ? "n" : "value"}>`}`.padEnd(26) + o.description);
      }
      // A text that starts with a dash goes after `--`, and so does everything else on the line.
      if (Object.values(TEXT_COMMANDS).includes(row as (typeof TEXT_COMMANDS)[string]))
        lines.push("", "  -- ends the options: everything after it is the text, options included (\"-- -1 --wait sent\" sends", "  all of it). Put options before --.");
      lines.push("");
    }
  } else {
    const width = Math.min(58, Math.max(...rows.map((row) => row.usage.length)));
    lines.push(`ghostly ${asked}: ${rows.length} commands (ghostly help ${asked} <command> for one)`, "");
    for (const row of rows) lines.push(`  ${row.usage.length > width ? row.usage + "\n  " + " ".repeat(width) : row.usage.padEnd(width)}  ${row.summary}`);
    lines.push("");
  }
  lines.push("Options for every command: --profile, -p <name>  --home <dir>  --pretty  --help, -h");
  return lines.join("\n");
}

// ---------- commands with their own flow ----------

async function profileCommand(sub: string | undefined, argv: string[]): Promise<void> {
  const specs: Record<string, Record<string, OptionSpec>> = {
    create: { use: { type: "boolean", description: "" }, name: { type: "string", description: "" } },
    backup: { out: { type: "string", description: "" }, "passphrase-file": { type: "string", description: "" }, passphrase: { type: "boolean", description: "" } },
    restore: { "passphrase-file": { type: "string", description: "" }, use: { type: "boolean", description: "" } },
    set: { name: { type: "string", description: "" }, "share-profile": { type: "boolean", description: "" } },
  };
  const parsed = parseArgs(argv, specs[sub ?? ""] ?? {});
  const g = globals(parsed);
  pretty = g.pretty;
  switch (sub) {
    case "create": {
      const [name] = parsed.positionals;
      if (!name || parsed.positionals.length > 1) throw new CliError("usage", "ghostly profile create <name>");
      const paths = createProfile(g.home, name);
      if (parsed.options.use) selectProfile(g.home, name);
      let shown: unknown = null;
      if (typeof parsed.options.name === "string") {
        shown = await withSession({ ...g, profile: name, paths }, (s) => s.call("profile.set", { name: parsed.options.name }));
      }
      print({ created: name, folder: paths.dir, current: currentProfile(g.home) === name, ...(shown ? { profile: shown } : {}) });
      return;
    }
    case "list": {
      const current = currentProfile(g.home);
      print({ profiles: listProfiles(g.home).map((name) => ({ name, current: name === current, running: lockOwner(profilePaths(g.home, name)) !== null })), home: g.home });
      return;
    }
    case "use": {
      const [name] = parsed.positionals;
      if (!name) throw new CliError("usage", "ghostly profile use <name>");
      selectProfile(g.home, name);
      print({ current: name });
      return;
    }
    case "show":
      print(await withSession(g, (s) => s.call("profile.get")));
      return;
    case "set": {
      const params: Record<string, unknown> = {};
      if (parsed.options.name !== undefined) params.name = parsed.options.name;
      if (parsed.options["share-profile"] !== undefined) params.shareProfile = parsed.options["share-profile"];
      if (!Object.keys(params).length) throw new CliError("usage", "ghostly profile set [--name <name>] [--share-profile | --no-share-profile]");
      print(await withSession(g, (s) => s.call("profile.set", params)));
      return;
    }
    case "backup": {
      const out = parsed.options.out;
      if (typeof out !== "string") throw new CliError("usage", "ghostly profile backup --out <file> [--passphrase-file f | --no-passphrase] (or GHOSTLY_BACKUP_PASSPHRASE)");
      // Encrypted unless --no-passphrase says otherwise, and never a guess: a passphrase and --no-passphrase together are refused.
      const unsealed = parsed.options.passphrase === false;
      if (parsed.options.passphrase === true) throw new CliError("usage", "The passphrase comes from --passphrase-file or GHOSTLY_BACKUP_PASSPHRASE, never the command line");
      if (unsealed && (parsed.options["passphrase-file"] !== undefined || process.env.GHOSTLY_BACKUP_PASSPHRASE)) throw new CliError("usage", "A passphrase is set (--passphrase-file or GHOSTLY_BACKUP_PASSPHRASE) and --no-passphrase was given: choose one");
      const made = await withSession(g, (s) => s.call("profile.backup", unsealed ? { path: resolve(out), noPassphrase: true } : { path: resolve(out), passphrase: backupPassphrase(parsed.options["passphrase-file"]) }));
      if (unsealed) process.stderr.write("Not encrypted: this file holds the profile's keys, chats and wallet secrets in the clear. Anyone who gets it gets everything in it, including any money in its wallets.\n");
      print(made);
      return;
    }
    case "restore": {
      const [file, name] = parsed.positionals;
      if (!file || !name) throw new CliError("usage", "ghostly profile restore <file> <new profile> [--passphrase-file f] [--use]");
      // A backup made without a passphrase says so in its header: none is asked for, and the answer says it was not protected.
      const protection = await backupFileProtection(file);
      const paths = await restoreProfile(g.home, checkProfileName(name), file, protection === "none" ? undefined : backupPassphrase(parsed.options["passphrase-file"]));
      if (parsed.options.use) selectProfile(g.home, name);
      print({ restored: name, folder: paths.dir, protection });
      return;
    }
    default:
      throw new CliError("usage", "ghostly profile create|list|use|show|set|picture|backup|restore");
  }
}

/**
 * A clean stop (peers told goodbye, the store folded), once; a second signal, or a stop that takes longer than
 * 20 s, leaves at once. The store's journal makes that safe.
 */
function stopper(work: () => Promise<void>): () => void {
  let started = false;
  return () => {
    if (started) process.exit(1);
    started = true;
    setTimeout(() => process.exit(1), 20_000).unref();
    void work().then(() => process.exit(0), () => process.exit(1));
  };
}

/**
 * Ctrl-C, a service manager's stop, and the terminal or SSH session it ran in closing (SIGHUP, which would otherwise
 * end it on the spot): each a clean stop.
 */
function onStopSignals(stop: () => void): void {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, stop);
}

/** The backup passphrase: from a file or the environment, never the command line (it would sit in shell history). */
function backupPassphrase(file: unknown): string {
  const value = typeof file === "string" ? readFileSync(file, "utf8").replace(/\r?\n$/, "") : process.env.GHOSTLY_BACKUP_PASSPHRASE;
  if (!value) throw new CliError("usage", "The backup passphrase comes from --passphrase-file or GHOSTLY_BACKUP_PASSPHRASE (at least 12 characters). For a backup that is not encrypted, say so with --no-passphrase");
  return value;
}

async function runDaemon(g: Globals): Promise<void> {
  requireProfile(g);
  if (await connectDaemon(g.paths.socket)) throw new CliError("busy", `A daemon already runs profile ${g.profile}`);
  const host = await openHost(g.paths, "daemon", VERSION);
  let served: Awaited<ReturnType<typeof serve>>;
  try { served = await serve(host); } catch (error) { await host.close(); throw error; }
  keepServing();
  const stop = stopper(async () => { await served.close(); await host.close(); });
  host.ctx.stop = stop;
  onStopSignals(stop);
  host.ctx.hub.emit("daemon.started", `daemon.started:${process.pid}:${Date.now()}`, { pid: process.pid, version: VERSION });
  print({ daemon: "ready", profile: g.profile, pid: process.pid, socket: g.paths.socket, lastSeq: host.ctx.hub.lastSeq });
}

async function daemonCommand(argv: string[]): Promise<void> {
  const sub = argv[0] && !argv[0].startsWith("-") ? argv[0] : undefined;
  const parsed = parseArgs(sub ? argv.slice(1) : argv, { detach: { type: "boolean", description: "" }, timeout: { type: "number", description: "" } });
  const g = globals(parsed);
  pretty = g.pretty;
  if (sub === "status") {
    const client = await connectDaemon(g.paths.socket);
    // The socket, running or not: a program on the socket API (examples/*.mjs) finds it here. It is in the profile's
    // folder, or in /tmp/ghostly-<hash>/ when that path is too long for a socket, so a program cannot guess it.
    if (!client) { print({ running: false, profile: g.profile, socket: g.paths.socket }); return; }
    try { print({ running: true, ...(await client.call("status") as object), socket: g.paths.socket }); } finally { client.close(); }
    return;
  }
  if (sub === "stop") {
    const client = await connectDaemon(g.paths.socket);
    if (!client) throw new CliError("not_found", `No daemon runs profile ${g.profile}`);
    print({ stopped: true, pid: await stopDaemon(g, client, Number(parsed.options.timeout) || 20) });
    return;
  }
  if (sub === "restart") {
    // The running one stops (if one runs), and this command's own code starts in the background.
    const client = await connectDaemon(g.paths.socket);
    const before = client ? (await client.call("status").catch(() => null) as { version?: string } | null)?.version ?? null : null;
    const stopped = client ? await stopDaemon(g, client, Number(parsed.options.timeout) || 20) : null;
    const started = await startDetached(g, Number(parsed.options.timeout) || 60);
    print({ restarted: true, stopped, before, version: VERSION, ...started });
    return;
  }
  if (sub) throw new CliError("usage", "ghostly daemon [--detach] | daemon status | daemon stop | daemon restart");
  if (!parsed.options.detach) { await runDaemon(g); return; }
  print(await startDetached(g, Number(parsed.options.timeout) || 60));
}

/**
 * Asks the daemon to stop and waits until its process is gone, not only until it let go of the profile (it releases
 * the lock a moment before it exits); its pid.
 */
async function stopDaemon(g: Globals, client: DaemonClient, seconds: number): Promise<number> {
  const { pid } = await client.call("daemon.stop") as { pid: number };
  client.close();
  const until = Date.now() + seconds * 1000;
  const running = () => lockOwner(g.paths) === pid || processAlive(pid);
  while (running() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
  if (running()) throw new CliError("timeout", `The daemon (process ${pid}) has not stopped yet`);
  return pid;
}

/** Throws busy, with its pid, when a process other than `except` holds the profile. */
function heldBy(g: Globals, except?: number): void {
  const owner = lockOwner(g.paths);
  if (owner !== null && owner !== except) throw new CliError("busy", `Profile ${g.profile} is in use by process ${owner}`, { pid: owner });
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** A daemon in the background, running this command's code, once its socket answers. */
async function startDetached(g: Globals, seconds: number) {
  requireProfile(g);
  if (await connectDaemon(g.paths.socket)) throw new CliError("busy", `A daemon already runs profile ${g.profile}`);
  // A one-shot command (or a listen) that opened the profile in process holds it: the child would only log that.
  heldBy(g);
  const log = openSync(g.paths.log, "a", 0o600);
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "daemon", "--home", g.home, "--profile", g.profile], { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  const until = Date.now() + seconds * 1000;
  let client: DaemonClient | null = null;
  while (!client && Date.now() < until) {
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
    client = await connectDaemon(g.paths.socket, 500);
  }
  if (!client) {
    heldBy(g, child.pid); // another process took the profile between the check and the child's start
    throw new CliError("engine", `The daemon did not start; see ${g.paths.log}`);
  }
  client.close();
  return { daemon: "started", profile: g.profile, pid: child.pid, socket: g.paths.socket, log: g.paths.log };
}

async function listenCommand(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, {
    since: { type: "number", description: "" }, cursor: { type: "string", description: "" }, type: { type: "list", description: "" },
    exec: { type: "string", description: "" }, webhook: { type: "string", description: "" }, print: { type: "boolean", description: "" },
    from: { type: "list", description: "" }, group: { type: "list", description: "" }, turns: { type: "boolean", description: "" },
  });
  const g = globals(parsed);
  pretty = false; // one event per line
  if (parsed.options.webhook) checkWebhook(String(parsed.options.webhook));
  const types = (parsed.options.type as string[] | undefined) ?? [];
  const turns = parsed.options.turns === true;
  if (turns && types.length) throw new CliError("usage", "--turns takes the place of --type: a turn is a message received, or a group message that mentions you");
  const from = (parsed.options.from as string[] | undefined) ?? [], groups = (parsed.options.group as string[] | undefined) ?? [];
  const cursor = parsed.options.cursor as string | undefined;
  let since = (parsed.options.since as number | undefined) ?? readCursor(cursor);
  let handle: ((event: GhostlyEvent) => void) | null = null;
  const start = async (call: (method: string, params: Record<string, unknown>) => Promise<unknown>, peerOf: (chat: string) => Promise<string | null>) => {
    handle = eventHandler({
      types, turns,
      exec: parsed.options.exec as string | undefined,
      webhook: parsed.options.webhook as string | undefined,
      cursor,
      // With a hook, events go to the hook; --print shows them too.
      print: parsed.options.print === true || (!parsed.options.exec && !parsed.options.webhook),
      write: (line) => process.stdout.write(line + "\n"),
      allow: from.length || groups.length ? await allowlist(from, groups, call, peerOf) : undefined,
    });
  };
  const onEvent = (event: GhostlyEvent) => { since = event.seq; handle?.(event); };
  requireProfile(g);
  const client = await connectDaemon(g.paths.socket);
  if (client) await warnVersion(client);
  if (client) {
    // The subscription takes the connection: a chat's contact key is asked on a connection of its own.
    await start((m, p) => client.call(m, p), async (chat) => {
      const c = await connectDaemon(g.paths.socket, 1000);
      if (!c) return null;
      try { return ((await c.call("chat.get", { chat })) as { peer?: string }).peer || null; } finally { c.close(); }
    }).catch((error) => { client.close(); throw error; });
    // Followed until stopped; a daemon that restarts is picked up again after the last event seen.
    let current: DaemonClient | null = client;
    const follow = async (c: DaemonClient) => {
      await c.subscribe(since, onEvent, () => {
        current = null;
        void (async () => {
          while (!current) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            const next = await connectDaemon(g.paths.socket, 1000);
            if (next) { current = next; await follow(next).catch(() => { current = null; }); }
          }
        })();
      });
    };
    await follow(client);
    process.on("SIGINT", () => { current?.close(); process.exit(0); });
    process.on("SIGTERM", () => { current?.close(); process.exit(0); });
    return;
  }
  // No daemon: this process becomes it (the socket too, so hooks can answer with `ghostly send`).
  const host: Host = await openHost(g.paths, "daemon", VERSION);
  const call = (m: string, p: Record<string, unknown>) => callApi(host.ctx, m, p);
  await start(call, async (chat) => ((await call("chat.get", { chat })) as { peer?: string }).peer || null).catch(async (error) => { await host.close(); throw error; });
  const served = await serve(host).catch(async (error) => { await host.close(); throw error; });
  keepServing();
  const stop = stopper(async () => { await served.close(); await host.close(); });
  host.ctx.stop = stop;
  onStopSignals(stop);
  for (const event of host.ctx.hub.replay(since ?? host.ctx.hub.lastSeq)) onEvent(event);
  host.ctx.hub.onEvent(onEvent);
  host.ctx.hub.emit("daemon.started", `daemon.started:${process.pid}:${Date.now()}`, { pid: process.pid, version: VERSION, listen: true });
}

async function engineCommand(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, { "confirm-real": { type: "boolean", description: "" }, "show-secret": { type: "boolean", description: "" }, list: { type: "boolean", description: "" } });
  const g = globals(parsed);
  pretty = g.pretty;
  if (parsed.options.list) { print({ methods: [...ENGINE_METHODS, ...ENGINE_READS].sort() }); return; }
  const [method, raw] = parsed.positionals;
  if (!method || parsed.positionals.length > 2) throw new CliError("usage", "ghostly engine <method> [json-params | -]");
  if (!ENGINE_METHODS.includes(method) && !ENGINE_READS.includes(method)) throw new CliError("not_found", `The engine has no call ${method} (ghostly engine --list)`);
  const showSecret = parsed.options["show-secret"] === true;
  if (SECRET_RESULTS.has(method) && !showSecret) throw new CliError("confirm", `${method} answers with secrets: add --show-secret to print them`);
  let params: unknown;
  const text = raw === "-" ? await readStdin() : raw;
  if (text !== undefined && text.trim()) {
    try { params = JSON.parse(text); } catch { throw new CliError("usage", "The parameters must be JSON (an object)"); }
  }
  const confirmReal = parsed.options["confirm-real"] === true;
  if (confirmReal && params && typeof params === "object") (params as Record<string, unknown>).confirmedReal = true;
  let result = await withSession(g, (s) => s.call("engine.call", { method, params, confirmReal }));
  if (method === "getState" && !showSecret && result && typeof result === "object") {
    const state = result as { settings: Parameters<typeof redactSettings>[0]; groups?: { entryLink?: string }[] };
    // A group's entry link lets anyone join: hidden like the settings' secrets.
    result = { ...state, settings: redactSettings(state.settings), ...(state.groups ? { groups: state.groups.map((g) => (g.entryLink ? { ...g, entryLink: "<hidden>" } : g)) } : {}) };
  }
  print(result);
}

async function settingsCommand(sub: string | undefined, argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, { "show-secret": { type: "boolean", description: "" } });
  const g = globals(parsed);
  pretty = g.pretty;
  if (sub === "get") { print(await withSession(g, (s) => s.call("settings.get", { showSecret: parsed.options["show-secret"] === true }))); return; }
  if (sub === "set") {
    const [key, value] = parsed.positionals;
    if (!key || value === undefined || parsed.positionals.length > 2) throw new CliError("usage", "ghostly settings set <key> <json-value>");
    let parsedValue: unknown;
    try { parsedValue = JSON.parse(value); } catch { parsedValue = value; }
    print(await withSession(g, (s) => s.call("settings.set", { [key]: parsedValue })));
    return;
  }
  throw new CliError("usage", "ghostly settings get | settings set <key> <json-value>");
}

async function textCommand(name: string, argv: string[]): Promise<void> {
  const spec = TEXT_COMMANDS[name];
  const parsed = parseArgs(argv, spec.options, idSlot(spec));
  const g = globals(parsed);
  pretty = g.pretty;
  const [target, ...rest] = parsed.positionals;
  // `edit` names the message before the text.
  const [message, ...words] = spec.message ? rest : [undefined, ...rest];
  if (!target || (spec.message && !message)) throw new CliError("usage", `ghostly ${spec.usage}`);
  let text = words.join(" ");
  if (parsed.options.text !== undefined) {
    if (text || parsed.options.stdin) throw new CliError("usage", "Give the text once: as arguments, --text or stdin");
    text = String(parsed.options.text);
  } else if (parsed.options.stdin || (!text && !process.stdin.isTTY)) {
    if (text) throw new CliError("usage", "Give the text as arguments or on stdin, not both");
    text = (await readStdin()).replace(/\n$/, "");
  }
  if (!text.trim()) throw new CliError("usage", `No text: ghostly ${spec.usage}`);
  const params: Record<string, unknown> = { [spec.target]: target, text, force: parsed.options.force === true, ...(message !== undefined && { message }) };
  if (spec.target === "group") params.mentions = parsed.options.mention ?? [];
  if (parsed.options.reply !== undefined) params.reply = parsed.options.reply;
  if (!spec.message) Object.assign(params, buttonsOf(parsed.options));
  print(await withSession(g, (s) => {
    if (spec.target === "chat") {
      // A one-shot leaves once its command is done: by default it stays until the message went out.
      params.wait = parsed.options.wait ?? (s.mode === "one-shot" ? (spec.message ? "confirmed" : "sent") : "none");
      if (parsed.options.timeout !== undefined) params.timeout = parsed.options.timeout;
    } else {
      // A group has no receipts: `--wait sent` waits until an edge took it. None by default.
      if (parsed.options.wait !== undefined) params.wait = parsed.options.wait;
      if (parsed.options.timeout !== undefined) params.timeout = parsed.options.timeout;
    }
    return s.call(spec.method, params);
  }, spec.target === "chat"));
}

/**
 * `identity add`: a proof. An in-app signer finishes in this one command (what it waits on is printed to stderr as it
 * comes); a tool or a published record answers with the statement, and `identity complete` finishes it later, in the
 * same daemon.
 */
async function identityAddCommand(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, {
    signer: { type: "string", description: "" }, field: { type: "list", description: "" }, days: { type: "number", description: "" }, timeout: { type: "number", description: "" },
  });
  const g = globals(parsed);
  pretty = g.pretty;
  const [provider, ...subject] = parsed.positionals;
  if (!provider) throw new CliError("usage", "ghostly identity add <provider> [subject] [--signer id] [--field name=value]... [--days n]");
  const fields: Record<string, string> = {};
  for (const item of (parsed.options.field as string[] | undefined) ?? []) {
    const eq = item.indexOf("=");
    if (eq < 1) throw new CliError("usage", `--field takes name=value, not ${JSON.stringify(item)}`);
    fields[item.slice(0, eq)] = item.slice(eq + 1);
  }
  const params = { provider, subject: subject.join(" ") || undefined, signer: parsed.options.signer, fields, days: parsed.options.days, timeout: parsed.options.timeout };
  const tell = (event: GhostlyEvent) => {
    if (event.type === "identity.approval" || event.type === "identity.progress") process.stderr.write(JSON.stringify(event) + "\n");
  };
  requireProfile(g);
  const client = await connectDaemon(g.paths.socket);
  if (client) {
    await warnVersion(client);
    const watcher = await connectDaemon(g.paths.socket);
    await watcher?.subscribe(undefined, tell);
    try { print(await client.call("identity.add", params)); } finally { client.close(); watcher?.close(); }
    return;
  }
  const host = await openHost(g.paths, "one-shot", VERSION);
  const off = host.ctx.hub.onEvent(tell);
  try {
    const result = await callApi(host.ctx, "identity.add", params) as { done: boolean; draft?: string };
    if (!result.done) {
      await callApi(host.ctx, "identity.cancel", { draft: result.draft }).catch(() => {});
      throw new CliError("unavailable", "A proof made in two steps waits in the daemon between them: start `ghostly daemon --detach`, then run this again");
    }
    print(result);
  } finally { off(); await host.close(); }
}

async function tableCommand(name: string, argv: string[]): Promise<void> {
  const command = COMMANDS[name];
  const parsed = parseArgs(argv, command.options ?? {}, idSlot(command));
  const g = globals(parsed);
  pretty = g.pretty;
  const args = positionals(command, parsed.positionals);
  const params = command.params?.(parsed, args) ?? {};
  for (const key of Object.keys(params)) if (params[key] === undefined) delete params[key];
  // Evidence is read here, where the file is: the daemon runs elsewhere.
  if (command.method === "identity.complete") {
    if (params.evidenceFile) params.evidence = readFileSync(params.evidenceFile as string, "utf8");
    else if (params.stdin) params.evidence = await readStdin();
    delete params.evidenceFile; delete params.stdin;
  }
  const secretWarning = await secretsFromStdin(command.method, params, readStdin);
  if (secretWarning) process.stderr.write(`ghostly: ${secretWarning}\n`);
  const result = await withSession(g, async (s) => {
    const result = await s.call(command.method, params) as Record<string, unknown>;
    // A one-shot join leaves once the contact can be reached: its answer has to be out first.
    if (command.method === "invite.join" && s.mode === "one-shot") {
      await s.call("chat.wait", { chat: result.chat, until: "paired", timeout: 60 }).catch(() => {});
    }
    return result;
  }, chatOnly(command.method, params));
  // Done, with something to know (a voice note sent without its waveform): said on stderr, the JSON stays the answer.
  if (typeof result?.warning === "string") {
    process.stderr.write(`ghostly: ${result.warning}\n`);
    delete result.warning;
  }
  print(result);
}

/**
 * `call pipe`: a call's audio socket bridged to stdin and stdout, for shell pipelines. stdout carries audio only (the
 * contact's, raw PCM); what the command says goes to stderr. It ends when the call does.
 */
async function callPipeCommand(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, {}, idSlot({ args: ["call..."] }));
  const g = globals(parsed);
  const ref = parsed.positionals.join(" ") || undefined;
  const client = await connectDaemon(g.paths.socket);
  if (!client) throw new CliError("unavailable", `No daemon runs profile ${g.profile}: calls need one (ghostly daemon --detach)`);
  let call: { call: string; audio: { socket: string; rate: number } | null };
  try { call = await client.call("call.get", ref ? { call: ref } : {}) as typeof call; } finally { client.close(); }
  const audio = call.audio;
  if (!audio) throw new CliError("unavailable", "That call has no audio yet: answer it first");
  const socket = connect(audio.socket);
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  process.stderr.write(`ghostly: call ${call.call}: s16le mono ${audio.rate} Hz on stdin/stdout\n`);
  // A clip that ends (`ffmpeg -t 3 … | ghostly call pipe`) is queued and played, and the contact's audio goes on
  // coming: the end of stdin never closes the socket, whose daemon side would close the call's audio with it.
  process.stdin.pipe(socket, { end: false });
  socket.pipe(process.stdout);
  socket.on("close", () => exit(0));
  socket.on("error", () => exit(1));
}

// ---------- entry ----------

/** The command's words when the line asks for help (`help <words>`, or `--help`/`-h` before any `--`), else null. */
function helpAsked(argv: readonly string[]): string[] | null {
  const end = argv.indexOf("--");
  const head = end === -1 ? argv : argv.slice(0, end);
  const words = (list: readonly string[]) => { const out: string[] = []; for (const word of list) { if (word.startsWith("-")) break; out.push(word); } return out; };
  if (head[0] === "help") return words(head.slice(1));
  if (head.includes("--help") || head.includes("-h")) return words(head);
  return null;
}

export async function main(input: string[]): Promise<number> {
  const argv = liftGlobals(input);
  const helpFor = argv.length === 0 ? [] : helpAsked(argv);
  if (helpFor) { process.stdout.write((helpFor.length ? commandHelp(helpFor) : help()) + "\n"); return 0; }
  if (argv[0] === "--version" || argv[0] === "version") { print({ version: VERSION }); return 0; }
  const [first, second] = argv;
  const two = second && !second.startsWith("-") ? `${first} ${second}` : "";
  if (first === "profile" && !COMMANDS[two]) { await profileCommand(second, argv.slice(2)); return 0; }
  if (first === "daemon") { await daemonCommand(argv.slice(1)); return -1; }
  if (first === "listen") { await listenCommand(argv.slice(1)); return -1; }
  if (first === "engine") { await engineCommand(argv.slice(1)); return 0; }
  if (first === "settings") { await settingsCommand(second, argv.slice(2)); return 0; }
  if (two === "identity add") { await identityAddCommand(argv.slice(2)); return 0; }
  if (two === "call pipe") { await callPipeCommand(argv.slice(2)); return -1; }
  if (two && TEXT_COMMANDS[two]) { await textCommand(two, argv.slice(2)); return 0; }
  if (two && COMMANDS[two]) { await tableCommand(two, argv.slice(2)); return 0; }
  if (TEXT_COMMANDS[first]) { await textCommand(first, argv.slice(1)); return 0; }
  if (COMMANDS[first]) { await tableCommand(first, argv.slice(1)); return 0; }
  throw unknownCommand(first, two ? second : undefined);
}

/**
 * A command line that names no command. The first word of a group (`ghostly chat`, `ghostly wallet frob`) is answered
 * with the group's commands, as `ghostly help chat` lists them; before, it was only "Unknown command: chat".
 */
export function unknownCommand(first: string | undefined, second?: string): CliError {
  const asked = [first, second].filter(Boolean).join(" ");
  const subs = [...new Set(helpRows().map((row) => commandWords(row.usage)).filter((words) => words[0] === first && words.length > 1).map((words) => words[1]))];
  if (!subs.length) return new CliError("usage", `Unknown command: ${asked} (ghostly help)`);
  const list = `${subs.slice(0, -1).join(", ")}${subs.length > 1 ? " or " : ""}${subs.at(-1)}`;
  return new CliError("usage", second ? `Unknown command: ${asked}: ghostly ${first} takes ${list} (ghostly help ${first})` : `ghostly ${first} takes a command: ${list} (ghostly help ${first})`);
}

/** Leaves once what was printed reached stdout (a pipe drains asynchronously). */
function exit(code: number): void {
  process.stdout.write("", () => process.exit(code));
}

/**
 * Stdout is the command's answer and nothing else: one JSON object, or a stream of JSON lines. What the engine notes
 * as it works (a relay left alone for a minute, a wallet moved to its network's key) is written with `console.info`
 * and the like, which Node sends to stdout: a script reading the answer (`ghostly wallet list | jq`) then failed on a
 * line that is not JSON. Those notes go to stderr, where a daemon's log and a terminal still show them.
 */
export function notesToStderr(): void {
  for (const level of ["log", "info", "debug"] as const) console[level] = (...args: unknown[]) => { process.stderr.write(`${format(...args)}\n`); };
}

/** Runs the command line; `-1` from `main` means the process stays (a daemon, a listener). */
export async function run(argv: string[]): Promise<void> {
  notesToStderr();
  try {
    const code = await main(argv);
    if (code >= 0) exit(code);
  } catch (error) {
    const failure = asCliError(error);
    print({ error: failure.toJSON() });
    exit(EXIT[failure.code]);
  }
}
