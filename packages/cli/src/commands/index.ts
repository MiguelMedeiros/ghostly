import { CliError } from "../errors";
import { commands as calls } from "./calls";
import { commands as chats } from "./chats";
import { commands as files } from "./files";
import { commands as general } from "./general";
import { commands as groups } from "./groups";
import { commands as identities } from "./identities";
import { commands as payments } from "./payments";
import { commands as services } from "./services";
import { type Command, wait, groupWait, force, reply, buttonOptions } from "./shared";
import type { OptionSpec } from "../args";

export type { Command };

/**
 * The commands that are one API method each, one file per area of the app, each in alphabetical order. A new
 * command goes in its area's file at its place; a new area is a new file and its two lines here. The order here
 * is the order `ghostly help` lists them in.
 */
export const COMMANDS: Record<string, Command> = {
  ...general,
  ...chats,
  ...groups,
  ...files,
  ...payments,
  ...identities,
  ...services,
  ...calls,
};

/** Commands that take text (argument or stdin), with the secret guard and delivery waits. */
export const TEXT_COMMANDS: Record<string, { method: string; target: "chat" | "group"; message?: true; usage: string; summary: string; args: string[]; options: Record<string, OptionSpec> }> = {
  "send": {
    method: "chat.send", target: "chat", args: ["chat", "text..."], usage: "send <chat> [text...] [--reply <message>] [--button id:Label]... [--style id=primary|neutral|danger]... [--once] [--id id] [--stdin] [--force] [--wait none|sent|delivered]", summary: "Send a message (text from arguments or stdin); --button puts buttons under it",
    options: { stdin: { type: "boolean", description: "Read the text from stdin" }, force, reply, ...buttonOptions, ...wait },
  },
  "edit": {
    method: "chat.edit", target: "chat", message: true, args: ["chat", "message", "text..."], usage: "edit <chat> <message> [text... | --text <text> | --stdin] [--force] [--wait none|confirmed]", summary: "Replace the text of a message you sent (the id send gave; in a group, group edit)",
    options: { stdin: { type: "boolean", description: "Read the new text from stdin" }, text: { type: "string", description: "The new text, as one argument" }, force, wait: { type: "string", description: "none or confirmed (default: none with a daemon, confirmed without)" }, timeout: wait.timeout },
  },
  "group send": {
    method: "group.send", target: "group", args: ["group", "text..."], usage: "group send <group> [text...] [--mention <member>]... [--reply <message>] [--button id:Label]... [--style id=primary|neutral|danger]... [--once] [--id id] [--stdin] [--force] [--wait none|sent] [--timeout s]", summary: "Send to a group; mention members written as @name in the text; --button puts buttons under it",
    options: { stdin: { type: "boolean", description: "Read the text from stdin" }, force, reply, mention: { type: "list", description: "A member (key, key prefix, name or everyone) named as @name in the text" }, ...buttonOptions, ...groupWait },
  },
  "group edit": {
    method: "group.edit", target: "group", message: true, args: ["group", "message", "text..."], usage: "group edit <group> <message> [text... | --text <text> | --stdin] [--mention <member>]... [--force] [--wait none|sent] [--timeout s]", summary: "Replace the text of a message you sent to a group (the id group send gave)",
    options: { stdin: { type: "boolean", description: "Read the new text from stdin" }, text: { type: "string", description: "The new text, as one argument" }, force, mention: { type: "list", description: "A member newly named as @name in the text (those the message named stay)" }, ...groupWait },
  },
};


/**
 * Positionals that name something by its id (a chat or a group also by a prefix or its name). The ids are the
 * engine's and the contacts', and drafts, payments and groups are base64url, which starts with `-` one time in 64:
 * in these a word that starts with a dash is the value. A mistyped flag there names nothing and fails as not found;
 * text, names and paths stay strict.
 */
const ID_ARGS = new Set(["chat", "message", "group", "member", "payment", "file", "draft", "id", "card", "service", "call"]);

/**
 * Which of a command's positionals take an id, by index (a trailing `...` one covers the rest). An optional `name?`
 * shifts the others, so it counts only where it and what may come in its place are all ids.
 */
export function idSlot(command: { args?: string[] }): (index: number) => boolean {
  const names = (command.args ?? []).map((name) => name.replace(/\?$/, ""));
  const shift = (command.args ?? []).filter((name) => name.endsWith("?")).length;
  const rest = names.findIndex((name) => name.endsWith("..."));
  const at = (index: number) => {
    const name = rest !== -1 && index >= rest ? names[rest].slice(0, -3) : names[index];
    return name !== undefined && ID_ARGS.has(name);
  };
  return (index) => at(index) && (shift === 0 || index + shift >= names.length || at(index + shift));
}

/**
 * The positionals of a command, by name; missing required ones are a usage error. A leading `name?` is optional: it
 * is given only when every required one is there too (`file accept [<chat>] <file>`).
 */
export function positionals(command: { usage: string; args?: string[] }, values: readonly string[]): Record<string, string | undefined> {
  let names = command.args ?? [];
  const optional = names.filter((name) => name.endsWith("?"));
  if (optional.length) {
    const skip = Math.max(0, optional.length - Math.max(0, values.length - (names.length - optional.length)));
    names = [...optional.slice(skip).map((name) => name.slice(0, -1)), ...names.filter((name) => !name.endsWith("?"))];
  }
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
