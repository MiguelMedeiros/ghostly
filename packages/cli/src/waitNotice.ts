/*
 * What a command that waits says while it waits and when Ctrl-C ends it (agents#2354). Kept apart from waits.ts, which
 * runs in the daemon or the one-shot's engine: this is read by the command's own process, which loads no engine module
 * for a command a daemon answers.
 */

import { basename } from "node:path";
import { DHT_TEXT_BYTES } from "@ghostly/core";
import { shellWord } from "./shellWord";

/** What happens next to what a wait was waiting on: a daemon goes on, a one-shot's profile closes now. */
export const goesOn = (mode: "daemon" | "one-shot"): string => mode === "one-shot"
  ? "goes with this profile's next command, or keep it online with `ghostly daemon --detach`"
  : "still goes by itself while this profile is online";

/**
 * A chat this side holds on the DHT only (`chat disconnect --hold`) until `until`: what waits for its end (`act`)
 * goes then by itself, or at once with `chat connect`, which ends the hold. A hold whose time is up and that is still
 * ending (`holdEnds`) says so. The time is this machine's: the hour and minute, with the day when it is not today.
 */
export function heldWords(until: number, ref: string, act: string, oneShot = false): string {
  const connect = `ghostly chat connect ${shellWord(ref, "<chat>")}`;
  const online = oneShot ? " while this profile is online (ghostly daemon --detach)" : "";
  if (until <= Date.now()) return `this chat's hold on the DHT only is ending: ${act} once the chat is live${online}, or now with ${connect}`;
  const at = new Date(until), two = (n: number) => String(n).padStart(2, "0");
  const day = at.toDateString() === new Date().toDateString() ? "" : `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} `;
  return `this chat is held on the DHT only until ${day}${two(at.getHours())}:${two(at.getMinutes())}: ${act} then${online}, or now with ${connect}`;
}

/** Where a chat stands for `dhtOnlyNote`: this side's DHT only (and its hold's end, if a hold), the contact's. */
export interface DhtOnly { mine: boolean; theirs: boolean; heldUntil: number | null; oneShot: boolean }

/**
 * Why a text that waits will not go by itself, or undefined: longer than the 256 bytes the DHT carries, in a chat on
 * the DHT only (this side's choice, the contact's, or both). It goes once the chat is live, which neither side's app
 * tries while either keeps it on the DHT only, so it is said with what ends that, or to shorten it. This side's DHT
 * only that is a hold (`chat disconnect --hold`) ends by itself: said with when, and the command that ends it now. The
 * engine says it on `send` and `forward` (api.ts), the command's process on its notice and Ctrl-C (`dhtOnlyNotice`).
 */
export function dhtOnlyNote(chat: DhtOnly, text: string, ref: string): string | undefined {
  if (new TextEncoder().encode(text.trim()).length <= DHT_TEXT_BYTES) return undefined;
  const who = dhtOnlyWho(chat, ref, ", or shorten it");
  return who && `Longer than the ${DHT_TEXT_BYTES} bytes the DHT carries, and ${who}`;
}

/**
 * Whose choice keeps the chat on the DHT only and what ends it, for what waits for a live session ("it goes"), or
 * undefined while neither side keeps it there. `or`: another way out, said after a choice (a hold ends by itself).
 */
function dhtOnlyWho(chat: DhtOnly, ref: string, or = ""): string | undefined {
  const { mine, theirs, heldUntil: held } = chat;
  if (!mine && !theirs) return undefined;
  const chosen = mine && held === null;
  const switchBack = `ghostly chat transport ${shellWord(ref, "<chat>")} auto`;
  return chosen && theirs ? `you and the contact keep this chat on the DHT only: it goes once both choose a live transport (${switchBack})${or}`
    : theirs ? `the contact keeps this chat on the DHT only: it goes once they choose a live transport${or}`
    : held !== null ? heldWords(held, ref, "it goes", chat.oneShot)
    : `this chat is on the DHT only: it goes once you choose a live transport (${switchBack})${or}`;
}

/**
 * Why my pin (or unpin) in a 1:1 chat waits, or undefined: a pin goes on the live session only (core `sendPin`), never
 * over the DHT, and a chat on the DHT only (this side's choice or hold, the contact's) has none. It goes once that
 * ends, said with whose choice it is and what ends it, as `dhtOnlyNote` says it of a long text. The daemon's answer
 * says it in `note`, a `--wait confirmed` timeout in its words and `details.note` (api.ts `pinWaitsLive`): both said
 * the pin still goes by itself, and it never did while the chat stayed on the DHT only.
 */
export function pinWaitsNote(chat: DhtOnly, ref: string, remove: boolean): string | undefined {
  const who = dhtOnlyWho(chat, ref);
  return who && `${remove ? "An unpin" : "A pin"} goes only on a live session, and ${who}`;
}

/**
 * The wait a one-shot does when no `--wait` is given (`ctx.mode === "one-shot"` defaults in api.ts, files.ts, buttons.ts
 * and statusCards.ts): what is not out yet leaves with the process, so it stays. A daemon answers those at once. A ref
 * written `group:<id>` is a group's, whose file, card or button press does not wait; a group named otherwise is told
 * only by the engine, and its notice comes only if the call is still going after WAIT_NOTICE_MS.
 */
function oneShotWait(method: string, params: Record<string, unknown>): string | undefined {
  const group = typeof params.group === "string" || (typeof params.chat === "string" && params.chat.startsWith("group:"));
  switch (method) {
    // On a chat nobody joined yet these answer at once (apiKit `oneShotWaits`); a notice comes only if a call is still
    // going after WAIT_NOTICE_MS.
    case "chat.send": return "sent";
    case "chat.edit": return "confirmed";
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
  // A one-shot join by a group's link waits to be let in (api.ts `letIn`); through a daemon it answers at once.
  if (method === "group.join") return mode === "one-shot"
    ? { waiting: "waiting for a member's app to let this profile in (up to 60 s; Ctrl-C stops waiting)", stopped: "not let in yet: the knock goes on while this profile is running (ghostly daemon --detach)" }
    : null;
  const params = waitOf(method, given, mode);
  // A daemon's file send answers once it has copied the file into the profile (files.ts `stage`): 6-30 s for 1 GiB, said
  // nothing, and read as a hung daemon. Ctrl-C there stops the send (files.ts `stageWhileAsked`): nothing goes.
  if (method === "file.send" && mode === "daemon" && params.wait !== "sent") {
    const file = word(params.name) ?? (word(params.path) ? basename(params.path as string) : "the file");
    const chatRef = word(params.chat) ?? "the chat", chat = chatRef.startsWith("group:") ? `group ${chatRef.slice("group:".length)}` : chatRef;
    return { waiting: `copying ${file} into the profile before it goes to ${chat} (Ctrl-C stops the send)`, stopped: `${file} was not sent to ${chat}: send it again when you want it` };
  }
  const waits = waitsFor(method, params);
  if (waits === undefined) return null;
  const seconds = typeof params.timeout === "number" ? params.timeout : waits;
  // One that waits for the contact (`--wait sent`, a one-shot's own wait) copies the file in first as well, and Ctrl-C
  // then stops the send (a daemon's `stageWhileAsked`, a one-shot's profile closing under the copy): it said "it is kept
  // here and still goes" with nothing in the chat. Which of the two it was, only the chat's file list tells.
  if (method === "file.send") {
    const file = word(params.name) ?? (word(params.path) ? basename(params.path as string) : "the file");
    const chatRef = word(params.chat), chat = chatRef ?? "the contact";
    const list = chatRef ? ` (ghostly file list ${shellWord(chatRef, "<chat>")} says which)` : "";
    return {
      waiting: `copying ${file} into the profile, then waiting for it to go out to ${chat} (up to ${seconds} s; Ctrl-C stops the send while it is copied in, then only the waiting)`,
      stopped: `${file} was not sent to ${chat} if it was still being copied in; if it was in the chat, it is kept here and ${goesOn(mode)}${list}`,
    };
  }
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

/**
 * A `send` that waits on a text past the 256 bytes the DHT carries, and a pin (or unpin) in a 1:1 chat, which goes on
 * a live session only: the notice said "it still goes" and Ctrl-C that it "still goes by itself" (or with the next
 * command), which neither does while the chat stays on the DHT only. Only the chat's state says so, which the
 * command's process reads (`chat.get`) and hands to `dhtOnlyNotice`; the chat to read, or undefined.
 */
export function dhtOnlyChat(method: string, params: Record<string, unknown>): string | undefined {
  const long = method === "chat.send" && typeof params.text === "string" && new TextEncoder().encode(params.text.trim()).length > DHT_TEXT_BYTES;
  if (!long && method !== "chat.pin") return undefined;
  const chat = word(params.chat);
  return chat?.startsWith("group:") ? undefined : chat;
}

/**
 * That call's notice once its chat was read (`chat.get`): said with why it waits when the chat is on the DHT only,
 * else as it was. A hold whose time is up and still ending reads as no hold there (`heldUntil`), so as a DHT only chosen.
 */
export function dhtOnlyNotice(notice: WaitNotice, method: string, params: Record<string, unknown>, chat: { deliveryMode?: unknown; peerDeliveryMode?: unknown; heldUntil?: unknown }, mode: "daemon" | "one-shot"): WaitNotice {
  const mine = chat.deliveryMode === "dht";
  const heldUntil = mine && typeof chat.heldUntil === "number" ? chat.heldUntil : null;
  const where: DhtOnly = { mine, theirs: chat.peerDeliveryMode === "dht", heldUntil, oneShot: mode === "one-shot" };
  const note = method === "chat.pin" ? pinWaitsNote(where, params.chat as string, params.remove === true) : dhtOnlyNote(where, params.text as string, params.chat as string);
  return note ? { waiting: `${notice.waiting.replace(/, it still goes\)$/, ")")}. ${note}`, stopped: `it is kept here. ${note}` } : notice;
}
