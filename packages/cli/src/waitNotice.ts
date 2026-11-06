/*
 * What a command that waits says while it waits and when Ctrl-C ends it (agents#2354). Kept apart from waits.ts, which
 * runs in the daemon or the one-shot's engine: this is read by the command's own process, which loads no engine module
 * for a command a daemon answers.
 */

/** What happens next to what a wait was waiting on: a daemon goes on, a one-shot's profile closes now. */
export const goesOn = (mode: "daemon" | "one-shot"): string => mode === "one-shot"
  ? "goes with this profile's next command, or keep it online with `ghostly daemon --detach`"
  : "still goes by itself while this profile is online";

/**
 * The wait a one-shot does when no `--wait` is given (`ctx.mode === "one-shot"` defaults in api.ts, files.ts, buttons.ts
 * and statusCards.ts): what is not out yet leaves with the process, so it stays. A daemon answers those at once. A ref
 * written `group:<id>` is a group's, whose file, card or button press does not wait; a group named otherwise is told
 * only by the engine, and its notice comes only if the call is still going after WAIT_NOTICE_MS.
 */
function oneShotWait(method: string, params: Record<string, unknown>): string | undefined {
  const group = typeof params.group === "string" || (typeof params.chat === "string" && params.chat.startsWith("group:"));
  switch (method) {
    case "file.send": case "task.send": case "routine.send": case "button.press": return group ? undefined : "sent";
    // `--all` reports to each 1:1 chat in turn, each waiting as one named would.
    case "usage.send": return group ? undefined : "sent";
    case "task.update": case "routine.update": return group ? undefined : "confirmed";
    case "chat.react": return "confirmed";
    case "group.react": return "sent";
    case "chat.pin": return group ? "sent" : "confirmed";
    case "chat.delete": return params.everyone !== true ? undefined : group ? "sent" : "confirmed";
    default: return undefined;
  }
}

/** The call's `wait`: the one given, or the one-shot's own default. */
function waitOf(method: string, params: Record<string, unknown>, mode: "daemon" | "one-shot"): Record<string, unknown> {
  if (params.wait !== undefined || mode !== "one-shot") return params;
  const wait = oneShotWait(method, params);
  return wait === undefined ? params : { ...params, wait };
}

/**
 * The seconds a call without `--timeout` waits for the contact: the daemon's defaults (`num(params, "timeout", …)` in
 * api.ts, files.ts, buttons.ts and statusCards.ts), so that a bot's `chat wait` or `send --wait sent` on a daemon that
 * stopped answering ends when the wait would have (main.ts `answerWithin`). A call that does not wait is none.
 */
export function waitsFor(method: string, params: Record<string, unknown>): number | undefined {
  if (method === "chat.wait") return 60;
  if (method === "file.wait" || (method === "file.save" && params.wait === true) || (method === "file.send" && params.wait === "sent")) return 300;
  // send, edit, forward, a button, a task or routine card: `--wait sent|confirmed|delivered`, 30 s each.
  if (typeof params.wait === "string" && params.wait !== "none") return 30;
  return undefined;
}

export interface WaitNotice {
  /** Said on stderr (a terminal's only) when the wait has gone on for a moment: what it waits for. */
  waiting: string;
  /** Said after "stopped waiting (Ctrl-C): " when Ctrl-C ends the wait: what becomes of what it waited on. */
  stopped: string;
}

const word = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;

/**
 * A state `chat wait --until` waits for, as a sentence says it (`to`: the wait's timeout and notice, `not`: Ctrl-C).
 * The flag's word after "to be" read "to be text" and "was not text yet".
 */
const CHAT_STATES: Record<string, { to: string; not: string }> = {
  live: { to: "to be live", not: "was not live yet" },
  text: { to: "to carry text", not: "could not carry text yet" },
  paired: { to: "to be paired", not: "was not paired yet" },
};
export const chatState = (until: string): { to: string; not: string } => CHAT_STATES[until] ?? { to: `to be ${until}`, not: `was not ${until} yet` };

/** What a call waits for, in a person's words, or null for a call that does not wait. */
export function waitNotice(method: string, given: Record<string, unknown>, mode: "daemon" | "one-shot"): WaitNotice | null {
  const params = waitOf(method, given, mode);
  const waits = waitsFor(method, params);
  if (waits === undefined) return null;
  const seconds = typeof params.timeout === "number" ? params.timeout : waits;
  const upTo = `up to ${seconds} s; Ctrl-C stops waiting`;
  if (method === "chat.wait") {
    const chat = word(params.chat) ?? "the chat", state = chatState(word(params.until) ?? "live");
    return { waiting: `waiting for chat ${chat} ${state.to} (${upTo})`, stopped: `chat ${chat} ${state.not}` };
  }
  if (method === "file.wait" || method === "file.save") {
    const file = word(params.file) ?? "the file";
    const on = mode === "one-shot" ? "goes on while this profile is online (`ghostly daemon --detach`)" : "goes on while this profile is online";
    return { waiting: `waiting for file ${file}'s transfer to end (${upTo}; the transfer ${on})`, stopped: `file ${file}'s transfer ${on}` };
  }
  const chatRef = word(params.chat);
  // A forward's `chat` is where the messages come from; they go to `to`.
  const group = word(params.group) ?? (method.startsWith("group.") ? chatRef
    : method !== "chat.forward" && chatRef?.startsWith("group:") ? chatRef.slice("group:".length) : undefined);
  const to = Array.isArray(params.to) ? params.to.filter((t): t is string => typeof t === "string").join(", ") : undefined;
  const chat = (to || undefined) ?? chatRef ?? (params.all === true ? "each contact" : "the contact");
  const what = group !== undefined ? `a member's edge in group ${group} to take it`
    : params.wait === "sent" ? `it to go out to ${chat}`
    : `${chat}'s app to confirm it`;
  return { waiting: `waiting for ${what} (${upTo}, it still goes)`, stopped: `it is kept here and ${goesOn(mode)}` };
}
