import { resolve } from "node:path";
import type { OptionSpec, Parsed } from "./args";
import { CliError } from "./errors";

/**
 * The commands that are one API method each: how the command line becomes the method's parameters. Commands with
 * their own flow (profiles, the daemon, listen, send's stdin, the engine passthrough) live in main.ts.
 */
export interface Command {
  method: string;
  usage: string;
  summary: string;
  options?: Record<string, OptionSpec>;
  /** Positionals, in order; a trailing `...` one takes the rest joined by spaces. */
  args?: string[];
  params?: (parsed: Parsed, args: Record<string, string | undefined>) => Record<string, unknown>;
}

const wait: Record<string, OptionSpec> = {
  wait: { type: "string", description: "none, sent or delivered (default: none with a daemon, sent without)" },
  timeout: { type: "number", description: "Seconds to wait (default 30)" },
};
const net: OptionSpec = { type: "string", description: "mainnet or testnet (default testnet)" };
const card: OptionSpec = { type: "string", description: "A Lightning card (its id; default: the network's default)" };
const memo: OptionSpec = { type: "string", description: "What it is for (up to 140 characters)" };
const confirmReal: OptionSpec = { type: "boolean", description: "Confirm a Mainnet (real money) spend" };

/** A path as this command's working directory means it: the daemon runs elsewhere. */
function here(path: unknown): string | undefined {
  return typeof path === "string" ? resolve(path) : undefined;
}

/** A whole number of sats from the command line. */
function sats(value: string | undefined): number {
  const n = Number(value);
  if (!value || !Number.isSafeInteger(n) || n <= 0) throw new CliError("usage", `Not an amount in sats: ${JSON.stringify(value)}`);
  return n;
}

/** `name=value` options as an object. */
function pairs(values: unknown): Record<string, string> | undefined {
  if (!Array.isArray(values) || !values.length) return undefined;
  const out: Record<string, string> = {};
  for (const item of values as string[]) {
    const eq = item.indexOf("=");
    if (eq < 1) throw new CliError("usage", `--value takes name=value, not ${JSON.stringify(item)}`);
    out[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return out;
}

const force: OptionSpec = { type: "boolean", description: "Send even if the text looks like a seed, a key or ecash" };
const reply: OptionSpec = { type: "string", description: "Reply to this message (its id, from history or an event)" };

export const COMMANDS: Record<string, Command> = {
  "status": { method: "status", usage: "status", summary: "The profile, its chats and whether a daemon runs it" },

  "invite create": {
    method: "invite.create", usage: "invite create [--label <name>]", summary: "A new chat's ghostly1 invite and its link",
    options: { label: { type: "string", description: "A name for the chat on this side" } },
    params: ({ options }) => ({ label: options.label }),
  },
  "invite join": {
    method: "invite.join", usage: "invite join <invite-or-link> [--label <name>]", summary: "Join a chat from its invite",
    args: ["invite"], options: { label: { type: "string", description: "A name for the chat on this side" } },
    params: ({ options }, { invite }) => ({ invite, label: options.label }),
  },

  "chat list": { method: "chat.list", usage: "chat list", summary: "Chats, newest first" },
  "chat show": { method: "chat.get", usage: "chat show <chat>", summary: "One chat and its connection", args: ["chat"], params: (_, { chat }) => ({ chat }) },
  "chat history": {
    method: "chat.history", usage: "chat history <chat> [--limit n] [--before id|ms] [--after id|ms]", summary: "Messages, oldest first (a page)",
    args: ["chat"],
    options: { limit: { type: "number", description: "Messages per page (default 50)" }, before: { type: "string", description: "Only before this message id or timestamp" }, after: { type: "string", description: "Only after this message id or timestamp" } },
    params: ({ options }, { chat }) => ({ chat, limit: options.limit, before: cursor(options.before), after: cursor(options.after) }),
  },
  "chat rename": { method: "chat.rename", usage: "chat rename <chat> <name...>", summary: "Name a chat on this side (empty: the contact's name)", args: ["chat", "name..."], params: (_, { chat, name }) => ({ chat, name: name ?? "" }) },
  "chat remove": {
    method: "chat.remove", usage: "chat remove <chat> --yes", summary: "Delete a chat, its keys and history on this device", args: ["chat"],
    options: { yes: { type: "boolean", description: "Confirm" } }, params: ({ options }, { chat }) => ({ chat, yes: options.yes === true }),
  },
  "chat transport": { method: "chat.transport", usage: "chat transport <chat> <auto|dht|webrtc|iroh|hyperdht>", summary: "Choose what carries a chat", args: ["chat", "transport"], params: (_, a) => ({ chat: a.chat, transport: a.transport }) },
  "typing": {
    method: "chat.typing", usage: "typing <chat> [--stop]", summary: "Show the contact you are writing (live chats; again every few seconds, send or --stop ends it)", args: ["chat"],
    options: { stop: { type: "boolean", description: "Say you stopped" } }, params: ({ options }, { chat }) => ({ chat, stop: options.stop === true }),
  },
  "chat connect": { method: "chat.connect", usage: "chat connect <chat>", summary: "Reconnect a chat now", args: ["chat"], params: (_, { chat }) => ({ chat }) },
  "chat disconnect": { method: "chat.disconnect", usage: "chat disconnect <chat>", summary: "Close a chat's live session", args: ["chat"], params: (_, { chat }) => ({ chat }) },
  "chat verify": {
    method: "chat.verify", usage: "chat verify <chat> --code <code>", summary: "Mark a contact verified after comparing codes", args: ["chat"],
    options: { code: { type: "string", description: "The code the contact reads out" } }, params: ({ options }, { chat }) => ({ chat, code: options.code }),
  },
  "chat wait": {
    method: "chat.wait", usage: "chat wait <chat> [--until live|text|paired] [--timeout s]", summary: "Wait for a chat to reach a state", args: ["chat"],
    options: { until: { type: "string", description: "live (default), text or paired" }, timeout: { type: "number", description: "Seconds (default 60)" } },
    params: ({ options }, { chat }) => ({ chat, until: options.until, timeout: options.timeout }),
  },

  "message retry": { method: "chat.retry", usage: "message retry <chat> <message>", summary: "Send a failed message again", args: ["chat", "message"], params: (_, a) => ({ chat: a.chat, message: a.message }) },
  "message delete": { method: "chat.delete", usage: "message delete <chat> <message>", summary: "Forget a message on this device (the contact keeps theirs)", args: ["chat", "message"], params: (_, a) => ({ chat: a.chat, message: a.message }) },
  "message details": { method: "chat.details", usage: "message details <chat> <message>", summary: "How a message travelled", args: ["chat", "message"], params: (_, a) => ({ chat: a.chat, message: a.message }) },

  "group create": {
    method: "group.create", usage: "group create <name...> [--mesh]", summary: "A community (a link anyone can open) or, with --mesh, a private group of up to eight",
    args: ["name..."], options: { mesh: { type: "boolean", description: "A private mesh of contacts instead of a community" } },
    params: ({ options }, { name }) => ({ name, profile: options.mesh ? "mesh" : "community" }),
  },
  "group join": { method: "group.join", usage: "group join <link>", summary: "Join a group by its link", args: ["link"], params: (_, { link }) => ({ link }) },
  "group list": { method: "group.list", usage: "group list", summary: "Groups and invitations" },
  "group show": { method: "group.get", usage: "group show <group>", summary: "A group and its members", args: ["group"], params: (_, { group }) => ({ group }) },
  "group history": {
    method: "group.history", usage: "group history <group> [--limit n] [--before id|ms] [--after id|ms]", summary: "A group's messages (a page)", args: ["group"],
    options: { limit: { type: "number", description: "Messages per page (default 50)" }, before: { type: "string", description: "Only before this message id or timestamp" }, after: { type: "string", description: "Only after this message id or timestamp" } },
    params: ({ options }, { group }) => ({ group, limit: options.limit, before: cursor(options.before), after: cursor(options.after) }),
  },
  "group leave": { method: "group.leave", usage: "group leave <group>", summary: "Leave a group", args: ["group"], params: (_, { group }) => ({ group }) },
  "group forget": {
    method: "group.forget", usage: "group forget <group> --yes", summary: "Leave and delete a group's history here", args: ["group"],
    options: { yes: { type: "boolean", description: "Confirm" } }, params: ({ options }, { group }) => ({ group, yes: options.yes === true }),
  },
  "group accept": { method: "group.accept", usage: "group accept <group>", summary: "Accept an invitation to a group", args: ["group"], params: (_, { group }) => ({ group }) },
  "group decline": { method: "group.decline", usage: "group decline <group>", summary: "Decline an invitation to a group", args: ["group"], params: (_, { group }) => ({ group }) },

  "wallet list": {
    method: "wallet.list", usage: "wallet list [--network mainnet|testnet]", summary: "Wallets with their balances, and what New can make",
    options: { network: net }, params: ({ options }) => ({ network: options.network }),
  },
  "wallet create": {
    method: "wallet.create", usage: "wallet create <type> [--network testnet] [--provider <id>] [--value name=value]... [--invite <code>] [--api-key <key>]", summary: "A wallet: cashu, lightning, arkade, spark, bitcoin, usdt (bark, fedimint: app only)",
    args: ["type"], options: { network: net, provider: { type: "string", description: "Lightning or on-chain source (wallet list shows them)" }, value: { type: "list", description: "A field of the source's form, name=value" }, invite: { type: "string", description: "Fedimint: the federation's invite" }, "api-key": { type: "string", description: "Spark on Mainnet: your Breez API key" } },
    params: ({ options }, { type }) => ({ type, network: options.network, provider: options.provider, invite: options.invite, apiKey: options["api-key"], values: pairs(options.value) }),
  },
  "wallet remove": {
    method: "wallet.remove", usage: "wallet remove <type> [--network testnet] [--card <id>] [--accept-loss]", summary: "Remove a wallet; refused while it holds money or waits for some, unless --accept-loss",
    args: ["type"], options: { network: net, card: card, "accept-loss": { type: "boolean", description: "What it holds on this device is lost without its backup" } },
    params: ({ options }, { type }) => ({ type, network: options.network, card: options.card, acceptLoss: options["accept-loss"] === true }),
  },
  "wallet faucet": {
    method: "wallet.faucet", usage: "wallet faucet <type> [--card <id>]", summary: "Test coins from a Testnet wallet's faucet",
    args: ["type"], options: { card }, params: ({ options }, { type }) => ({ type, network: "testnet", card: options.card }),
  },
  "wallet history": {
    method: "wallet.history", usage: "wallet history [--network testnet] [--limit n]", summary: "A network's wallet history, newest first",
    options: { network: net, limit: { type: "number", description: "Entries (default 50)" } }, params: ({ options }) => ({ network: options.network, limit: options.limit }),
  },
  "wallet receive": {
    method: "wallet.receive", usage: "wallet receive <sats> [--network testnet] [--card <id>]", summary: "A Lightning invoice to be paid",
    args: ["amount"], options: { network: net, card }, params: ({ options }, { amount }) => ({ amount: sats(amount), network: options.network, card: options.card }),
  },
  "wallet address": {
    method: "wallet.address", usage: "wallet address <bitcoin|arkade|spark|usdt> [--network testnet]", summary: "An address to be paid on",
    args: ["type"], options: { network: net }, params: ({ options }, { type }) => ({ type, network: options.network }),
  },
  "wallet redeem": { method: "wallet.redeem", usage: "wallet redeem <cashu-token>", summary: "Take the ecash of a Cashu token (its mint must be one of yours)", args: ["token"], params: (_, { token }) => ({ token }) },
  "wallet add-mint": {
    method: "wallet.mint.add", usage: "wallet add-mint <url> [--primary]", summary: "Add a Cashu mint (a local or test mint is Testnet's)",
    args: ["url"], options: { primary: { type: "boolean", description: "Make it the one invoices are created at" } }, params: ({ options }, { url }) => ({ url, primary: options.primary === true }),
  },
  "lightning default": { method: "lightning.default", usage: "lightning default <card> [--network testnet]", summary: "The Lightning card that receives by default", args: ["card"], options: { network: net }, params: ({ options }, { card: c }) => ({ card: c, network: options.network }) },
  "lightning rename": { method: "lightning.rename", usage: "lightning rename <card> <name...> [--network testnet]", summary: "Name a Lightning card", args: ["card", "name..."], options: { network: net }, params: ({ options }, a) => ({ card: a.card, name: a.name, network: options.network }) },
  "pay": {
    method: "pay", usage: "pay <invoice|lightning-address|lnurl> [--amount sats] [--network n] [--max-fee sats] [--card <id>] [--comment t] [--confirm-real]", summary: "Pay over Lightning from Testnet, or --network mainnet with --confirm-real",
    args: ["target"], options: { amount: { type: "number", description: "Sats, for an address or LNURL" }, network: net, "max-fee": { type: "number", description: "Refuse a fee above this" }, card, comment: { type: "string", description: "For the address's owner" }, "confirm-real": confirmReal },
    params: ({ options }, { target }) => ({ target, amount: options.amount, network: options.network, maxFee: options["max-fee"], card: options.card, comment: options.comment, confirmReal: options["confirm-real"] === true }),
  },
  "chat pay": {
    method: "chat.pay", usage: "chat pay <chat> <sats> [--memo t] [--network testnet] [--confirm-real]", summary: "Send ecash to a contact (Mainnet needs --confirm-real)",
    args: ["chat", "amount"], options: { memo, network: net, "confirm-real": confirmReal },
    params: ({ options }, a) => ({ chat: a.chat, amount: sats(a.amount), memo: options.memo, network: options.network, confirmReal: options["confirm-real"] === true }),
  },
  "chat request": {
    method: "chat.request", usage: "chat request <chat> <sats> [--memo t] [--method m] [--rail cashu|lightning] [--network testnet] [--card <id>]", summary: "Ask a contact to pay",
    args: ["chat", "amount"], options: { memo, method: { type: "string", description: "cashu, arkade, usdt, bitcoin, spark, …" }, rail: { type: "string", description: "cashu or lightning" }, network: net, card },
    params: ({ options }, a) => ({ chat: a.chat, amount: sats(a.amount), memo: options.memo, method: options.method, rail: options.rail, network: options.network, card: options.card }),
  },
  "chat pay-request": {
    method: "chat.payRequest", usage: "chat pay-request <chat> <payment> [--via lightning] [--max-fee sats] [--card <id>] [--confirm-real]", summary: "Pay a contact's request",
    args: ["chat", "payment"], options: { via: { type: "string", description: "lightning: pay its invoice instead of ecash" }, "max-fee": { type: "number", description: "Refuse a fee above this" }, card, "confirm-real": confirmReal },
    params: ({ options }, a) => ({ chat: a.chat, payment: a.payment, via: options.via, maxFee: options["max-fee"], card: options.card, confirmReal: options["confirm-real"] === true }),
  },
  "chat accept": {
    method: "chat.accept", usage: "chat accept <chat> <method> [--off] [--networks mainnet,testnet]", summary: "Which ways of paying a chat takes",
    args: ["chat", "method"], options: { off: { type: "boolean", description: "Stop taking it" }, networks: { type: "string", description: "Comma-separated networks it is taken on" } },
    params: ({ options }, a) => ({ chat: a.chat, method: a.method, on: options.off !== true, networks: typeof options.networks === "string" ? options.networks.split(",").map((n) => n.trim()).filter(Boolean) : undefined }),
  },
  "payment list": { method: "payment.list", usage: "payment list [--chat <chat>]", summary: "Payments and requests, newest first", options: { chat: { type: "string", description: "Only this chat's" } }, params: ({ options }) => ({ chat: options.chat }) },
  "payment check": { method: "payment.check", usage: "payment check <chat> <payment>", summary: "Paid from another wallet: the contact's app looks now", args: ["chat", "payment"], params: (_, a) => ({ chat: a.chat, payment: a.payment }) },
  "payment reclaim": { method: "payment.reclaim", usage: "payment reclaim <payment>", summary: "Take back ecash the contact has not taken", args: ["payment"], params: (_, a) => ({ payment: a.payment }) },

  "file send": {
    method: "file.send", usage: "file send <chat> <path> [--name n] [--mime t] [--voice <ms> [--peaks 0,40,…]]", summary: "Send a file (or, with --voice, a voice note)",
    args: ["chat", "path"], options: { name: { type: "string", description: "The name the contact sees" }, mime: { type: "string", description: "Its type (default: from the extension)" }, voice: { type: "number", description: "A voice note of this many milliseconds" }, peaks: { type: "string", description: "Loudness bars 0-255, comma-separated" } },
    params: ({ options }, a) => ({ chat: a.chat, path: here(a.path), name: options.name, mime: options.mime, voice: options.voice, peaks: typeof options.peaks === "string" ? options.peaks.split(",") : undefined }),
  },
  "file list": { method: "file.list", usage: "file list <chat>", summary: "A chat's files and their transfers", args: ["chat"], params: (_, { chat }) => ({ chat }) },
  "file accept": { method: "file.action", usage: "file accept <chat> <file>", summary: "Take a file the contact offers", args: ["chat", "file"], params: (_, a) => ({ chat: a.chat, file: a.file, action: "accept" }) },
  "file decline": { method: "file.action", usage: "file decline <chat> <file>", summary: "Refuse a file the contact offers", args: ["chat", "file"], params: (_, a) => ({ chat: a.chat, file: a.file, action: "decline" }) },
  "file pause": { method: "file.action", usage: "file pause <chat> <file>", summary: "Pause a transfer", args: ["chat", "file"], params: (_, a) => ({ chat: a.chat, file: a.file, action: "pause" }) },
  "file resume": { method: "file.action", usage: "file resume <chat> <file>", summary: "Resume a transfer", args: ["chat", "file"], params: (_, a) => ({ chat: a.chat, file: a.file, action: "resume" }) },
  "file cancel": { method: "file.action", usage: "file cancel <chat> <file>", summary: "Cancel a transfer", args: ["chat", "file"], params: (_, a) => ({ chat: a.chat, file: a.file, action: "cancel" }) },
  "file save": {
    method: "file.save", usage: "file save <file> [--dir d | --path p] [--force]", summary: "Write a received file to disk (never over a file without --force)",
    args: ["file"], options: { dir: { type: "string", description: "Into this folder, under its own name" }, path: { type: "string", description: "To this path" }, force: { type: "boolean", description: "Replace a file there" } },
    params: ({ options }, a) => ({ file: a.file, dir: here(options.dir ?? "."), path: options.path === undefined ? undefined : here(options.path), force: options.force === true }),
  },

  "group invite": { method: "group.invite", usage: "group invite <group> <chat>", summary: "Invite a contact into a group you administer", args: ["group", "chat"], params: (_, a) => ({ group: a.group, chat: a.chat }) },
  "group remove": { method: "group.remove", usage: "group remove <group> <member>", summary: "Remove a member (admin)", args: ["group", "member"], params: (_, a) => ({ group: a.group, member: a.member }) },
  "group admin": { method: "group.admin", usage: "group admin <group> <member>", summary: "Make a member the admin (admin)", args: ["group", "member"], params: (_, a) => ({ group: a.group, member: a.member }) },
  "group rotate": { method: "group.rotate", usage: "group rotate <group>", summary: "A fresh group secret, members unchanged (admin)", args: ["group"], params: (_, a) => ({ group: a.group }) },
  "group link": {
    method: "group.link", usage: "group link <group> [--off] [--reset]", summary: "Turn the group's link on (--reset: a new one), or --off", args: ["group"],
    options: { off: { type: "boolean", description: "Turn the link off" }, reset: { type: "boolean", description: "Replace it: the old link stops working" } },
    params: ({ options }, a) => ({ group: a.group, on: options.off !== true, reset: options.reset === true }),
  },
  "group picture": {
    method: "group.picture", usage: "group picture <group> <jpeg> | --clear", summary: "Set or clear the group's picture (admin; a square JPEG)", args: ["group", "path..."],
    options: { clear: { type: "boolean", description: "Remove the picture" } },
    params: ({ options }, a) => ({ group: a.group, path: here(a.path), clear: options.clear === true }),
  },
  "profile picture": {
    method: "profile.picture", usage: "profile picture <jpeg> | --clear", summary: "The picture contacts see (a square JPEG, 128 px is what the app sends)", args: ["path..."],
    options: { clear: { type: "boolean", description: "Remove the picture" } },
    params: ({ options }, a) => ({ path: here(a.path), clear: options.clear === true }),
  },

  "identity providers": { method: "identity.providers", usage: "identity providers", summary: "Kinds of identity proof, and which signers work here" },
  "identity list": { method: "identity.list", usage: "identity list", summary: "This profile's identity proofs" },
  "identity complete": {
    method: "identity.complete", usage: "identity complete <draft> [--evidence-file f | --stdin]", summary: "Finish a proof: what the tool printed, or nothing for a published record",
    args: ["draft"], options: { "evidence-file": { type: "string", description: "The tool's output, from this file" }, stdin: { type: "boolean", description: "The tool's output, from stdin" } },
    params: ({ options }, a) => ({ draft: a.draft, evidenceFile: here(options["evidence-file"]), stdin: options.stdin === true }),
  },
  "identity cancel": { method: "identity.cancel", usage: "identity cancel <draft>", summary: "Drop a proof not finished", args: ["draft"], params: (_, a) => ({ draft: a.draft }) },
  "identity remove": { method: "identity.remove", usage: "identity remove <id>", summary: "Remove a proof: withdrawn from every chat, revoked", args: ["id"], params: (_, a) => ({ id: a.id }) },
  "identity share": { method: "identity.share", usage: "identity share <chat> <id>", summary: "Show a proof to a contact", args: ["chat", "id"], params: (_, a) => ({ chat: a.chat, id: a.id }) },
  "identity withdraw": { method: "identity.withdraw", usage: "identity withdraw <chat> <id>", summary: "Withdraw a proof from a contact", args: ["chat", "id"], params: (_, a) => ({ chat: a.chat, id: a.id }) },
  "identity contact": { method: "identity.contact", usage: "identity contact <chat>", summary: "What a contact shared, as this device checked it", args: ["chat"], params: (_, a) => ({ chat: a.chat }) },
  "identity recheck": { method: "identity.recheck", usage: "identity recheck <chat> <id>", summary: "Check a contact's proof again", args: ["chat", "id"], params: (_, a) => ({ chat: a.chat, id: a.id }) },

  "service list": { method: "service.list", usage: "service list", summary: "Web apps this profile shares" },
  "service add": { method: "service.add", usage: "service add <name> <http://127.0.0.1:port>", summary: "A web app on this machine that contacts may be given", args: ["name", "target"], params: (_, a) => ({ name: a.name, target: a.target }) },
  "service remove": { method: "service.remove", usage: "service remove <service>", summary: "Stop sharing a web app with anyone", args: ["service"], params: (_, a) => ({ service: a.service }) },
  "service enable": { method: "service.enable", usage: "service enable <service> [--off]", summary: "Turn a shared app on or off", args: ["service"], options: { off: { type: "boolean", description: "Turn it off" } }, params: ({ options }, a) => ({ service: a.service, off: options.off === true }) },
  "service share": { method: "service.share", usage: "service share <service> <chat> [--off]", summary: "Give (or take back) a contact access to a web app", args: ["service", "chat"], options: { off: { type: "boolean", description: "Take it back" } }, params: ({ options }, a) => ({ service: a.service, chat: a.chat, off: options.off === true }) },
  "service peer": { method: "service.peer", usage: "service peer <chat>", summary: "What a contact shares with you", args: ["chat"], params: (_, a) => ({ chat: a.chat }) },
  "service open": { method: "service.open", usage: "service open <chat> <service> [--port p]", summary: "A contact's app on a loopback port here (daemon)", args: ["chat", "service"], options: { port: { type: "number", description: "Local port (default: any free one)" } }, params: ({ options }, a) => ({ chat: a.chat, service: a.service, port: options.port }) },
  "service close": { method: "service.close", usage: "service close <chat> <service>", summary: "Close a contact's app opened here", args: ["chat", "service"], params: (_, a) => ({ chat: a.chat, service: a.service }) },

  "events": {
    method: "events.replay", usage: "events [--since seq]", summary: "Events the journal holds, without following",
    options: { since: { type: "number", description: "Only events after this seq" } }, params: ({ options }) => ({ since: options.since ?? 0 }),
  },
};

/** Commands that take text (argument or stdin), with the secret guard and delivery waits. */
export const TEXT_COMMANDS: Record<string, { method: string; target: "chat" | "group"; usage: string; summary: string; options: Record<string, OptionSpec> }> = {
  "send": {
    method: "chat.send", target: "chat", usage: "send <chat> [text...] [--reply <message>] [--stdin] [--force] [--wait none|sent|delivered]", summary: "Send a message (text from arguments or stdin)",
    options: { stdin: { type: "boolean", description: "Read the text from stdin" }, force, reply, ...wait },
  },
  "group send": {
    method: "group.send", target: "group", usage: "group send <group> [text...] [--mention <member>]... [--reply <message>] [--stdin] [--force]", summary: "Send to a group; mention members written as @name in the text",
    options: { stdin: { type: "boolean", description: "Read the text from stdin" }, force, reply, mention: { type: "list", description: "A member (key, key prefix, name or everyone) named as @name in the text" } },
  },
};

/** A history cursor: a timestamp when it is all digits, else a message id. */
function cursor(value: unknown): string | number | undefined {
  if (value === undefined) return undefined;
  const text = String(value);
  return /^\d{10,}$/.test(text) ? Number(text) : text;
}

/** The positionals of a command, by name; missing required ones are a usage error. */
export function positionals(command: { usage: string; args?: string[] }, values: readonly string[]): Record<string, string | undefined> {
  const names = command.args ?? [];
  const out: Record<string, string | undefined> = {};
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (name.endsWith("...")) { const rest = values.slice(i); out[name.slice(0, -3)] = rest.length ? rest.join(" ") : undefined; return out; }
    if (values[i] === undefined) throw new CliError("usage", `Missing <${name}>: ghostly ${command.usage}`);
    out[name] = values[i];
  }
  if (values.length > names.length) throw new CliError("usage", `Too many arguments: ghostly ${command.usage}`);
  return out;
}
