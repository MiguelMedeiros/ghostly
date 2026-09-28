import { type Command, groupWait, cursor } from "./shared";

/** Invites, chats and messages: one entry per command, in alphabetical order (test/commands.test.ts checks). */
export const commands: Record<string, Command> = {
  "chat connect": { method: "chat.connect", usage: "chat connect <chat>", summary: "Reconnect a chat now (ends a --hold)", args: ["chat"], params: (_, { chat }) => ({ chat }) },
  "chat disconnect": {
    method: "chat.disconnect", usage: "chat disconnect <chat> [--hold <minutes>]", summary: "Close a chat's live session (the contact may redial; --hold keeps it on the DHT that long, 0 ends it)", args: ["chat"],
    options: { hold: { type: "number", description: "Stay off the direct link this many minutes (up to 10080): DHT only, taken back after" } },
    params: ({ options }, { chat }) => ({ chat, hold: options.hold }),
  },
  "chat history": {
    method: "chat.history", usage: "chat history <chat> [--limit n] [--before id|ms] [--after id|ms]", summary: "Messages, oldest first (a page)",
    args: ["chat"],
    options: { limit: { type: "number", description: "Messages per page (default 50)" }, before: { type: "string", description: "Only before this message id or timestamp" }, after: { type: "string", description: "Only after this message id or timestamp" } },
    params: ({ options }, { chat }) => ({ chat, limit: options.limit, before: cursor(options.before), after: cursor(options.after) }),
  },
  "chat list": { method: "chat.list", usage: "chat list", summary: "Chats, newest first" },
  "chat remove": {
    method: "chat.remove", usage: "chat remove <chat> --yes", summary: "Delete a chat, its keys and history on this device", args: ["chat"],
    options: { yes: { type: "boolean", description: "Confirm" } }, params: ({ options }, { chat }) => ({ chat, yes: options.yes === true }),
  },
  "chat rename": { method: "chat.rename", usage: "chat rename <chat> <name...>", summary: "Name a chat on this side (empty: the contact's name)", args: ["chat", "name..."], params: (_, { chat, name }) => ({ chat, name: name ?? "" }) },
  "chat show": { method: "chat.get", usage: "chat show <chat>", summary: "One chat and its connection", args: ["chat"], params: (_, { chat }) => ({ chat }) },
  "chat transport": { method: "chat.transport", usage: "chat transport <chat> <auto|dht|webrtc|iroh|hyperdht>", summary: "Choose what carries a chat", args: ["chat", "transport"], params: (_, a) => ({ chat: a.chat, transport: a.transport }) },
  "chat verify": {
    method: "chat.verify", usage: "chat verify <chat> --code <code>", summary: "Mark a contact verified after comparing codes", args: ["chat"],
    options: { code: { type: "string", description: "The code the contact reads out" } }, params: ({ options }, { chat }) => ({ chat, code: options.code }),
  },
  "chat wait": {
    method: "chat.wait", usage: "chat wait <chat> [--until live|text|paired] [--timeout s]", summary: "Wait for a chat to reach a state", args: ["chat"],
    options: { until: { type: "string", description: "live (default), text or paired" }, timeout: { type: "number", description: "Seconds (default 60)" } },
    params: ({ options }, { chat }) => ({ chat, until: options.until, timeout: options.timeout }),
  },
  "forward": {
    method: "chat.forward", usage: "forward <chat|group> <message>... --to <chat|group>... [--force] [--wait none|sent] [--timeout s]",
    summary: "Forward messages (texts, files from the bytes here) to up to 5 chats and groups, as new messages of yours",
    args: ["chat", "message..."],
    options: {
      to: { type: "list", description: "A chat or a group to forward to (id, prefix or name; group:<id> for a group; a dash-leading id as it is); up to 5" },
      force: { type: "boolean", description: "Forward even if a text looks like a seed, a key or ecash" },
      wait: { type: "string", description: "none or sent: each text on its way (in a group, taken by an edge), each file's transfer done (default none)" },
      timeout: groupWait.timeout,
    },
    params: ({ options }, a) => ({ chat: a.chat, messages: (a.message ?? "").split(" ").filter(Boolean), to: options.to, force: options.force === true, wait: options.wait, timeout: options.timeout }),
  },
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
  "message delete": { method: "chat.delete", usage: "message delete <chat> <message>", summary: "Forget a message on this device (the contact keeps theirs)", args: ["chat", "message"], params: (_, a) => ({ chat: a.chat, message: a.message }) },
  "message details": { method: "chat.details", usage: "message details <chat> <message>", summary: "How a message travelled", args: ["chat", "message"], params: (_, a) => ({ chat: a.chat, message: a.message }) },
  "message retry": { method: "chat.retry", usage: "message retry <chat> <message>", summary: "Send a failed message again", args: ["chat", "message"], params: (_, a) => ({ chat: a.chat, message: a.message }) },
  "react": {
    method: "chat.react", usage: "react <chat> <message> <emoji> [--remove]", summary: "React to a message with one emoji (it replaces yours); --remove takes yours back",
    args: ["chat", "message", "emoji..."], options: { remove: { type: "boolean", description: "Take your reaction back" } },
    params: ({ options }, a) => ({ chat: a.chat, message: a.message, emoji: a.emoji, remove: options.remove === true }),
  },
  "typing": {
    method: "chat.typing", usage: "typing <chat> [--kind typing|recording|thinking] [--status \"<text>\"] [--for s] [--stop]",
    summary: "Show the contact you are writing, recording or thinking (live chats; it fades after 6 s unless said again, or kept with --for; a send or --stop ends it)", args: ["chat"],
    options: {
      stop: { type: "boolean", description: "Say you stopped" },
      kind: { type: "string", description: "typing (default), recording (a voice note) or thinking" },
      status: { type: "string", description: "A short line shown instead, e.g. \"Transcribing your audio…\" (40 characters, no links)" },
      for: { type: "number", description: "Keep saying it for this many seconds (up to 600), until a send or --stop" },
    },
    params: ({ options }, { chat }) => ({ chat, stop: options.stop === true, kind: options.kind, status: options.status, for: options.for }),
  },
};
