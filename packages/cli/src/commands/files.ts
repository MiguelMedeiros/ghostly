import { type Command, here, reply } from "./shared";

/** Files: one entry per command, in alphabetical order (test/commands.test.ts checks). */
export const commands: Record<string, Command> = {
  "file accept": { method: "file.action", usage: "file accept [<chat>] <file>", summary: "Take a file the contact offers", args: ["chat?", "file"], params: (_, a) => ({ chat: a.chat, file: a.file, action: "accept" }) },
  "file cancel": { method: "file.action", usage: "file cancel [<chat>] <file>", summary: "Cancel a transfer", args: ["chat?", "file"], params: (_, a) => ({ chat: a.chat, file: a.file, action: "cancel" }) },
  "file decline": { method: "file.action", usage: "file decline [<chat>] <file>", summary: "Refuse a file the contact offers", args: ["chat?", "file"], params: (_, a) => ({ chat: a.chat, file: a.file, action: "decline" }) },
  "file list": { method: "file.list", usage: "file list <chat>", summary: "A chat's files and their transfers", args: ["chat"], params: (_, { chat }) => ({ chat }) },
  "file pause": { method: "file.action", usage: "file pause [<chat>] <file>", summary: "Pause a transfer", args: ["chat?", "file"], params: (_, a) => ({ chat: a.chat, file: a.file, action: "pause" }) },
  "file request": { method: "file.action", usage: "file request [<chat>] <file>", summary: "Ask again for a file that stopped arriving: it goes on from what is here", args: ["chat?", "file"], params: (_, a) => ({ chat: a.chat, file: a.file, action: "request" }) },
  "file resend": { method: "file.action", usage: "file resend [<chat>] <file>", summary: "Send again a file that stopped moving or failed: it goes on from what the contact holds", args: ["chat?", "file"], params: (_, a) => ({ chat: a.chat, file: a.file, action: "resend" }) },
  "file resume": { method: "file.action", usage: "file resume [<chat>] <file>", summary: "Resume a transfer", args: ["chat?", "file"], params: (_, a) => ({ chat: a.chat, file: a.file, action: "resume" }) },
  "file save": {
    method: "file.save", usage: "file save [<chat>] <file> [--dir d | --path p] [--force] [--wait [--timeout s]]", summary: "Write a received file to disk (never over a file without --force; --wait: once it is all here)",
    args: ["chat?", "file"],
    options: {
      dir: { type: "string", description: "Into this folder, under its own name" }, path: { type: "string", description: "To this path" }, force: { type: "boolean", description: "Replace a file there" },
      wait: { type: "boolean", description: "Wait for the transfer to finish first" }, timeout: { type: "number", description: "Seconds --wait waits (default 300)" },
    },
    params: ({ options }, a) => ({
      chat: a.chat, file: a.file, dir: here(options.dir ?? "."), path: options.path === undefined ? undefined : here(options.path), force: options.force === true,
      wait: options.wait === true ? true : undefined, timeout: options.timeout,
    }),
  },
  "file send": {
    method: "file.send", usage: "file send <chat> <path> [--name n] [--mime t] [--voice [ms] [--peaks 0,40,…]] [--reply <message>]", summary: "Send a file (or, with --voice, a voice note), as a reply with --reply",
    args: ["chat", "path"], options: { name: { type: "string", description: "The name the contact sees" }, mime: { type: "string", description: "Its type (default: from the extension)" }, voice: { type: "number", optionalValue: true, description: "A voice note; its length in milliseconds (default: measured from the sound)" }, peaks: { type: "string", description: "Loudness bars 0-255, comma-separated (default: measured from the sound)" }, reply },
    params: ({ options }, a) => ({ chat: a.chat, path: here(a.path), name: options.name, mime: options.mime, voice: options.voice, peaks: typeof options.peaks === "string" ? options.peaks.split(",") : undefined, reply: options.reply }),
  },
  "file wait": {
    method: "file.wait", usage: "file wait [<chat>] <file> [--timeout s]", summary: "Wait until a transfer is done (exit 0) or failed (exit 1, with its error)",
    args: ["chat?", "file"], options: { timeout: { type: "number", description: "Seconds (default 300)" } },
    params: ({ options }, a) => ({ chat: a.chat, file: a.file, timeout: options.timeout }),
  },
};
