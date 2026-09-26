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
const force: OptionSpec = { type: "boolean", description: "Send even if the text looks like a seed, a key or ecash" };

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

  "events": {
    method: "events.replay", usage: "events [--since seq]", summary: "Events the journal holds, without following",
    options: { since: { type: "number", description: "Only events after this seq" } }, params: ({ options }) => ({ since: options.since ?? 0 }),
  },
};

/** Commands that take text (argument or stdin), with the secret guard and delivery waits. */
export const TEXT_COMMANDS: Record<string, { method: string; target: "chat" | "group"; usage: string; summary: string; options: Record<string, OptionSpec> }> = {
  "send": {
    method: "chat.send", target: "chat", usage: "send <chat> [text...] [--stdin] [--force] [--wait none|sent|delivered]", summary: "Send a message (text from arguments or stdin)",
    options: { stdin: { type: "boolean", description: "Read the text from stdin" }, force, ...wait },
  },
  "group send": {
    method: "group.send", target: "group", usage: "group send <group> [text...] [--mention <member>]... [--stdin] [--force]", summary: "Send to a group; mention members written as @name in the text",
    options: { stdin: { type: "boolean", description: "Read the text from stdin" }, force, mention: { type: "list", description: "A member (key, key prefix, name or everyone) named as @name in the text" } },
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
