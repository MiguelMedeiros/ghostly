import { GROUP_FILE_LIMITS } from "@ghostly/core/groupFiles";
import { VOICE_LIMITS } from "@ghostly/core/voice";
import type { Parsed } from "../args";
import { CliError } from "../errors";
import { type Command, here, reply } from "./shared";

/**
 * `--voice [ms]` and `--peaks`: a length and a waveform a voice note takes, or a usage error (exit 2) that names the flag
 * before the profile opens. Before, the API answered them once it had opened ("voice must be a number from 1 to
 * 9007199254740991", or one sentence for every case), and `--peaks` without `--voice` was dropped without a word.
 */
function voiceOf(options: Parsed["options"]): { voice?: number | true; peaks?: string[] } {
  const { voice, peaks } = options;
  if (typeof voice === "number" && !(Number.isInteger(voice) && voice >= 1 && voice <= VOICE_LIMITS.maxDurationMs)) {
    throw new CliError("usage", `--voice takes a length in milliseconds from 1 to ${VOICE_LIMITS.maxDurationMs} (${VOICE_LIMITS.maxDurationMs / 60_000} minutes), not ${voice}`);
  }
  if (typeof peaks !== "string") return { voice: voice as number | true | undefined, peaks: undefined };
  if (voice === undefined) throw new CliError("usage", "--peaks is a voice note's waveform: not without --voice");
  const bars = peaks.split(",");
  if (bars.length > VOICE_LIMITS.maxBars || !bars.every((bar) => /^\d{1,3}$/.test(bar.trim()) && Number(bar) <= 255)) {
    throw new CliError("usage", `--peaks takes up to ${VOICE_LIMITS.maxBars} numbers from 0 to 255, comma-separated, not ${JSON.stringify(peaks)}`);
  }
  return { voice: voice as number | true, peaks: bars };
}

/** Files: one entry per command, in alphabetical order (test/commands.test.ts checks). */
export const commands: Record<string, Command> = {
  "file accept": { method: "file.action", usage: "file accept [<chat>] <file>", summary: "Take a file the contact offers, or download a group's file that did not come by itself (<chat> may be the group)", args: ["chat?", "file"], params: (_, a) => ({ chat: a.chat, file: a.file, action: "accept" }) },
  "file cancel": { method: "file.action", usage: "file cancel [<chat>] <file>", summary: "Cancel a transfer", args: ["chat?", "file"], params: (_, a) => ({ chat: a.chat, file: a.file, action: "cancel" }) },
  "file decline": { method: "file.action", usage: "file decline [<chat>] <file>", summary: "Refuse a file the contact offers", args: ["chat?", "file"], params: (_, a) => ({ chat: a.chat, file: a.file, action: "decline" }) },
  "file list": { method: "file.list", usage: "file list <chat|group>", summary: "A chat's or a group's files and their transfers", args: ["chat"], params: (_, { chat }) => ({ chat }) },
  "file pause": { method: "file.action", usage: "file pause [<chat>] <file>", summary: "Pause a transfer", args: ["chat?", "file"], params: (_, a) => ({ chat: a.chat, file: a.file, action: "pause" }) },
  "file request": { method: "file.action", usage: "file request [<chat>] <file>", summary: "Ask again for a file that stopped arriving: it goes on from what is here (a group's file: asked of whoever holds it)", args: ["chat?", "file"], params: (_, a) => ({ chat: a.chat, file: a.file, action: "request" }) },
  "file resend": { method: "file.action", usage: "file resend [<chat>] <file>", summary: "Send again a file that stopped moving or failed: it goes on from what the contact holds", args: ["chat?", "file"], params: (_, a) => ({ chat: a.chat, file: a.file, action: "resend" }) },
  "file resume": { method: "file.action", usage: "file resume [<chat>] <file>", summary: "Resume a transfer", args: ["chat?", "file"], params: (_, a) => ({ chat: a.chat, file: a.file, action: "resume" }) },
  "file save": {
    method: "file.save", usage: "file save [<chat>] <file> [--dir d | --path p] [--force] [--wait [--timeout s]]", summary: "Write a received file to disk (never over a file without --force; --wait: once it is all here)",
    args: ["chat?", "file"],
    options: {
      dir: { type: "string", description: "Into this folder, under its own name" }, path: { type: "string", description: "To this path" }, force: { type: "boolean", description: "Replace a file there" },
      wait: { type: "boolean", description: "Wait for the transfer to finish first" }, timeout: { type: "number", description: "Seconds --wait waits (default 300)" },
    },
    params: ({ options }, a) => {
      // Empty (an unset variable in a script), it was the current folder: --path "" asked to replace it.
      if (options.path === "") throw new CliError("usage", "--path needs a file");
      if (options.dir === "") throw new CliError("usage", "--dir needs a folder");
      if (options.dir !== undefined && options.path !== undefined) throw new CliError("usage", "--path names the file: not with --dir");
      if (options.timeout !== undefined && options.wait !== true) throw new CliError("usage", "--timeout is how long --wait waits: not without --wait");
      return {
        chat: a.chat, file: a.file, dir: options.path === undefined ? here(options.dir ?? ".") : undefined, path: here(options.path), force: options.force === true,
        wait: options.wait === true ? true : undefined, timeout: options.timeout,
      };
    },
  },
  "file send": {
    method: "file.send", usage: "file send <chat|group> <path> [--name n] [--mime t] [--voice [ms] [--peaks 0,40,…]] [--reply <message>]", summary: `Send a file (or, with --voice, a voice note), as a reply with --reply; to a group, every member's app fetches it (up to ${GROUP_FILE_LIMITS.maxBytes / 1024 / 1024} MiB)`,
    args: ["chat", "path"], options: { name: { type: "string", description: "The name the contact (or the group) sees" }, mime: { type: "string", description: "Its type (default: from the extension)" }, voice: { type: "number", optionalValue: true, description: "A voice note; its length in milliseconds (default: measured from the sound)" }, peaks: { type: "string", description: "Loudness bars 0-255, comma-separated (default: measured from the sound)" }, reply },
    params: ({ options }, a) => ({ chat: a.chat, path: here(a.path), name: options.name, mime: options.mime, ...voiceOf(options), reply: options.reply }),
  },
  "file wait": {
    method: "file.wait", usage: "file wait [<chat>] <file> [--timeout s]", summary: "Wait until a transfer is done (exit 0) or failed (exit 1, with its error)",
    args: ["chat?", "file"], options: { timeout: { type: "number", description: "Seconds (default 300)" } },
    params: ({ options }, a) => ({ chat: a.chat, file: a.file, timeout: options.timeout }),
  },
};
