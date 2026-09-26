import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import packageJson from "../package.json" with { type: "json" };
import { GLOBAL_OPTIONS, liftGlobals, parseArgs, type OptionSpec, type Parsed } from "./args";
import { callApi, redactSettings } from "./api";
import { connectDaemon, type DaemonClient } from "./client";
import { COMMANDS, positionals, TEXT_COMMANDS } from "./commands";
import { ENGINE_METHODS, ENGINE_READS, SECRET_RESULTS } from "./engineMethods";
import { asCliError, CliError, EXIT } from "./errors";
import type { GhostlyEvent } from "./events";
import { openHost, serve, type Host } from "./host";
import { checkWebhook, eventHandler, readCursor } from "./listen";
import {
  createProfile, currentProfile, DEFAULT_PROFILE, ghostlyHome, listProfiles, lockOwner, profileExists, profilePaths, selectProfile,
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

async function session(g: Globals): Promise<Session> {
  requireProfile(g);
  const client = await connectDaemon(g.paths.socket);
  if (client) return { mode: "daemon", call: (m, p) => client.call(m, p), close: async () => client.close() };
  const host = await openHost(g.paths, "one-shot", VERSION);
  return { mode: "one-shot", call: (m, p) => callApi(host.ctx, m, p ?? {}), close: () => host.close() };
}

async function withSession<T>(g: Globals, work: (s: Session) => Promise<T>): Promise<T> {
  const s = await session(g);
  try { return await work(s); } finally { await s.close(); }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// ---------- help ----------

const SPECIAL: [string, string][] = [
  ["profile create <name> [--use] [--name <shown name>]", "Make a profile (its own keys, chats and wallets)"],
  ["profile list", "Profiles, and which one is current"],
  ["profile use <name>", "Make a profile the current one"],
  ["profile show", "The name contacts see, and whether it is shared"],
  ["profile set [--name <name>] [--share-profile | --no-share-profile]", "Change the name contacts see"],
  ["daemon [--detach]", "Keep the profile online (foreground; --detach runs it in the background)"],
  ["daemon status", "Whether a daemon runs the profile"],
  ["daemon stop", "Stop the profile's daemon"],
  ["listen [--since seq] [--cursor file] [--type t]... [--exec cmd] [--webhook url]", "Stream events as JSON lines (starts the profile here if no daemon runs it)"],
  ["settings get [--show-secret]", "The profile's settings"],
  ["settings set <key> <json-value>", "Change one: relays, irohRelays, hyperdhtRelay, readRelays, iceServers, publicProfiles, online, shareProfile, nick"],
  ["engine <method> [json-params | -] [--confirm-real] [--show-secret]", "Any call of the app's engine, with its own parameters"],
  ["engine --list", "The engine's calls"],
];

function help(): string {
  const rows: [string, string][] = [
    ...SPECIAL.slice(0, 5),
    ...Object.values(COMMANDS).filter((c) => c.method !== "events.replay").map((c) => [c.usage, c.summary] as [string, string]),
    ...Object.values(TEXT_COMMANDS).map((c) => [c.usage, c.summary] as [string, string]),
    ...SPECIAL.slice(5),
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

// ---------- commands with their own flow ----------

async function profileCommand(sub: string | undefined, argv: string[]): Promise<void> {
  const specs: Record<string, Record<string, OptionSpec>> = {
    create: { use: { type: "boolean", description: "" }, name: { type: "string", description: "" } },
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
    default:
      throw new CliError("usage", "ghostly profile create|list|use|show|set");
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

async function runDaemon(g: Globals): Promise<void> {
  requireProfile(g);
  if (await connectDaemon(g.paths.socket)) throw new CliError("busy", `A daemon already runs profile ${g.profile}`);
  const host = await openHost(g.paths, "daemon", VERSION);
  let served: Awaited<ReturnType<typeof serve>>;
  try { served = await serve(host); } catch (error) { await host.close(); throw error; }
  const stop = stopper(async () => { await served.close(); await host.close(); });
  host.ctx.stop = stop;
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
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
    if (!client) { print({ running: false, profile: g.profile }); return; }
    try { print({ running: true, ...(await client.call("status") as object) }); } finally { client.close(); }
    return;
  }
  if (sub === "stop") {
    const client = await connectDaemon(g.paths.socket);
    if (!client) throw new CliError("not_found", `No daemon runs profile ${g.profile}`);
    const { pid } = await client.call("daemon.stop") as { pid: number };
    client.close();
    const until = Date.now() + (Number(parsed.options.timeout) || 20) * 1000;
    while (lockOwner(g.paths) === pid && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
    if (lockOwner(g.paths) === pid) throw new CliError("timeout", `The daemon (process ${pid}) has not stopped yet`);
    print({ stopped: true, pid });
    return;
  }
  if (sub) throw new CliError("usage", "ghostly daemon [--detach] | daemon status | daemon stop");
  if (!parsed.options.detach) { await runDaemon(g); return; }
  requireProfile(g);
  if (await connectDaemon(g.paths.socket)) throw new CliError("busy", `A daemon already runs profile ${g.profile}`);
  const log = openSync(g.paths.log, "a", 0o600);
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "daemon", "--home", g.home, "--profile", g.profile], { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  const until = Date.now() + (Number(parsed.options.timeout) || 60) * 1000;
  let client: DaemonClient | null = null;
  while (!client && Date.now() < until) {
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
    client = await connectDaemon(g.paths.socket, 500);
  }
  if (!client) throw new CliError("engine", `The daemon did not start; see ${g.paths.log}`);
  client.close();
  print({ daemon: "started", profile: g.profile, pid: child.pid, socket: g.paths.socket, log: g.paths.log });
}

async function listenCommand(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, {
    since: { type: "number", description: "" }, cursor: { type: "string", description: "" }, type: { type: "list", description: "" },
    exec: { type: "string", description: "" }, webhook: { type: "string", description: "" }, print: { type: "boolean", description: "" },
  });
  const g = globals(parsed);
  pretty = false; // one event per line
  if (parsed.options.webhook) checkWebhook(String(parsed.options.webhook));
  const cursor = parsed.options.cursor as string | undefined;
  let since = (parsed.options.since as number | undefined) ?? readCursor(cursor);
  const handle = eventHandler({
    types: (parsed.options.type as string[] | undefined) ?? [],
    exec: parsed.options.exec as string | undefined,
    webhook: parsed.options.webhook as string | undefined,
    cursor,
    // With a hook, events go to the hook; --print shows them too.
    print: parsed.options.print === true || (!parsed.options.exec && !parsed.options.webhook),
    write: (line) => process.stdout.write(line + "\n"),
  });
  const onEvent = (event: GhostlyEvent) => { since = event.seq; handle(event); };
  requireProfile(g);
  const client = await connectDaemon(g.paths.socket);
  if (client) {
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
  const served = await serve(host).catch(async (error) => { await host.close(); throw error; });
  const stop = stopper(async () => { await served.close(); await host.close(); });
  host.ctx.stop = stop;
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
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
    const state = result as { settings: Parameters<typeof redactSettings>[0] };
    result = { ...state, settings: redactSettings(state.settings) };
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
  const parsed = parseArgs(argv, spec.options);
  const g = globals(parsed);
  pretty = g.pretty;
  const [target, ...words] = parsed.positionals;
  if (!target) throw new CliError("usage", `ghostly ${spec.usage}`);
  let text = words.join(" ");
  if (parsed.options.stdin || (!text && !process.stdin.isTTY)) {
    if (text) throw new CliError("usage", "Give the text as arguments or on stdin, not both");
    text = (await readStdin()).replace(/\n$/, "");
  }
  if (!text.trim()) throw new CliError("usage", `No text: ghostly ${spec.usage}`);
  const params: Record<string, unknown> = { [spec.target]: target, text, force: parsed.options.force === true };
  if (spec.target === "group") params.mentions = parsed.options.mention ?? [];
  print(await withSession(g, (s) => {
    if (spec.target === "chat") {
      // A one-shot leaves once its command is done: by default it stays until the message went out.
      params.wait = parsed.options.wait ?? (s.mode === "one-shot" ? "sent" : "none");
      if (parsed.options.timeout !== undefined) params.timeout = parsed.options.timeout;
    }
    return s.call(spec.method, params);
  }));
}

async function tableCommand(name: string, argv: string[]): Promise<void> {
  const command = COMMANDS[name];
  const parsed = parseArgs(argv, command.options ?? {});
  const g = globals(parsed);
  pretty = g.pretty;
  const args = positionals(command, parsed.positionals);
  const params = command.params?.(parsed, args) ?? {};
  for (const key of Object.keys(params)) if (params[key] === undefined) delete params[key];
  print(await withSession(g, async (s) => {
    const result = await s.call(command.method, params) as Record<string, unknown>;
    // A one-shot join leaves once the contact can be reached: its answer has to be out first.
    if (command.method === "invite.join" && s.mode === "one-shot") {
      await s.call("chat.wait", { chat: result.chat, until: "paired", timeout: 60 }).catch(() => {});
    }
    return result;
  }));
}

// ---------- entry ----------

export async function main(input: string[]): Promise<number> {
  const argv = liftGlobals(input);
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") { process.stdout.write(help() + "\n"); return 0; }
  if (argv[0] === "--version" || argv[0] === "version") { print({ version: VERSION }); return 0; }
  const [first, second] = argv;
  const two = second && !second.startsWith("-") ? `${first} ${second}` : "";
  if (first === "profile") { await profileCommand(second, argv.slice(2)); return 0; }
  if (first === "daemon") { await daemonCommand(argv.slice(1)); return -1; }
  if (first === "listen") { await listenCommand(argv.slice(1)); return -1; }
  if (first === "engine") { await engineCommand(argv.slice(1)); return 0; }
  if (first === "settings") { await settingsCommand(second, argv.slice(2)); return 0; }
  if (two && TEXT_COMMANDS[two]) { await textCommand(two, argv.slice(2)); return 0; }
  if (two && COMMANDS[two]) { await tableCommand(two, argv.slice(2)); return 0; }
  if (TEXT_COMMANDS[first]) { await textCommand(first, argv.slice(1)); return 0; }
  if (COMMANDS[first]) { await tableCommand(first, argv.slice(1)); return 0; }
  throw new CliError("usage", `Unknown command: ${[first, second].filter(Boolean).join(" ")} (ghostly help)`);
}

/** Leaves once what was printed reached stdout (a pipe drains asynchronously). */
function exit(code: number): void {
  process.stdout.write("", () => process.exit(code));
}

/** Runs the command line; `-1` from `main` means the process stays (a daemon, a listener). */
export async function run(argv: string[]): Promise<void> {
  try {
    const code = await main(argv);
    if (code >= 0) exit(code);
  } catch (error) {
    const failure = asCliError(error);
    print({ error: failure.toJSON() });
    exit(EXIT[failure.code]);
  }
}
