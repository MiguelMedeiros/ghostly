import { type Command, force, groupWait, cursor, needs, routineFields, routineOptions, runOf, taskFields, taskOptions, wait } from "./shared";

/** Invites, chats and messages: one entry per command, in alphabetical order (test/commands.test.ts checks). */
export const commands: Record<string, Command> = {
  "button press": {
    method: "button.press", usage: "button press <chat|group> <message> <button> [--wait none|sent|delivered] [--timeout s]",
    summary: "Press a button of someone else's message, as a tap in the app does (its id from the message's card)",
    args: ["chat", "message", "button"],
    options: {
      wait: { type: "string", description: "none, sent (a one-shot's default in a chat) or delivered; a group takes none or sent" },
      timeout: groupWait.timeout,
    },
    params: ({ options }, a) => ({ chat: a.chat, message: a.message, button: a.button, wait: options.wait, timeout: options.timeout }),
  },
  "button update": {
    method: "button.update", usage: "button update <chat|group> <message> [--chosen <button>] [--close] [--text <text>] [--force] [--wait none|confirmed|sent] [--timeout s]",
    summary: "Show the answer on a message's buttons (--chosen), close them, or change its text (the messageId send --button gave)",
    args: ["chat", "message"],
    options: {
      chosen: { type: "string", description: "The button to show as the answer (its id)" },
      close: { type: "boolean", description: "Close the buttons: no more presses" },
      text: { type: "string", description: "A new text for the message (default: the one it has); people see it marked edited" },
      force,
      wait: { type: "string", description: "none (default), confirmed (a chat's contact took it) or sent (a group's edge took it)" },
      timeout: groupWait.timeout,
    },
    params: ({ options }, a) => ({ chat: a.chat, message: a.message, chosen: options.chosen, close: options.close === true, text: options.text, force: options.force === true, wait: options.wait, timeout: options.timeout }),
  },
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
  "pin": {
    method: "chat.pin", usage: "pin <chat|group> <message> [--remove]", summary: "Pin a message at the top of a chat or group (one per chat: it replaces the pinned one); --remove unpins",
    args: ["chat", "message"], options: { remove: { type: "boolean", description: "Unpin the chat's pinned message" } },
    params: ({ options }, a) => ({ chat: a.chat, message: a.message, remove: options.remove === true }),
  },
  "react": {
    method: "chat.react", usage: "react <chat> <message> <emoji> [--remove]", summary: "React to a message with one emoji (it replaces yours); --remove takes yours back",
    args: ["chat", "message", "emoji..."], options: { remove: { type: "boolean", description: "Take your reaction back" } },
    params: ({ options }, a) => ({ chat: a.chat, message: a.message, emoji: a.emoji, remove: options.remove === true }),
  },
  "routine send": {
    method: "routine.send", usage: "routine send <chat|group> --name <name> --schedule \"every day 01:00\" [--cron \"0 1 * * *\"] [--state active|paused] [--next <time>] [--run ok|failed|skipped[:summary]] [--link url]... [--id id] [--json json|-|file] [--wait none|sent|delivered] [--timeout s]",
    summary: "Send a routine card (something a bot runs on a schedule: its last run and the next) to a chat or group",
    args: ["chat"],
    options: { id: { type: "string", description: "The routine's id, kept across updates (default: made up)" }, ...routineOptions, ...groupWait, wait: wait.wait },
    params: ({ options }, { chat }) => ({ chat, card: needs(routineFields(options), [["name", "name"], ["schedule", "schedule"]], "routine send <chat|group> --name <name> --schedule \"every day 01:00\""), run: runOf(options.run), text: options.text, wait: options.wait, timeout: options.timeout }),
  },
  "routine update": {
    method: "routine.update", usage: "routine update <chat|group> <routine> [--run ok|failed|skipped[:summary]] [--next <time>] [--state active|paused] [--schedule ...] [--json json|-|file] [--wait none|confirmed|sent] [--timeout s]",
    summary: "Update a routine card you sent: record a run, the next one, a pause (at most one update per 2.5 s; sooner ones merge)",
    args: ["chat", "routine"],
    options: { ...routineOptions, wait: { type: "string", description: "none (default), confirmed (a chat's contact took it) or sent (a group's edge took it)" }, timeout: groupWait.timeout },
    params: ({ options }, a) => ({ chat: a.chat, routine: a.routine, card: routineFields(options), run: runOf(options.run), text: options.text, wait: options.wait, timeout: options.timeout }),
  },
  "task send": {
    method: "task.send", usage: "task send <chat|group> --title <title> [--status s] [--progress n | --steps a/b] [--step \"...\"] [--item state:text]... [--pr-url url --pr-number n --additions n --deletions n --files n] [--branch b] [--link url]... [--id id] [--json json|-|file] [--wait none|sent|delivered] [--timeout s]",
    summary: "Send a task card (a bot's work: status, progress, its PR) to a chat or group; prints its id and message",
    args: ["chat"],
    options: { id: { type: "string", description: "The task's id, kept across updates (default: made up)" }, ...taskOptions, ...groupWait, wait: wait.wait },
    params: ({ options }, { chat }) => ({ chat, card: needs(taskFields(options), [["title", "title"]], "task send <chat|group> --title <title>"), text: options.text, wait: options.wait, timeout: options.timeout }),
  },
  "task update": {
    method: "task.update", usage: "task update <chat|group> <task> [--status s] [--progress n | --steps a/b] [--step \"...\"] [--item state:text]... [--pr-url ...] [--json json|-|file] [--wait none|confirmed|sent] [--timeout s]",
    summary: "Update a task card you sent: the fields given, merged over it (at most one update per 2.5 s; sooner ones merge)",
    args: ["chat", "task"],
    options: { ...taskOptions, wait: { type: "string", description: "none (default), confirmed (a chat's contact took it) or sent (a group's edge took it)" }, timeout: groupWait.timeout },
    params: ({ options }, a) => ({ chat: a.chat, task: a.task, card: taskFields(options), text: options.text, wait: options.wait, timeout: options.timeout }),
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
