import { CliError } from "../errors";
import { type Command, here, showSecret, secret, cursor, typingFor } from "./shared";

/** Groups: one entry per command, in alphabetical order (test/commands.test.ts checks). */
export const commands: Record<string, Command> = {
  "group accept": { method: "group.accept", usage: "group accept <group>", summary: "Accept an invitation to a group", args: ["group"], params: (_, { group }) => ({ group }) },
  "group admin": {
    method: "group.admin", usage: "group admin <group> <member> [--show-secret]", summary: "Make a member the admin (admin)", args: ["group", "member"],
    options: showSecret, params: ({ options }, a) => ({ group: a.group, member: a.member, ...secret(options) }),
  },
  "group create": {
    method: "group.create", usage: "group create <name...> [--mesh]", summary: "A community (a link anyone can open) or, with --mesh, a private group of up to 32",
    args: ["name..."], options: { mesh: { type: "boolean", description: "A private mesh of contacts instead of a community" } },
    params: ({ options }, { name }) => ({ name, profile: options.mesh ? "mesh" : "community" }),
  },
  "group decline": { method: "group.decline", usage: "group decline <group>", summary: "Decline an invitation to a group", args: ["group"], params: (_, { group }) => ({ group }) },
  "group forget": {
    method: "group.forget", usage: "group forget <group> --yes", summary: "Leave and delete a group's history here", args: ["group"],
    options: { yes: { type: "boolean", description: "Confirm" } }, params: ({ options }, { group }) => ({ group, yes: options.yes === true }),
  },
  "group history": {
    method: "group.history", usage: "group history <group> [--limit n] [--before id|ms] [--after id|ms]", summary: "A group's messages (a page)", args: ["group"],
    options: { limit: { type: "number", description: "Messages per page (default 50)" }, before: { type: "string", description: "Only before this message id or timestamp" }, after: { type: "string", description: "Only after this message id or timestamp" } },
    params: ({ options }, { group }) => ({ group, limit: options.limit, before: cursor(options.before, "before"), after: cursor(options.after, "after") }),
  },
  "group hub": {
    method: "group.hub", usage: "group hub <group> <member> [--pin | --exclude | --auto] [--show-secret]",
    summary: "Pin a member as a hub of a private group past 16 members, exclude one, or leave it to their app (admin)", args: ["group", "member"],
    options: { ...showSecret, pin: { type: "boolean", description: "Always a hub while online" }, exclude: { type: "boolean", description: "Never a hub" }, auto: { type: "boolean", description: "A hub if their app stays online (the default)" } },
    params: ({ options }, a) => {
      const roles = (["pin", "exclude", "auto"] as const).filter((role) => options[role] === true);
      if (roles.length > 1) throw new CliError("usage", "--pin, --exclude or --auto: one of them");
      return { group: a.group, member: a.member, role: roles[0] ?? "auto", ...secret(options) };
    },
  },
  "group invite": {
    method: "group.invite", usage: "group invite <group> <chat> [--show-secret]", summary: "Invite a contact into a group you administer", args: ["group", "chat"],
    options: showSecret, params: ({ options }, a) => ({ group: a.group, chat: a.chat, ...secret(options) }),
  },
  "group join": { method: "group.join", usage: "group join <link>", summary: "Join a group by its link", args: ["link"], params: (_, { link }) => ({ link }) },
  "group leave": {
    method: "group.leave", usage: "group leave <group> --yes", summary: "Leave a group; its history and files go from this device", args: ["group"],
    options: { yes: { type: "boolean", description: "Confirm" } }, params: ({ options }, { group }) => ({ group, yes: options.yes === true }),
  },
  "group link": {
    method: "group.link", usage: "group link <group> [--off] [--reset]", summary: "Turn the group's link on (--reset: a new one), or --off", args: ["group"],
    options: { off: { type: "boolean", description: "Turn the link off" }, reset: { type: "boolean", description: "Replace it: the old link stops working" } },
    params: ({ options }, a) => {
      if (options.off === true && options.reset === true) throw new CliError("usage", "--off turns the link off: not with --reset");
      return { group: a.group, on: options.off !== true, reset: options.reset === true };
    },
  },
  "group list": { method: "group.list", usage: "group list [--show-secret]", summary: "Groups and invitations", options: showSecret, params: ({ options }) => secret(options) },
  "group picture": {
    method: "group.picture", usage: "group picture <group> <jpeg> | --clear", summary: "Set or clear the group's picture (admin; a square JPEG)", args: ["group", "path...?"],
    options: { clear: { type: "boolean", description: "Remove the picture" } },
    params: ({ options }, a) => {
      if (!a.path && options.clear !== true) throw new CliError("usage", "Missing <jpeg>: ghostly group picture <group> <jpeg> | --clear");
      if (a.path && options.clear === true) throw new CliError("usage", "--clear removes the picture: not with a <jpeg>");
      return { group: a.group, path: here(a.path || undefined), clear: options.clear === true };
    },
  },
  "group react": {
    method: "group.react", usage: "group react <group> <message> <emoji> [--remove]", summary: "React to a group's message with one emoji; --remove takes yours back",
    args: ["group", "message", "emoji...?"], options: { remove: { type: "boolean", description: "Take your reaction back" } },
    params: ({ options }, a) => ({ group: a.group, message: a.message, emoji: a.emoji, remove: options.remove === true }),
  },
  "group remove": {
    method: "group.remove", usage: "group remove <group> <member> [--show-secret]", summary: "Remove a member (admin)", args: ["group", "member"],
    options: showSecret, params: ({ options }, a) => ({ group: a.group, member: a.member, ...secret(options) }),
  },
  "group rename": {
    method: "group.rename", usage: "group rename <group> <name...> [--show-secret]", summary: "Rename the group (admin; the picture stays)", args: ["group", "name..."],
    options: showSecret, params: ({ options }, a) => ({ group: a.group, name: a.name, ...secret(options) }),
  },
  "group rotate": {
    method: "group.rotate", usage: "group rotate <group> [--show-secret]", summary: "A fresh group secret, members unchanged (admin)", args: ["group"],
    options: showSecret, params: ({ options }, a) => ({ group: a.group, ...secret(options) }),
  },
  "group show": {
    method: "group.get", usage: "group show <group> [--show-secret]", summary: "A group and its members (its entry link only with --show-secret)", args: ["group"],
    options: showSecret, params: ({ options }, { group }) => ({ group, ...secret(options) }),
  },
  "group typing": {
    method: "group.typing", usage: "group typing <group> [--kind typing|recording|thinking] [--status \"<text>\"] [--for s] [--stop]",
    summary: "Show the members you are writing, recording or thinking (private groups; it fades after 6 s unless said again, or kept with --for; a send or --stop ends it)", args: ["group"],
    options: {
      stop: { type: "boolean", description: "Say you stopped" },
      kind: { type: "string", description: "typing (default), recording (a voice note) or thinking" },
      status: { type: "string", description: "A short line shown instead, e.g. \"Reading the thread…\" (40 characters, no links)" },
      for: { type: "number", description: "Keep saying it for this many seconds (up to 600), until a send or --stop" },
    },
    params: ({ options }, { group }) => ({ group, stop: options.stop === true, kind: options.kind, status: options.status, for: typingFor(options) }),
  },
};
