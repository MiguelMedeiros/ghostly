import { spawn } from "node:child_process";
import { connect } from "node:net";
import { openSync, readFileSync, rmSync } from "node:fs";
import packageJson from "../package.json" with { type: "json" };
import { GLOBAL_OPTIONS, globalOption, liftGlobals, parseArgs, type OptionSpec, type Parsed } from "./args";
import { connectDaemon, isNotTheDaemon, type DaemonClient } from "./client";
import { COMMANDS, idSlot, noMoreThan, positionals, TEXT_COMMANDS } from "./commands";
import { here } from "./commands/shared";
import { ENGINE_METHODS, ENGINE_PARAMS, ENGINE_READS, READ_PARAMS, SECRET_RESULTS } from "./engineMethods";
import { asCliError, CliError, EXIT, localFileError } from "./errors";
import type { GhostlyEvent } from "./events";
import type { Host } from "./host";
import type { RuntimeOptions } from "./runtime/engine";
import { allowlist, checkCursor, checkTypes, checkWebhook, eventHandler, Feed, followDaemon, readCursor } from "./listen";
import { format } from "node:util";
import { secretsFromStdin, secretValuesWarning } from "./secretInput";
import {
  checkProfileName, checkShownName, createProfile, currentProfile, DEFAULT_PROFILE, ghostlyHome, listProfiles, lockOwner, profileExists, profilePaths, selectProfile,
  type ProfilePaths,
} from "./profiles";

const VERSION = packageJson.version;

/**
 * The engine's modules (the API, the host, the backup, the buttons) are loaded only where a command needs them here: a
 * command a running daemon answers loads none of them, and starts about as fast as Node does. Statically imported, they
 * cost every command ~100 ms before its socket was opened.
 */
const engineApi = () => import("./api");
const engineHost = () => import("./host");

interface Globals { home: string; profile: string; paths: ProfilePaths; pretty: boolean }

let pretty = false;
function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, pretty ? 2 : undefined) + "\n");
}

/** Done, with something to know (a voice note sent without its waveform): said on stderr, the JSON stays the answer. */
function printAnswer(result: Record<string, unknown>): void {
  if (typeof result?.warning === "string") {
    process.stderr.write(`ghostly: ${result.warning}\n`);
    delete result.warning;
  }
  print(result);
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
  throw noProfile(g);
}

function noProfile(g: Globals): CliError {
  return new CliError("not_found", `No profile ${g.profile}: make it with \`ghostly profile create ${g.profile}\``);
}

/** For a command that only reads: a mistyped profile is named as one, and `default` is not made by asking about it. */
function knownProfile(g: Globals): void {
  if (g.profile !== DEFAULT_PROFILE && !profileExists(g.home, g.profile)) throw noProfile(g);
}

/** A way to call the API: the daemon's socket when one runs the profile, else the profile in this process. */
interface Session { mode: "daemon" | "one-shot"; call(method: string, params?: unknown): Promise<unknown>; close(): Promise<void> }

/** Said on stderr when the daemon runs another release than this command (it started before an upgrade). */
export function versionWarning(daemon: unknown, cli: string): string | null {
  if (typeof daemon !== "string" || daemon === cli) return null;
  return `ghostly: the daemon runs ${daemon} and this command is ${cli}: \`ghostly daemon restart\` runs the new code`;
}

/**
 * Never fails, and has no deadline of its own: a daemon that does not answer is the command's own call to find out,
 * at the command's deadline, which closes the connection and ends this check with it. A deadline here ended every
 * command on a wedged daemon at 15 s with `unavailable` ("The daemon went away"), whatever its own `--timeout` said.
 */
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
  // A status card's `chat` may name a group as well (WISP 405 · Status Cards): its sessions must start.
  if (method.startsWith("task.") || method.startsWith("routine.") || method.startsWith("button.")) return false;
  // A usage report to every 1:1 chat (`--all`) needs no group; one to a named chat may name a group.
  if (method === "usage.send") return params.all === true;
  return method.startsWith("chat.") || (params.chat !== undefined && params.group === undefined && !method.startsWith("group."));
}

/**
 * Calls that only read what the profile stores: a one-shot for one opens it offline (`RuntimeOptions.offline`).
 * Opened online, `status` or `chat list` started every chat, put the profile's records on the relays again and waited
 * for its leave packet to be taken: 0.25 s became 3.3 s with a relay that takes 1.5 s, and 10 s with one that does not
 * answer, and each read spent ~5 relay requests per chat of the relays' per-address budget.
 */
const READS: ReadonlySet<string> = new Set([
  "status", "profile.get", "settings.get", "events.replay", "chat.list", "chat.get", "chat.history", "chat.details",
  "group.list", "group.get", "group.history", "file.list", "wallet.list", "wallet.history", "payment.list", "identity.list", "identity.providers",
  "identity.contact", "service.list", "service.peer", "call.list", "app.served", "x401.credential.list",
]);

/** Whether a one-shot for this call opens the profile offline; test/readOnlyCommands.test.ts names every table command. */
export function readOnly(method: string, params: Record<string, unknown>): boolean {
  if (method === "engine.call") return typeof params.method === "string" && ENGINE_READS.includes(params.method);
  // `call auto` with no on|off says what auto-answer is.
  if (method === "call.auto") return params.on === undefined;
  return READS.has(method);
}

/**
 * Calls whose change stays on this device: a chat's name here, a chat removed (nothing goes to the contact), auto-answer
 * (calls.json), a proof dropped, a web app added (shared with no one yet), an x401 key or credential (WISP 3xx: never
 * shared with a contact). Opened online, each put the profile's records on the relays and waited for them (6 PUT + 4
 * GET, 3.3 s with a relay that takes 1.5 s), and the contacts' apps saw this device come online. `message delete` stays
 * online: it settles a file offer already on the DHT.
 */
const LOCAL_WRITES: ReadonlySet<string> = new Set([
  "chat.rename", "chat.remove", "call.auto", "identity.cancel", "service.add", "x401.key.new", "x401.credential.add", "x401.credential.remove",
]);

/** Settings of this device only: no contact and no relay hears of them (nick, avatar and the relays' do). */
export const LOCAL_SETTINGS: ReadonlySet<string> = new Set(["sendTyping", "autoDownloads", "serveFiles"]);

/** Whether a one-shot for this call opens the profile offline: a read, or a change that stays on this device. */
export function offlineCall(method: string, params: Record<string, unknown>): boolean {
  return readOnly(method, params) || LOCAL_WRITES.has(method);
}

/** How long a daemon gets to answer before a command gives up: a read is in memory (15 s); a call that waits for the
 *  contact carries its own `--timeout` (or the daemon's default for it), plus a margin; anything else may take as long
 *  as it takes. */
const ANSWER_MS = 15_000;
export function answerWithin(method: string, params: Record<string, unknown>): number | undefined {
  // A `--timeout` outside the daemon's range (1 to 3600 s, 86 400 for `chat wait` and `file wait`) is refused by the
  // daemon at once (bad_request); the deadline only has to be a timer Node takes (-10 s fired at once, 1e12 after 1 ms).
  const waits = typeof params.timeout === "number" ? Math.min(Math.max(params.timeout, 1), 86_400) : waitsFor(method, params);
  if (waits !== undefined) return (waits + 10) * 1000;
  if (readOnly(method, params)) return ANSWER_MS;
  return undefined;
}

/**
 * The seconds a call without `--timeout` waits for the contact: the daemon's defaults (`num(params, "timeout", …)` in
 * api.ts, files.ts, buttons.ts and statusCards.ts), so that a bot's `chat wait` or `send --wait sent` on a daemon that
 * stopped answering ends when the wait would have. A call that does not wait is none.
 */
function waitsFor(method: string, params: Record<string, unknown>): number | undefined {
  if (method === "chat.wait") return 60;
  if (method === "file.wait" || (method === "file.save" && params.wait === true)) return 300;
  // send, edit, forward, a button, a task or routine card: `--wait sent|confirmed|delivered`, 30 s each.
  if (typeof params.wait === "string" && params.wait !== "none") return 30;
  return undefined;
}

async function session(g: Globals, options: RuntimeOptions): Promise<Session> {
  requireProfile(g);
  const client = await connectDaemon(g.paths);
  if (client) {
    // The version check goes on the same connection as the command, ahead of it, not before it, and with no deadline
    // of its own: a daemon that does not answer costs the command its own deadline and nothing else (a read gave up
    // after 30 s, not 15; then every command gave up at the check's 15 s, whatever its own). `close` waits for the
    // check's answer: a daemon that answered the command answered the check sent before it.
    const warned = warnVersion(client);
    return { mode: "daemon", call: (m, p) => client.call(m, p, { timeoutMs: answerWithin(m, (p ?? {}) as Record<string, unknown>) }), close: async () => { await warned; client.close(); } };
  }
  const [{ openHost }, { callApi }] = await Promise.all([engineHost(), engineApi()]);
  const host = await openHost(g.paths, "one-shot", VERSION, options);
  return { mode: "one-shot", call: (m, p) => callApi(host.ctx, m, p ?? {}), close: () => host.close() };
}

/**
 * How a one-shot opens the profile: `deferGroups` when the command is about one 1:1 chat (`chatOnly`) and needs
 * nothing of the groups, `offline` when it only reads or changes only this device (`offlineCall`).
 */
async function withSession<T>(g: Globals, work: (s: Session) => Promise<T>, options: RuntimeOptions = {}): Promise<T> {
  const s = await session(g, options);
  try { return await work(s); } finally { await s.close(); }
}

/**
 * A one-shot join waits up to 60 s for the inviter. Its answer says whether the chat paired and at what stage it is; one
 * not paired yet comes with the next step, since nothing pairs once the command has left.
 */
export async function oneShotJoinWait(s: Pick<Session, "call">, result: Record<string, unknown>, label?: string): Promise<{ answer: Record<string, unknown>; note?: string }> {
  const view = await s.call("chat.wait", { chat: result.chat, until: "paired", timeout: 60 }).then((v) => ({ paired: true, chat: v }), () => null)
    ?? await s.call("chat.get", { chat: result.chat }).then((v) => ({ paired: false, chat: v }), () => ({ paired: false, chat: null }));
  const stage = (view.chat as { stage?: unknown } | null)?.stage ?? null;
  const answer = { ...result, paired: view.paired, stage };
  if (view.paired) return { answer };
  const ref = label?.trim() && !/\s/.test(label.trim()) ? label.trim() : String(result.chat);
  return { answer, note: `Not paired yet: the inviter's app is offline. It pairs when both are online: keep this profile running (ghostly daemon --detach), then ghostly chat wait ${ref} --until paired` };
}

async function readStdin(onData?: () => void): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) { onData?.(); chunks.push(chunk as Buffer); }
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
  ["profile backup --out <file> [--passphrase-file f | --no-passphrase] [--light]", "A backup of the profile, encrypted with a passphrase (from a file or GHOSTLY_BACKUP_PASSPHRASE); --no-passphrase makes one anyone can read", { out: o("string", "The backup file to write"), "passphrase-file": o("string", "The passphrase, from this file (else GHOSTLY_BACKUP_PASSPHRASE)"), passphrase: { ...o("boolean", "Do not encrypt. The file then holds the profile's keys and wallet secrets in the clear"), negatedOnly: true }, light: o("boolean", "Leave out files over 1 MB (voice messages over 4 MB); their messages stay") }],
  ["profile restore <file> <new profile> [--passphrase-file f] [--use]", "A backup into a new profile (a backup made with --no-passphrase needs none)", { "passphrase-file": o("string", "The passphrase, from this file (else GHOSTLY_BACKUP_PASSPHRASE)"), use: o("boolean", "Make it the current profile") }],
  ["daemon [--detach] [--timeout s]", "Keep the profile online (foreground; --detach runs it in the background)", { detach: o("boolean", "Run in the background (log in the profile folder)"), timeout: o("number", "Seconds --detach waits for it to start (default 60)") }],
  ["daemon status [--timeout s]", "Whether a daemon runs the profile, its version, and its socket (for the socket API)", { timeout: o("number", "Seconds to wait for its answer (default 15)") }],
  ["daemon stop [--timeout s]", "Stop the profile's daemon", { timeout: o("number", "Seconds to wait for it to stop (default 20)") }],
  ["daemon restart [--timeout s]", "Stop the profile's daemon and start it again in the background (after an upgrade: the new code)", { timeout: o("number", "Seconds to wait for each step") }],
  ["listen [--since seq] [--cursor file] [--type t]... [--turns] [--from <chat|key>]... [--group <group>]... [--exec cmd] [--webhook url] [--print]", "Stream events as JSON lines (starts the profile here if no daemon runs it)", {
    since: o("number", "Replay events after this seq first"), cursor: o("string", "A file that keeps the last seq handled (read at start, written after each event)"),
    type: o("list", "Only events of this type (message.received) or family (message, or group.typing.); repeat for more"),
    turns: o("boolean", "Only agent turns: each message received, and each group message that mentions you, as one agent.turn event"),
    from: o("list", "Only this chat's events (id, prefix, name or the contact's key; again for more)"),
    group: o("list", "Only this group's events (again for more); with --from or --group, nobody else's event gets through"),
    exec: o("string", "Run this command per event, the event as JSON on stdin"),
    webhook: o("string", "POST each event to this URL"), print: o("boolean", "Print events too when --exec or --webhook handles them"),
  }],
  ["settings get [--show-secret]", "The profile's settings", { "show-secret": o("boolean", "Show credentials too") }],
  ["settings set <key> <json-value>", "Change one: relays, irohRelays, hyperdhtRelay, readRelays, iceServers, publicProfiles, online, shareProfile, sendTyping, autoDownloads, serveFiles, nick"],
  ["engine <method> [json-params | -] [--confirm-real] [--show-secret] [--yes] [--force]", "Any call of the app's engine, with its own parameters (engine --list --verbose names them)", { "confirm-real": o("boolean", "Confirm a Mainnet (real money) spend"), "show-secret": o("boolean", "Print a call's secrets"), yes: o("boolean", "Confirm a call that deletes chats or groups"), force: o("boolean", "Send a text that looks like a secret") }],
  ["engine --list [--verbose]", "The engine's calls", { verbose: o("boolean", "With what each call takes: { linkId, label }, ? for an optional one") }],
  ["call pipe [<chat|call>]", "A call's audio on stdin/stdout: raw s16le mono PCM at the call's rate (e.g. with sox or ffmpeg)"],
  ["identity add <provider> [subject] [--signer id] [--field name=value]... [--days n]", "Make an identity proof (a tool's or a published one finishes with identity complete)", {
    signer: o("string", "Which signer makes the proof (identity providers lists them)"), field: o("list", "A field of the provider's form, name=value"),
    days: o("number", "How long the proof holds"), timeout: o("number", "Seconds to wait for an approval"),
  }],
  ["version", "This CLI's version (also ghostly --version)"],
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
    "2 usage, 3 not found, 4 timed out, 5 needs --force/--yes/--confirm-real.",
    "More: https://ghostly.tools/cli, or the README.md beside this CLI.",
  ].join("\n");
}

/** What `ghostly help help` answers. */
const HELP_USAGE = [
  "Usage: ghostly help [<command>...]", "",
  "  Help for every command, or for one command or a group of them (also ghostly <command> --help)", "",
  "Options for every command: --profile, -p <name>  --home <dir>  --pretty  --help, -h",
].join("\n");

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
    if (!/^[a-z][a-z0-9-]*$/.test(word)) break;
    words.push(word);
  }
  return words;
}

/**
 * Help for one command (`ghostly help file send`, `ghostly file send --help`): its usage, what it does and its
 * options; for a group (`ghostly help file`), the group's commands.
 */
export function commandHelp(words: readonly string[]): string {
  // `help` is no command of the tables: its own usage, rather than "Unknown command: help".
  if (words[0] === "help") return HELP_USAGE;
  const named = (list: readonly string[]) => helpRows().filter((row) => { const own = commandWords(row.usage); return list.every((word, i) => own[i] === word); });
  // Arguments after the command's words (`ghostly send bob hi --help`) are not part of its name.
  const given = words;
  let rows = named(words);
  while (!rows.length && words.length > 1) rows = named(words = words.slice(0, -1));
  const asked = words.join(" ");
  if (!rows.length) throw new CliError("usage", `Unknown command: ${asked} (ghostly help)`);
  const exact = rows.filter((row) => commandWords(row.usage).join(" ") === asked);
  // Words dropped down to a group, not a command (`help chat histroy`): a word the group does not take, as `chat histroy`
  // says, not the group's list with exit 0.
  if (!exact.length && words.length < given.length) throw unknownCommand(given[0], given[1], given[2]);
  const lines: string[] = [];
  // The command asked for first, also when others extend its words (`daemon`, then `daemon stop`…): before, `daemon`'s
  // own options were shown nowhere.
  for (const row of exact) {
    lines.push(`Usage: ghostly ${row.usage}`, "", `  ${row.summary}`);
    const options = Object.entries(row.options ?? {}).filter(([, o]) => o.description);
    if (options.length) {
      lines.push("", "Options:");
      const labels = options.map(([name, o]) => `  --${o.negatedOnly ? "no-" : ""}${name}${o.type === "boolean" ? "" : ` <${o.type === "number" ? "n" : "value"}>`}`);
      // At least two spaces between an option and its text, however long the option.
      const width = Math.max(26, ...labels.map((label) => label.length + 2));
      options.forEach(([, o], i) => lines.push(labels[i].padEnd(width) + o.description));
    }
    // A text that starts with a dash goes after `--`, and so does everything else on the line.
    if (Object.values(TEXT_COMMANDS).includes(row as (typeof TEXT_COMMANDS)[string]))
      lines.push("", "  -- ends the options: everything after it is the text, options included (\"-- -1 --wait sent\" sends", "  all of it). Put options before --.");
    lines.push("");
  }
  const rest = rows.filter((row) => !exact.includes(row));
  if (rest.length) {
    const width = Math.min(58, Math.max(...rest.map((row) => row.usage.length)));
    const count = `${rest.length}${exact.length ? " more" : ""} command${rest.length === 1 ? "" : "s"}`;
    lines.push(`ghostly ${asked}: ${count} (ghostly help ${asked} <command> for one)`, "");
    for (const row of rest) lines.push(`  ${row.usage.length > width ? row.usage + "\n  " + " ".repeat(width) : row.usage.padEnd(width)}  ${row.summary}`);
    lines.push("");
  }
  lines.push("Options for every command: --profile, -p <name>  --home <dir>  --pretty  --help, -h");
  return lines.join("\n");
}

// ---------- commands with their own flow ----------

async function profileCommand(sub: string | undefined, argv: string[]): Promise<void> {
  const specs: Record<string, Record<string, OptionSpec>> = {
    create: { use: { type: "boolean", description: "" }, name: { type: "string", description: "" } },
    backup: { out: { type: "string", description: "" }, "passphrase-file": { type: "string", description: "" }, passphrase: { type: "boolean", description: "" }, light: { type: "boolean", description: "" } },
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
      // A command that fails changes nothing: the name is checked before the folder is made, and the profile is made
      // current only once it holds it. Before, the retry with a good name was refused "Profile <name> exists".
      const shownName = parsed.options.name === undefined ? undefined : checkShownName(parsed.options.name);
      const paths = createProfile(g.home, name);
      let shown: unknown = null;
      if (shownName !== undefined) {
        try {
          shown = await withSession({ ...g, profile: name, paths }, (s) => s.call("profile.set", { name: shownName }));
        } catch (e) {
          rmSync(paths.dir, { recursive: true, force: true });
          throw e;
        }
      }
      if (parsed.options.use) selectProfile(g.home, name);
      print({ created: name, folder: paths.dir, current: currentProfile(g.home) === name, ...(shown ? { profile: shown } : {}) });
      return;
    }
    case "list": {
      noMoreThan(0, parsed.positionals, "profile list");
      const current = currentProfile(g.home);
      print({ profiles: listProfiles(g.home).map((name) => ({ name, current: name === current, running: lockOwner(profilePaths(g.home, name)) !== null })), home: g.home });
      return;
    }
    case "use": {
      const [name] = parsed.positionals;
      if (!name) throw new CliError("usage", "ghostly profile use <name>");
      noMoreThan(1, parsed.positionals, "profile use <name>");
      selectProfile(g.home, name);
      print({ current: name });
      return;
    }
    case "show":
      noMoreThan(0, parsed.positionals, "profile show");
      print(await withSession(g, (s) => s.call("profile.get"), { offline: true }));
      return;
    case "set": {
      noMoreThan(0, parsed.positionals, "profile set [--name <name>] [--share-profile | --no-share-profile]");
      const params: Record<string, unknown> = {};
      if (parsed.options.name !== undefined) params.name = parsed.options.name;
      if (parsed.options["share-profile"] !== undefined) params.shareProfile = parsed.options["share-profile"];
      if (!Object.keys(params).length) throw new CliError("usage", "ghostly profile set [--name <name>] [--share-profile | --no-share-profile]");
      print(await withSession(g, (s) => s.call("profile.set", params)));
      return;
    }
    case "backup": {
      noMoreThan(0, parsed.positionals, "profile backup --out <file> [--passphrase-file f | --no-passphrase] [--light]");
      const out = parsed.options.out;
      if (typeof out !== "string") throw new CliError("usage", "ghostly profile backup --out <file> [--passphrase-file f | --no-passphrase] [--light] (or GHOSTLY_BACKUP_PASSPHRASE)");
      // Encrypted unless --no-passphrase says otherwise, and never a guess: a passphrase and --no-passphrase together are refused.
      const unsealed = parsed.options.passphrase === false;
      if (parsed.options.passphrase === true) throw new CliError("usage", "The passphrase comes from --passphrase-file or GHOSTLY_BACKUP_PASSPHRASE, never the command line");
      if (unsealed && (parsed.options["passphrase-file"] !== undefined || process.env.GHOSTLY_BACKUP_PASSPHRASE)) throw new CliError("usage", "A passphrase is set (--passphrase-file or GHOSTLY_BACKUP_PASSPHRASE) and --no-passphrase was given: choose one");
      const light = parsed.options.light === true ? { light: true } : {};
      // The passphrase is read before the profile opens, and the backup only reads the store: offline.
      const path = here(out) as string;
      const params = unsealed ? { path, noPassphrase: true, ...light } : { path, passphrase: backupPassphrase(parsed.options["passphrase-file"]), ...light };
      const made = await withSession(g, (s) => s.call("profile.backup", params), { offline: true });
      if (unsealed) process.stderr.write("Not encrypted: this file holds the profile's keys, chats and wallet secrets in the clear. Anyone who gets it gets everything in it, including any money in its wallets.\n");
      print(made);
      return;
    }
    case "restore": {
      const [file, name] = parsed.positionals;
      if (!file || !name) throw new CliError("usage", "ghostly profile restore <file> <new profile> [--passphrase-file f] [--use]");
      noMoreThan(2, parsed.positionals, "profile restore <file> <new profile> [--passphrase-file f] [--use]");
      // A backup made without a passphrase says so in its header: none is asked for, and the answer says it was not protected.
      const { backupFileProtection, restoreProfile } = await import("./backup");
      const protection = await backupFileProtection(file);
      const paths = await restoreProfile(g.home, checkProfileName(name), file, protection === "none" ? undefined : backupPassphrase(parsed.options["passphrase-file"], RESTORE_PASSPHRASE));
      if (parsed.options.use) selectProfile(g.home, name);
      print({ restored: name, folder: paths.dir, protection });
      return;
    }
    default:
      throw unknownCommand("profile", sub);
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

const BACKUP_PASSPHRASE = "The backup passphrase comes from --passphrase-file or GHOSTLY_BACKUP_PASSPHRASE (at least 12 characters). For a backup that is not encrypted, say so with --no-passphrase";
/** Restore takes no --no-passphrase: a backup made without one says so itself. */
const RESTORE_PASSPHRASE = "This backup is encrypted: its passphrase comes from --passphrase-file or GHOSTLY_BACKUP_PASSPHRASE";

/**
 * The backup passphrase: from a file or the environment, never the command line (it would sit in shell history). The
 * file is said as every other file the CLI reads: "" names none, a folder is named, and an empty one is called that,
 * not "comes from --passphrase-file" to someone who gave it.
 */
function backupPassphrase(file: unknown, missing = BACKUP_PASSPHRASE): string {
  if (typeof file !== "string") {
    const value = process.env.GHOSTLY_BACKUP_PASSPHRASE;
    if (!value) throw new CliError("usage", missing);
    return value;
  }
  let value: string;
  try { value = readFileSync(here(file) as string, "utf8").replace(/\r?\n$/, ""); } catch (error) { throw localFileError(error, file) ?? error; }
  if (!value) throw new CliError("bad_request", `${file} is empty: it holds the backup's passphrase`);
  return value;
}

async function runDaemon(g: Globals): Promise<void> {
  requireProfile(g);
  if (await connectDaemon(g.paths)) throw new CliError("busy", `A daemon already runs profile ${g.profile}`);
  const { keepServing, openHost, serve } = await engineHost();
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
  if (!sub || ["status", "stop", "restart"].includes(sub)) noMoreThan(0, parsed.positionals, sub ? `daemon ${sub} [--timeout s]` : "daemon [--detach] [--timeout s]");
  if (sub === "status") {
    knownProfile(g);
    const client = await connectDaemon(g.paths);
    // The socket, running or not: a program on the socket API (examples/*.mjs) finds it here. It is in the profile's
    // folder, or in /tmp/ghostly-<hash>/ when that path is too long for a socket, so a program cannot guess it.
    if (!client) { print({ running: false, profile: g.profile, socket: g.paths.socket }); return; }
    try { print({ running: true, ...(await client.call("status", {}, { timeoutMs: seconds(parsed, 15) * 1000 }) as object), socket: g.paths.socket }); } finally { client.close(); }
    return;
  }
  if (sub === "stop") {
    knownProfile(g);
    const stopFor = seconds(parsed, 20);
    const client = await connectDaemon(g.paths);
    if (!client) throw new CliError("not_found", `No daemon runs profile ${g.profile}`);
    print({ stopped: true, pid: await stopDaemon(g, client, stopFor) });
    return;
  }
  if (sub === "restart") {
    // The running one stops (if one runs), and this command's own code starts in the background.
    const stopFor = seconds(parsed, 20), startFor = seconds(parsed, 60);
    const client = await connectDaemon(g.paths);
    // The version it ran is asked ahead of the stop, on the same connection, with no deadline of its own: cosmetic,
    // and the stop's deadline ends it (a deadline here, 15 s, closed the connection under a longer stop, which then
    // failed as `unavailable` and never reached the signals).
    const probe = client ? client.call("status").catch(() => null) as Promise<{ version?: string } | null> : null;
    const stopped = client ? await stopDaemon(g, client, stopFor) : null;
    const before = (await probe)?.version ?? null;
    const started = await startDetached(g, startFor);
    print({ restarted: true, stopped, before, version: VERSION, ...started });
    return;
  }
  if (sub) throw unknownCommand("daemon", sub);
  const startFor = seconds(parsed, 60);
  if (!parsed.options.detach) { await runDaemon(g); return; }
  print(await startDetached(g, startFor));
}

/** `--timeout <s>`, or `fallback` without one: seconds above 0 (0 or less would not wait at all). */
function seconds(parsed: Parsed, fallback: number): number {
  const value = parsed.options.timeout;
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !(value > 0)) throw new CliError("usage", "--timeout takes a number of seconds above 0");
  return value;
}

/**
 * Asks the daemon to stop and waits until its process is gone, not only until it let go of the profile (it releases
 * the lock a moment before it exits); its pid. One that does not answer the ask in `seconds` (its event loop wedged)
 * is sent SIGTERM, and SIGKILL when that did not end it either in as long: `daemon restart` then starts a fresh one,
 * as the timeout error promises. The pid is the profile lock's holder, which a daemon writes itself. On Windows
 * `process.kill` with either name is TerminateProcess: the first signal ends it, there is no second.
 */
async function stopDaemon(g: Globals, client: DaemonClient, seconds: number): Promise<number> {
  let pid: number, answered = true;
  try { ({ pid } = await client.call("daemon.stop", {}, { timeoutMs: seconds * 1000 }) as { pid: number }); }
  catch (error) {
    // What answers on the socket and does not prove it is the profile's daemon is told nothing: a daemon of an older
    // release (it cannot prove it) is stopped as the process that holds the profile's lock, which only this user
    // can write. With nobody holding it, what answers is not the daemon, and the refusal stands.
    const refused = isNotTheDaemon(error);
    if (!(error instanceof CliError && error.code === "timeout") && !refused) throw error;
    const holder = lockOwner(g.paths);
    if (holder === null) throw error;
    process.stderr.write(refused
      ? `ghostly: what answers on the socket did not prove it is this profile's daemon (an older release's cannot): stopping the process that holds the profile (${holder}) with SIGTERM\n`
      : `ghostly: the daemon (process ${holder}) did not answer daemon.stop in ${seconds} s: stopping it with SIGTERM\n`);
    pid = holder;
    answered = false;
    signal(pid, "SIGTERM");
  }
  client.close();
  const running = () => lockOwner(g.paths) === pid || processAlive(pid);
  const gone = async () => {
    const until = Date.now() + seconds * 1000;
    while (running()) {
      const left = until - Date.now();
      if (left <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, left)));
    }
    return !running();
  };
  if (await gone()) return pid;
  // A wedged event loop runs no SIGTERM handler either.
  if (!answered) {
    process.stderr.write(`ghostly: the daemon (process ${pid}) did not stop on SIGTERM in ${seconds} s: killing it\n`);
    signal(pid, "SIGKILL");
    if (await gone()) return pid;
  }
  throw new CliError("timeout", `The daemon (process ${pid}) has not stopped yet`, { pid });
}

/** Throws busy, with its pid, when a process other than `except` holds the profile. */
function heldBy(g: Globals, except?: number): void {
  const owner = lockOwner(g.paths);
  if (owner !== null && owner !== except) throw new CliError("busy", `Profile ${g.profile} is in use by process ${owner}`, { pid: owner });
}

/** Gone already, or not ours to signal: the wait that follows says so. */
function signal(pid: number, name: "SIGTERM" | "SIGKILL"): void {
  try { process.kill(pid, name); } catch { /* ESRCH, EPERM */ }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** A daemon in the background, running this command's code, once its socket answers. */
async function startDetached(g: Globals, seconds: number) {
  requireProfile(g);
  if (await connectDaemon(g.paths)) throw new CliError("busy", `A daemon already runs profile ${g.profile}`);
  // A one-shot command (or a listen) that opened the profile in process holds it: the child would only log that.
  heldBy(g);
  const log = openSync(g.paths.log, "a", 0o600);
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "daemon", "--home", g.home, "--profile", g.profile], { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  const spawned = { error: null as Error | null };
  // A spawn that fails outright (EAGAIN, EMFILE) sets `exitCode` to the errno before the "error" event, so the loop below
  // ends on its own; the listener swallows the otherwise uncaught event and keeps the cause for the message.
  child.once("error", (error) => { spawned.error = error; });
  const until = Date.now() + seconds * 1000;
  let client: DaemonClient | null = null;
  // Try at once, then every 200 ms, never past `until`: a small `--timeout` gives up near-immediately instead of always
  // waiting one 200 ms poll first (the first try finds no socket yet and returns at once). A child that exited or was
  // killed (SIGABRT on a V8 out-of-memory, the OOM killer) ends the wait too, instead of polling to the deadline.
  while (child.exitCode === null && child.signalCode === null && !spawned.error) {
    const left = until - Date.now();
    if (left <= 0) break;
    client = await connectDaemon(g.paths, Math.min(500, left));
    if (client) break;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(200, until - Date.now()))));
  }
  if (!client) {
    heldBy(g, child.pid); // another process took the profile between the check and the child's start
    // Alive still: it is starting (a large profile takes seconds), not failed, and the profile is its own now.
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined && processAlive(child.pid)) {
      throw new CliError("timeout", `The daemon (process ${child.pid}) is still starting; ghostly daemon status shows when it is up`, { pid: child.pid, log: g.paths.log });
    }
    throw new CliError("engine", spawned.error ? `The daemon could not be spawned: ${spawned.error.message}` : `The daemon did not start; see ${g.paths.log}`);
  }
  client.close();
  return { daemon: "started", profile: g.profile, pid: child.pid, socket: g.paths.socket, log: g.paths.log };
}

/**
 * Nobody reads `listen`'s output any more (`listen | head -n 1`, a `grep -m1` that found its line): it stops as on
 * SIGTERM, exit 0. Through a daemon it died on an 'error' nobody handled; on its own profile it served on with nobody
 * to tell, holding the profile until `daemon stop`. Any other failure of the output is still an error.
 */
function onReaderGone(stop: () => void): void {
  let gone = false;
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (gone) return;
    if (error.code !== "EPIPE") throw error;
    gone = true;
    stop();
  });
}

async function listenCommand(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, {
    since: { type: "number", description: "" }, cursor: { type: "string", description: "" }, type: { type: "list", description: "" },
    exec: { type: "string", description: "" }, webhook: { type: "string", description: "" }, print: { type: "boolean", description: "" },
    from: { type: "list", description: "" }, group: { type: "list", description: "" }, turns: { type: "boolean", description: "" },
  });
  // Before the profile opens: `listen bob` (meant as `--from bob`) streams nobody's events instead of everybody's.
  noMoreThan(0, parsed.positionals, SPECIAL.find(([usage]) => usage.startsWith("listen "))![0]);
  // Before the profile opens: a unit file's `--webhook "$URL"` with URL unset ran a plain listen, no hook and no word.
  const blank = (value: unknown) => typeof value === "string" && value.trim() === "";
  if (blank(parsed.options.webhook)) throw new CliError("usage", "--webhook needs a URL");
  if (blank(parsed.options.exec)) throw new CliError("usage", "--exec needs a command");
  if (parsed.options.cursor === "") throw new CliError("usage", "--cursor needs a file");
  if ((parsed.options.from as string[] | undefined)?.some(blank)) throw new CliError("usage", "--from needs a chat or a contact key");
  if ((parsed.options.group as string[] | undefined)?.some(blank)) throw new CliError("usage", "--group needs a group");
  const g = globals(parsed);
  pretty = false; // one event per line
  if (parsed.options.webhook !== undefined) checkWebhook(String(parsed.options.webhook));
  const types = (parsed.options.type as string[] | undefined) ?? [];
  const turns = parsed.options.turns === true;
  if (turns && types.length) throw new CliError("usage", "--turns takes the place of --type: a turn is a message received, or a group message that mentions you");
  checkTypes(types, (line) => process.stderr.write(line + "\n"));
  const from = (parsed.options.from as string[] | undefined) ?? [], groups = (parsed.options.group as string[] | undefined) ?? [];
  const cursor = parsed.options.cursor as string | undefined;
  // Before the profile opens: a cursor that cannot be written is no per-event warning.
  checkCursor(cursor);
  const since = (parsed.options.since as number | undefined) ?? readCursor(cursor);
  const start = async (call: (method: string, params: Record<string, unknown>) => Promise<unknown>, peerOf: (chat: string) => Promise<string | null>) => {
    return eventHandler({
      types, turns,
      exec: parsed.options.exec as string | undefined,
      webhook: parsed.options.webhook as string | undefined,
      cursor,
      // With a hook, events go to the hook; --print shows them too.
      print: parsed.options.print === true || (!parsed.options.exec && !parsed.options.webhook),
      write: (line) => process.stdout.write(line + "\n"),
      drained: () => new Promise<void>((resolve) => {
        const done = () => { process.stdout.off("drain", done); process.stdout.off("close", done); resolve(); };
        process.stdout.on("drain", done);
        process.stdout.on("close", done);
      }),
      allow: from.length || groups.length ? await allowlist(from, groups, call, peerOf) : undefined,
    });
  };
  requireProfile(g);
  const client = await connectDaemon(g.paths);
  if (client) await warnVersion(client);
  if (client) {
    // The subscription takes the connection: a chat's contact key is asked on a connection of its own.
    const handle = await start((m, p) => client.call(m, p), async (chat) => {
      const c = await connectDaemon(g.paths, 1000);
      if (!c) return null;
      try { return ((await c.call("chat.get", { chat }, { timeoutMs: ANSWER_MS })) as { peer?: string }).peer || null; } finally { c.close(); }
    }).catch((error) => { client.close(); throw error; });
    // Followed until stopped, past a daemon restart and past a feed that fell behind (`followDaemon`).
    const following = followDaemon(g.paths, client, handle, since);
    const stop = () => { following.close(); process.exit(0); };
    onReaderGone(stop);
    await following.subscribed;
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }
  // No daemon: this process becomes it (the socket too, so hooks can answer with `ghostly send`).
  const [{ keepServing, openHost, serve }, { callApi }] = await Promise.all([engineHost(), engineApi()]);
  const host: Host = await openHost(g.paths, "daemon", VERSION);
  const call = (m: string, p: Record<string, unknown>) => callApi(host.ctx, m, p);
  const handle = await start(call, async (chat) => ((await call("chat.get", { chat })) as { peer?: string }).peer || null).catch(async (error) => { await host.close(); throw error; });
  const served = await serve(host).catch(async (error) => { await host.close(); throw error; });
  keepServing();
  const stop = stopper(async () => { await served.close(); await host.close(); });
  host.ctx.stop = stop;
  onStopSignals(stop);
  onReaderGone(stop);
  // The hub's listener comes off while the feed is paused, and back after a replay from the last event taken. What a
  // replay gave and the feed did not take yet waits for the resume: one read of the journal per catch-up, not one per
  // pause; the journal is read again only for what came meanwhile.
  let off: (() => void) | null = null, left: GhostlyEvent[] = [];
  const open = (from: number | undefined) => {
    for (;;) {
      const events = left.length ? left : host.ctx.hub.replay(from ?? host.ctx.hub.lastSeq);
      left = [];
      if (!events.length) break;
      for (let i = 0; i < events.length; i++) {
        feed.take(events[i]);
        if (feed.paused) { left = events.slice(i + 1); return; }
      }
      from = feed.since;
    }
    off = host.ctx.hub.onEvent(feed.take);
  };
  const feed = new Feed(handle, since, () => { off?.(); off = null; }, open);
  open(since);
  host.ctx.hub.emit("daemon.started", `daemon.started:${process.pid}:${Date.now()}`, { pid: process.pid, version: VERSION, listen: true });
}

async function engineCommand(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, { "confirm-real": { type: "boolean", description: "" }, "show-secret": { type: "boolean", description: "" }, yes: { type: "boolean", description: "" }, force: { type: "boolean", description: "" }, list: { type: "boolean", description: "" }, verbose: { type: "boolean", description: "" } });
  const g = globals(parsed);
  pretty = g.pretty;
  if (parsed.options.list) {
    noMoreThan(0, parsed.positionals, "engine --list [--verbose]");
    const methods = [...ENGINE_METHODS, ...ENGINE_READS].sort();
    // `takes`: what each call takes, in ENGINE_PARAMS' words.
    print(parsed.options.verbose ? { methods, takes: Object.fromEntries(methods.map((m) => [m, ENGINE_PARAMS[m] ?? READ_PARAMS[m]])) } : { methods });
    return;
  }
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
  const yes = parsed.options.yes === true;
  let result = await withSession(g, (s) => s.call("engine.call", { method, params, confirmReal, yes, force: parsed.options.force === true }), { offline: ENGINE_READS.includes(method) });
  if (method === "getState" && !showSecret && result && typeof result === "object") {
    const { hideStateSecrets } = await engineApi();
    result = hideStateSecrets(result as Parameters<typeof hideStateSecrets>[0]);
  }
  print(result);
}

async function settingsCommand(sub: string | undefined, argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, { "show-secret": { type: "boolean", description: "" } });
  const g = globals(parsed);
  pretty = g.pretty;
  if (sub === "get") { noMoreThan(0, parsed.positionals, "settings get [--show-secret]"); print(await withSession(g, (s) => s.call("settings.get", { showSecret: parsed.options["show-secret"] === true }), { offline: true })); return; }
  if (sub === "set") {
    const [key, value] = parsed.positionals;
    if (!key || value === undefined || parsed.positionals.length > 2) throw new CliError("usage", "ghostly settings set <key> <json-value>");
    let parsedValue: unknown;
    try { parsedValue = JSON.parse(value); } catch { parsedValue = value; }
    // A text setting (nick) keeps the word as given when it reads as JSON of another kind (2024, true, null).
    if ((await engineApi()).SETTABLE[key] === "string" && typeof parsedValue !== "string") parsedValue = value;
    printAnswer(await withSession(g, (s) => s.call("settings.set", { [key]: parsedValue }), { offline: LOCAL_SETTINGS.has(key) }) as Record<string, unknown>);
    return;
  }
  throw unknownCommand("settings", sub);
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
  // Stdin only when no text word was given at all: `send bob "$line"` with an empty line is no text, not the rest of stdin.
  let text = words.join(" ");
  if (parsed.options.text !== undefined) {
    if (text || parsed.options.stdin) throw new CliError("usage", "Give the text once: as arguments, --text or stdin");
    text = String(parsed.options.text);
  } else if (parsed.options.stdin || (words.length === 0 && !process.stdin.isTTY)) {
    if (text) throw new CliError("usage", "Give the text as arguments or on stdin, not both");
    text = (await readStdin()).replace(/\n$/, "");
  }
  if (!text.trim()) throw new CliError("usage", `No text: ghostly ${spec.usage}`);
  const params: Record<string, unknown> = { [spec.target]: target, text, force: parsed.options.force === true, ...(message !== undefined && { message }) };
  if (spec.target === "group") params.mentions = parsed.options.mention ?? [];
  if (parsed.options.reply !== undefined) params.reply = parsed.options.reply;
  if (!spec.message) Object.assign(params, (await import("./buttons")).buttonsOf(parsed.options));
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
  }, { deferGroups: spec.target === "chat" }));
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
  const client = await connectDaemon(g.paths);
  if (client) {
    await warnVersion(client);
    const watcher = await connectDaemon(g.paths);
    await watcher?.subscribe(undefined, tell);
    try { print(await client.call("identity.add", params)); } finally { client.close(); watcher?.close(); }
    return;
  }
  const [{ openHost }, { callApi }] = await Promise.all([engineHost(), engineApi()]);
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
  if (command.run) {
    printAnswer(await command.run(parsed, args));
    return;
  }
  const params = command.params?.(parsed, args) ?? {};
  for (const key of Object.keys(params)) if (params[key] === undefined) delete params[key];
  // Evidence is read here, where the file is: the daemon runs elsewhere.
  if (command.method === "identity.complete") {
    if (params.evidenceFile) {
      try { params.evidence = readFileSync(params.evidenceFile as string, "utf8"); } catch (error) { throw localFileError(error, params.evidenceFile as string) ?? error; }
    }
    else if (params.stdin) params.evidence = await readStdin();
    delete params.evidenceFile; delete params.stdin;
  }
  if (command.method === "x401.credential.add") {
    try { params.credential = params.file === "-" ? await readStdin() : readFileSync(params.file as string, "utf8"); }
    // A file not there, a folder, one not allowed: said as every other file the CLI reads.
    catch (error) { throw localFileError(error, params.file as string) ?? new CliError("usage", `Cannot read the credential: ${error instanceof Error ? error.message : String(error)}`); }
    // Nothing read is said of the file or stdin given, not as the API's missing `credential`.
    if (!params.credential) throw new CliError("bad_request", params.file === "-" ? "Nothing on stdin: give the SD-JWT VC the issuer sent" : `${params.file as string} is empty: it holds the SD-JWT VC the issuer sent`);
    delete params.file;
  }
  // Before stdin adds its own: only the --value names came on the command line.
  const lineValues = command.method === "wallet.create" ? Object.keys((params.values as Record<string, string> | undefined) ?? {}) : [];
  const secretWarning = await secretsFromStdin(command.method, params, readStdin, process.stdin.isTTY === true, (note) => process.stderr.write(`ghostly: ${note}\n`));
  if (secretWarning) process.stderr.write(`ghostly: ${secretWarning}\n`);
  const result = await withSession(g, async (s) => {
    if (lineValues.length) {
      // Which fields are secret is the source's form, in the engine.
      const list = await s.call("wallet.list", { network: params.network ?? "testnet" }).catch(() => undefined);
      const warning = secretValuesWarning(list, params.type, params.provider, lineValues);
      if (warning) process.stderr.write(`ghostly: ${warning}\n`);
    }
    const result = await s.call(command.method, params) as Record<string, unknown>;
    // A one-shot join leaves once the contact can be reached: its answer has to be out first.
    if (command.method === "invite.join" && s.mode === "one-shot") {
      const joined = await oneShotJoinWait(s, result, typeof params.label === "string" ? params.label : undefined);
      if (joined.note) process.stderr.write(`ghostly: ${joined.note}\n`);
      return joined.answer;
    }
    return result;
  }, { deferGroups: chatOnly(command.method, params), offline: offlineCall(command.method, params) });
  printAnswer(result);
}

/**
 * `call pipe`: a call's audio socket bridged to stdin and stdout, for shell pipelines. stdout carries audio only (the
 * contact's, raw PCM); what the command says goes to stderr. It ends when the call does.
 */
async function callPipeCommand(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, {}, idSlot({ args: ["call...?"] }));
  const g = globals(parsed);
  const ref = parsed.positionals.join(" ") || undefined;
  const client = await connectDaemon(g.paths);
  if (!client) throw new CliError("unavailable", `No daemon runs profile ${g.profile}: calls need one (ghostly daemon --detach)`);
  let call: { call: string; audio: { socket: string; rate: number } | null };
  try { call = await client.call("call.get", ref ? { call: ref } : {}, { timeoutMs: ANSWER_MS }) as typeof call; } finally { client.close(); }
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

/**
 * The command's words when the line asks for help (`help <words>`, or `--help`/`--help=true`/`-h` before any `--`), else
 * null. `--help=false` asks for none: the command runs.
 */
function helpAsked(argv: readonly string[]): string[] | null {
  const end = argv.indexOf("--");
  const head = end === -1 ? argv : argv.slice(0, end);
  const words = (list: readonly string[]) => { const out: string[] = []; for (const word of list) { if (word.startsWith("-")) break; out.push(word); } return out; };
  if (head[0] === "help") return words(head.slice(1));
  if (head.some((word) => word === "--help" || word === "--help=true" || word === "-h")) return words(head);
  return null;
}

export async function main(input: string[]): Promise<number> {
  const argv = liftGlobals(input);
  // Global options alone (`ghostly --pretty`, `ghostly -p bot`) name no command: lifted, one of them comes first.
  const helpFor = argv.length === 0 || globalOption(argv[0]) ? [] : helpAsked(argv);
  if (helpFor) { process.stdout.write((helpFor.length ? commandHelp(helpFor) : help()) + "\n"); return 0; }
  if (argv[0] === "--version" || argv[0] === "version") {
    // Global options come after the command once lifted: `--pretty` indents this answer too. Anything else is refused,
    // as every command refuses it: `version --json` (a typo) answered the version.
    const parsed = parseArgs(argv.slice(1), {});
    noMoreThan(0, parsed.positionals, "version");
    pretty = parsed.options.pretty === true;
    print({ version: VERSION });
    return 0;
  }
  const [first, second, third] = argv;
  const two = second && !second.startsWith("-") ? `${first} ${second}` : "";
  const three = two && third && !third.startsWith("-") ? `${two} ${third}` : "";
  // A command is one its table lists itself: every object has `constructor` and `toString`, which are no commands.
  const text = (name: string) => Object.hasOwn(TEXT_COMMANDS, name), table = (name: string) => Object.hasOwn(COMMANDS, name);
  if (first === "profile" && !table(two)) { await profileCommand(second, argv.slice(2)); return 0; }
  if (first === "daemon") { await daemonCommand(argv.slice(1)); return -1; }
  if (first === "listen") { await listenCommand(argv.slice(1)); return -1; }
  if (first === "engine") { await engineCommand(argv.slice(1)); return 0; }
  if (first === "settings") { await settingsCommand(second, argv.slice(2)); return 0; }
  if (two === "identity add") { await identityAddCommand(argv.slice(2)); return 0; }
  if (two === "call pipe") { await callPipeCommand(argv.slice(2)); return -1; }
  if (three && table(three)) { await tableCommand(three, argv.slice(3)); return 0; }
  if (two && text(two)) { await textCommand(two, argv.slice(2)); return 0; }
  if (two && table(two)) { await tableCommand(two, argv.slice(2)); return 0; }
  if (text(first)) { await textCommand(first, argv.slice(1)); return 0; }
  if (table(first)) { await tableCommand(first, argv.slice(1)); return 0; }
  throw unknownCommand(first, two ? second : undefined, three ? third : undefined);
}

/**
 * A command line that names no command. The words of a group (`ghostly chat`, `ghostly wallet frob`, `ghostly x401
 * credential`) are answered with the group's commands, as `ghostly help chat` lists them; before, it was only "Unknown
 * command: chat". The longest group the words name answers: `x401 credential frob` lists add, list and remove.
 */
export function unknownCommand(first: string | undefined, second?: string, third?: string): CliError {
  const asked = [first, second, third].filter((word): word is string => !!word);
  const all = helpRows().map((row) => commandWords(row.usage));
  for (let depth = Math.min(asked.length, 2); depth >= 1; depth--) {
    const group = asked.slice(0, depth), name = group.join(" "), extra = asked[depth];
    const subs = [...new Set(all.filter((words) => words.length > depth && group.every((word, i) => words[i] === word)).map((words) => words[depth]))];
    if (!subs.length) continue;
    const list = `${subs.slice(0, -1).join(", ")}${subs.length > 1 ? " or " : ""}${subs.at(-1)}`;
    return new CliError("usage", extra ? `Unknown command: ${name} ${extra}: ghostly ${name} takes ${list} (ghostly help ${name})` : `ghostly ${name} takes a command: ${list} (ghostly help ${name})`);
  }
  return new CliError("usage", `Unknown command: ${asked.slice(0, 2).join(" ")} (ghostly help)`);
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
