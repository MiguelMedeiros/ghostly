import { CliError } from "../errors";
import { type Command, rate, refs } from "./shared";

/** Voice calls: one entry per command, in alphabetical order (test/commands.test.ts checks). */
export const commands: Record<string, Command> = {
  "call answer": {
    method: "call.answer", usage: "call answer [<chat|call>] [--rate 48000]", summary: "Answer a call that rings (the only one, or the one named)",
    args: ["call...?"], options: { rate: rate }, params: ({ options }, a) => ({ call: a.call, rate: options.rate }),
  },
  "call auto": {
    method: "call.auto", usage: "call auto [on|off] [--from <chat>]... [--rate 48000]", summary: "Answer calls by themselves: from anyone, or the chats named (kept in the profile)",
    args: ["mode...?"], options: { from: { type: "list", description: "Only calls from this chat (again for more)" }, rate: rate },
    params: ({ options }, a) => {
      if (a.mode !== undefined && a.mode !== "on" && a.mode !== "off") throw new CliError("usage", "ghostly call auto [on|off] [--from <chat>]... [--rate n]");
      // Without `on` the chats and the rate would be dropped without a word.
      if (a.mode !== "on" && (options.from !== undefined || options.rate !== undefined)) throw new CliError("usage", "--from and --rate go with on: ghostly call auto on --from <chat>");
      refs(options.from, "from", "chat");
      if (a.mode === undefined) return {};
      return a.mode === "on" ? { on: true, from: options.from, rate: options.rate } : { on: false };
    },
  },
  "call flush": { method: "call.flush", usage: "call flush [<chat|call>]", summary: "Drop the audio queued and not played yet (barge-in)", args: ["call...?"], params: (_, a) => ({ call: a.call }) },
  "call hangup": { method: "call.hangup", usage: "call hangup [<chat|call>]", summary: "Hang up, or decline a call that rings", args: ["call...?"], params: (_, a) => ({ call: a.call }) },
  "call list": { method: "call.list", usage: "call list", summary: "Calls on now, their audio sockets, and auto-answer" },
  "call start": {
    method: "call.start", usage: "call start <chat> [--rate 48000]", summary: "Call a contact (voice); the result names the call's audio socket (daemon)",
    args: ["chat"], options: { rate: rate }, params: ({ options }, a) => ({ chat: a.chat, rate: options.rate }),
  },
};
