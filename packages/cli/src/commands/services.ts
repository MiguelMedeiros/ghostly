import { type Command } from "./shared";

/** Shared local services: one entry per command, in alphabetical order (test/commands.test.ts checks). */
export const commands: Record<string, Command> = {
  "service add": { method: "service.add", usage: "service add <name> <http://127.0.0.1:port>", summary: "A web app on this machine that contacts may be given", args: ["name", "target"], params: (_, a) => ({ name: a.name, target: a.target }) },
  "service close": { method: "service.close", usage: "service close <chat> <service>", summary: "Close a contact's app opened here", args: ["chat", "service"], params: (_, a) => ({ chat: a.chat, service: a.service }) },
  "service enable": { method: "service.enable", usage: "service enable <service> [--off]", summary: "Turn a shared app on or off", args: ["service"], options: { off: { type: "boolean", description: "Turn it off" } }, params: ({ options }, a) => ({ service: a.service, off: options.off === true }) },
  "service list": { method: "service.list", usage: "service list", summary: "Web apps this profile shares" },
  "service open": { method: "service.open", usage: "service open <chat> <service> [--port p]", summary: "A contact's app on a loopback port here (daemon)", args: ["chat", "service"], options: { port: { type: "number", description: "Local port (default: any free one)" } }, params: ({ options }, a) => ({ chat: a.chat, service: a.service, port: options.port }) },
  "service peer": { method: "service.peer", usage: "service peer <chat>", summary: "What a contact shares with you", args: ["chat"], params: (_, a) => ({ chat: a.chat }) },
  "service remove": { method: "service.remove", usage: "service remove <service>", summary: "Stop sharing a web app with anyone", args: ["service"], params: (_, a) => ({ service: a.service }) },
  "service share": { method: "service.share", usage: "service share <service> <chat> [--off]", summary: "Give (or take back) a contact access to a web app", args: ["service", "chat"], options: { off: { type: "boolean", description: "Take it back" } }, params: ({ options }, a) => ({ service: a.service, chat: a.chat, off: options.off === true }) },
};
