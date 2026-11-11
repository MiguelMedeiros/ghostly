import { groupName, INVITE_TAKEN, isZ32Key, MAX_GROUP_NAME_BYTES, MAX_GROUP_NAME_LENGTH, sanitizeDisplayText, type PairedTransport } from "@ghostly/core";
import type { GhostlyNode } from "@ghostly/browser/engine/node";
import { replyRef } from "@ghostly/browser/shared/replies";
import type { EngineState, GroupView, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { CliError } from "./errors";
import type { CallManager } from "./calls/manager";
import type { EventHub } from "./events";
import type { GroupAutoJoin } from "./groupAuto";
import type { Runtime } from "./runtime/engine";

/**
 * The methods of the local control API (WISP 1100): the daemon answers them over its socket, and a one-shot
 * command calls them in its own process. Parameters come from JSON: every one is checked here.
 */
export interface ApiContext {
  runtime: Runtime;
  hub: EventHub;
  /** Voice calls (WISP 1100 § Calls). */
  calls: CallManager;
  /** Group invitations accepted by themselves (`group auto`). */
  groupAuto: GroupAutoJoin;
  /** How the host runs: a daemon stays; a one-shot leaves when its command is done. */
  mode: "daemon" | "one-shot";
  version: string;
  /** The daemon asks to stop (answered first). */
  stop?: () => void;
  /**
   * Aborted when the daemon stops (`serve().close`): a wait still open answers with what it knows (`waits.ts`), as a
   * timeout with `details.reason: "daemon-stopped"`, before the connections end.
   */
  stopping?: AbortSignal;
  /** The daemon is a `listen` that found none and runs the profile itself: a stop ends that listen too. */
  listen?: true;
}

export type Params = Record<string, unknown>;
export type Method = (ctx: ApiContext, params: Params) => Promise<unknown>;

export const node = (ctx: ApiContext): GhostlyNode => ctx.runtime.server.node;
export const state = (ctx: ApiContext): EngineState => node(ctx).getState();

/**
 * The time of a send the engine names its row after (`me_<timestamp>`: a file, a payment, a request), its own even
 * within one millisecond (a bot paying or sending several times at once over the socket, `file send` run in
 * parallel), or the chat keeps only one. One clock for all of them: they share the row names. A file's resend after a
 * drop finds its row by it, as a forward does.
 */
let lastSentAt = 0;
export const sentAt = () => (lastSentAt = Math.max(Date.now(), lastSentAt + 1));

// ---------- parameters ----------

export function str(params: Params, name: string, required: true): string;
export function str(params: Params, name: string, required?: false): string | undefined;
export function str(params: Params, name: string, required = false): string | undefined {
  const value = params[name];
  if (value === undefined || value === null || value === "") {
    if (required) throw new CliError("bad_request", `${name} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new CliError("bad_request", `${name} must be a string`);
  return value;
}
/** A number in `[min, max]`; `whole` takes only whole ones (a count of messages), as the engine needs them. */
export function num(params: Params, name: string, fallback: number, { min = 0, max = Number.MAX_SAFE_INTEGER, whole = false } = {}): number {
  const value = params[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new CliError("bad_request", `${name} must be a ${whole ? "whole " : ""}number from ${min} to ${max}`);
  if (whole && !Number.isSafeInteger(value)) throw new CliError("bad_request", `${name} must be a whole number from ${min} to ${max}`);
  return value;
}
/**
 * The seq `events.replay` and `events.subscribe` start after: whole, from 0; `fallback` when left out. A cursor sent as
 * text ("412") was a stream from now on the socket with no error, and a negative one a gap of seqs that never were.
 */
export function sinceSeq(params: Params, fallback: number): number {
  return num(params, "since", fallback, { whole: true });
}
export function bool(params: Params, name: string): boolean {
  const value = params[name];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new CliError("bad_request", `${name} must be true or false`);
  return value;
}
export function list(params: Params, name: string): string[] {
  const value = params[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new CliError("bad_request", `${name} must be a list of strings`);
  return value as string[];
}
/**
 * One of `values`; `fallback` when it was left out. Given empty (an unset variable in a script: `wallet remove ""`), it
 * is refused like any other wrong choice, never read as left out: that acted on the default (the Cashu wallet).
 */
export function oneOf<T extends string>(params: Params, name: string, values: readonly T[], fallback: T): T {
  const value = params[name] === "" ? "" : str(params, name) ?? fallback;
  if (!values.includes(value as T)) throw new CliError("bad_request", `${name} must be one of ${values.join(", ")}`);
  return value as T;
}

// ---------- finding things ----------

const KEY_SHAPED = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;
/**
 * A chat's id as the engine makes it (the first 16 characters of a z-base-32 key) and the CLI prints it as `chat`. A ref
 * so shaped is only ever an id: tested on its `nameKey`, so that a case, a space or an invisible character more is too.
 */
const CHAT_ID_SHAPED = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{16}$/;
/**
 * A contact key as chats show it (`peer`): 52 characters of z-base-32, in its one canonical spelling. The same 52
 * characters with the last one respelled decode to the same bytes but are no key (WISP 02): refused here, so that
 * they never fall through to a chat's name, which its contact chooses.
 */
export const CONTACT_KEY = {
  test(ref: string): boolean {
    if (isZ32Key(ref)) return true;
    if (KEY_SHAPED.test(ref)) throw new CliError("bad_request", `${JSON.stringify(ref)} is not a contact key: a key has one spelling, and its last character is not this one`);
    return false;
  },
};

/**
 * A chat's label, its contact's name or a group's name as a ref is compared with it: cleaned as the engine cleans a name
 * it stores (`renameLink`, `groupName`: any run of whitespace one space, invisible and direction-changing characters
 * dropped, trimmed), in one Unicode form (NFC) and one case. The string given to `chat rename` or `group create` finds
 * what it named, though what was stored is the cleaned one. Empty when nothing visible is left: that names nothing.
 */
export function nameKey(name: string | null | undefined): string {
  if (!name) return "";
  return (sanitizeDisplayText(name.replace(/\s+/gu, " "), Infinity)?.replace(/ {2,}/g, " ") ?? "").normalize("NFC").toLowerCase();
}

/**
 * A name this side writes (a chat's label, the profile's name, a group's name) cleaned as the engine stores a name
 * (`renameLink`, `groupName`): any run of whitespace (a tab, a line break) one space, invisible and direction-changing
 * characters dropped, trimmed, in NFC: `nameKey` without the case. Counted after that, in code points as the engine
 * counts: undefined past `max`, "" when nothing visible is left. Every command that writes a name checks it here, so a
 * tab is a space and not a second line, and a name is never refused at a length it does not have once stored.
 */
export function cleanName(name: string, max: number): string | undefined {
  const clean = (sanitizeDisplayText(name.replace(/\s+/gu, " "), Infinity)?.replace(/ {2,}/g, " ") ?? "").normalize("NFC");
  return [...clean].length > max ? undefined : clean;
}

/**
 * `name` as `cleanName` stores it, or the one refusal every name kind gives (`bad_request`), so a chat's, the profile's
 * and a group's name read alike. `subject` starts the sentence ("A chat's name", "nick"); `empty` follows "needs a
 * character that shows" (what an empty name does instead, when it does something). Too long says the count as stored,
 * in code points as the engine counts, and the largest character of several code points in it (a joined emoji or a
 * flag counts as several): the person sees what to cut, and a bot reads `details.length` and `details.max`.
 */
export function shownName(name: string, max: number, subject: string, empty = ""): string {
  const clean = cleanName(name, Infinity) ?? "";
  const length = [...clean].length;
  if (length > max) {
    const widest = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(clean)]
      .map(({ segment }) => segment).reduce((a, b) => ([...b].length > [...a].length ? b : a), "");
    const several = [...widest].length > 1 ? `: ${widest} counts as ${[...widest].length}` : "";
    throw new CliError("bad_request", `${subject} is up to ${max} characters as stored (this one is ${length}${several})`, { length, max });
  }
  if (!clean) throw new CliError("bad_request", `${subject} needs a character that shows${empty}`);
  return clean;
}

/**
 * The `name` param of `group create` and `group rename`, refused as a chat's or the profile's name is (`shownName`),
 * then as the engine takes it (`groupName`: the same cleaning, 64 code points, 256 bytes; 64 code points never pass
 * 256 bytes, so its refusal is only a guard). Said here, before anything is made.
 */
export function groupNameOf(params: Params): string {
  const name = groupName(shownName(str(params, "name", true), MAX_GROUP_NAME_LENGTH, "A group's name"));
  if (!name) throw new CliError("bad_request", `A group's name is up to ${MAX_GROUP_NAME_BYTES} bytes as stored`);
  return name;
}

/** Whether `name` is the one `key` (a ref's `nameKey`) names. */
const namedAs = (key: string, name: string | null | undefined) => key !== "" && nameKey(name) === key;

/**
 * A chat by its id; by its contact's key (only by the key: a name is never taken for one); by the label this side gave
 * it; and only when no label matches, by a unique prefix of its id or the name the contact gave itself. The contact
 * controls both of those (a joiner's chat id is made from the inviter's code), so neither wins over a label, and a ref
 * that fits one chat's prefix and another's name is refused. A ref shaped as a chat's id is only ever an id, or a label
 * given here. `group:<ref>` is never a chat (a group, as everywhere). A ref
 * that names no chat but one of `groups` says it is a group (see `noChat`).
 */
export function findChat(links: readonly LinkView[], ref: string, groups: readonly GroupView[] = []): LinkView {
  return chatBy(links, ref, groups).link;
}

/**
 * No chat by `ref`. A group's id, prefix or name (or `group:<id>`) says it is a group, as `groupOf` says a chat is one:
 * `chat connect`, `identity share`, `call start` and the other commands that take only a 1:1 chat read `No chat "Crew"`,
 * as if nothing had that name.
 */
function noChat(ref: string, groups: readonly GroupView[]): CliError {
  const group = groupNamed(ref, groups);
  if (group) return new CliError("not_found", `${JSON.stringify(ref)} is a group, not a chat (ghostly chat list)`, { group: group.id });
  return new CliError("not_found", `No chat ${JSON.stringify(ref)} (ghostly chat list)`);
}

/** A chat or group ref as a next step shows it: as given, quoted only when it holds more than a word. */
const shownRef = (ref: string) => (/^[\w.:-]+$/.test(ref) ? ref : JSON.stringify(ref));

/** The chat or the group a message or a file was looked for in, as the command was given it (`ref`). */
export type RefPlace = { group: boolean; ref: string };

/**
 * No message by `id` in a chat or a group, said one way by every command that takes one, as `noChat` says a chat: the id
 * quoted as given, and where the ids are. `whose` ("of yours", "from someone else") is what it had to be; `tail` what
 * else it may have failed for (", or it takes no reaction", ": only your own messages are sent again").
 */
export function noMessage(id: string, place: RefPlace, { whose, tail }: { whose?: string; tail?: string } = {}): CliError {
  const history = `ghostly ${place.group ? "group" : "chat"} history ${shownRef(place.ref)}`;
  return new CliError("not_found", `No message ${JSON.stringify(id)}${whose ? ` ${whose}` : ""} in this ${place.group ? "group" : "chat"}${tail ?? ""} (${history})`);
}

/** No file by `id`, as `noMessage` says a message: in the chat or group named (`place`), or in none when none was. */
export function noFile(id: string, place?: RefPlace): CliError {
  const where = place ? ` in this ${place.group ? "group" : "chat"}` : "";
  return new CliError("not_found", `No file ${JSON.stringify(id)}${where} (ghostly file list ${place ? shownRef(place.ref) : "<chat|group>"})`);
}

/** The one group `ref` names, if any (none, or more than one: undefined). */
function groupNamed(ref: string, groups: readonly GroupView[]): GroupView | undefined {
  try { return findGroup(groups, ref); } catch { return undefined; }
}

/** `findChat`, and whether only what the contact controls (`theirName`: a prefix of the id, its own name) found the chat. */
function chatBy(links: readonly LinkView[], ref: string, groups: readonly GroupView[] = []): { link: LinkView; theirName: boolean } {
  // "" (an unset variable in a script) is a prefix of every id: it took the only chat.
  if (!ref.trim()) throw new CliError("bad_request", `${JSON.stringify(ref)} names no chat`);
  const exact = links.find((link) => link.id === ref);
  if (exact) return { link: exact, theirName: false };
  if (CONTACT_KEY.test(ref)) {
    const byKey = links.filter((link) => link.peerPubKeyZ32 === ref);
    if (byKey.length === 1) return { link: byKey[0], theirName: false };
    if (byKey.length > 1) throw new CliError("bad_request", `${JSON.stringify(ref)} names more than one chat: use its id`, { matches: byKey.map((link) => link.id) });
    throw new CliError("not_found", `No chat with ${JSON.stringify(ref)} (ghostly chat list)`);
  }
  const key = nameKey(ref);
  const named = (name: string | null | undefined) => namedAs(key, name);
  const byLabel = links.filter((link) => named(link.label));
  // `group:<ref>` names a group (`groupPrefixed`), never a chat: not by a name its contact chose, nor by a label given
  // here (a chat labelled `group:Crew` was that chat for `chat show` and the group Crew for `send`). A chat labelled so
  // before labels were refused (`chatName`) is named by its id.
  if (groupPrefixed(ref) !== null) {
    if (byLabel.length && !groupNamed(ref, groups)) throw new CliError("not_found", `${JSON.stringify(ref)} names a group, never a chat: name the chat labelled so by its id, and give it another name (ghostly chat rename <chat> <name>)`, { matches: byLabel.map((link) => link.id) });
    throw noChat(ref, groups);
  }
  // A chat's id no chat has (one removed since: a bot kept it from an event) is no chat. Its contact and whoever saw its
  // invite know it, so another contact could call itself that and take every later command sent by it. A label given
  // here still names the chat: only this side chooses it.
  if (!byLabel.length && CHAT_ID_SHAPED.test(key)) throw noChat(ref, groups);
  const found = byLabel.length ? byLabel : [...new Set([...links.filter((link) => link.id.startsWith(ref)), ...links.filter((link) => named(link.peerNick))])];
  if (found.length === 1) return { link: found[0], theirName: !byLabel.length };
  if (found.length > 1) throw new CliError("bad_request", `${JSON.stringify(ref)} names more than one chat: use its id`, { matches: found.map((link) => link.id) });
  throw noChat(ref, groups);
}

/**
 * `findChat` for a grant the daemon keeps acting on (`call auto on --from`): only the chat's id, its contact's key or the
 * label this side gave it name the chat. A prefix of its id or the name its contact gave itself is refused, with the
 * chat it found: the contact chose those, so another contact could take the grant by calling itself that name.
 */
export function findOwnNamedChat(links: readonly LinkView[], ref: string, groups: readonly GroupView[] = []): LinkView {
  const chat = chatBy(links, ref, groups);
  if (chat.theirName) throw namedByThem(ref, { chat: chat.link.id, name: chat.link.peerNick ?? null, contact: chat.link.peerPubKeyZ32 });
  return chat.link;
}

/** `findOwnNamedChat`'s refusal: `ref` found `chat` only by what its contact chose. */
export function namedByThem(ref: string, chat: { chat: string; name: string | null; contact: string | undefined }): CliError {
  return new CliError("bad_request", `${JSON.stringify(ref)} names a chat only by what its contact chose (a prefix of its id, its own name): use the chat's id, its contact's key or a label given here (ghostly chat rename <chat> <name>)`, chat);
}

/**
 * `group:<ref>`, the form that names a group wherever a group is taken (docs/CLI.md § What it does): `<ref>`, read as any
 * other ref (`findGroup`: an id, a prefix of it or a name). Null for a ref without it. `findGroup` and `findChatOrGroup`
 * both read the prefix here, so a group command and a command that takes a chat or a group never read it apart.
 */
export const groupPrefixed = (ref: string): string | null => (ref.startsWith("group:") ? ref.slice("group:".length) : null);

/** Only an invitation so far: this profile is not in the group (yet), and whoever invited chose its name. */
const invitedOnly = (group: GroupView) => group.status === undefined && !!group.invitation;

/**
 * A group by its id, by its name, or by a unique prefix of its id. Whoever created a group chose its id and its admin
 * chooses its name, so neither wins over the other: a ref that is one group's name and another's prefix is refused,
 * with both ids, as `chatBy` does for chats. A group this profile is in wins over an invitation with the same name or
 * prefix (the one who invites chooses those); an invitation is still found by its id, and by name or prefix where no
 * group of this profile has it. `group:<ref>` is `<ref>` (`groupPrefixed`); before, only the commands that take a chat
 * or a group read it, and every group command and `listen --group` answered it `No group`.
 */
export function findGroup(groups: readonly GroupView[], given: string): GroupView {
  const ref = groupPrefixed(given) ?? given;
  // Each refusal echoes the ref as given (`"group:k86q"`), not the part after `group:`: what the person typed.
  if (!ref.trim()) throw new CliError("bad_request", `${JSON.stringify(given)} names no group`);
  const exact = groups.find((group) => group.id === ref);
  if (exact) return exact;
  const key = nameKey(ref);
  for (const among of [groups.filter((group) => !invitedOnly(group)), groups.filter(invitedOnly)]) {
    const found = among.filter((group) => namedAs(key, group.name) || group.id.startsWith(ref));
    if (found.length === 1) return found[0];
    if (found.length > 1) throw new CliError("bad_request", `${JSON.stringify(given)} names more than one group: use its id`, { matches: found.map((group) => group.id) });
  }
  throw new CliError("not_found", `No group ${JSON.stringify(given)} (ghostly group list)`);
}

/**
 * A chat or a group, where a command takes either: `group:<id>` is a group; anything else a chat first (`findChat`),
 * then a group. A chat found only by what its contact chose (a prefix of its id, its own name) never takes what also
 * names a group: a group's
 * own id is that group, and a prefix or the name of a group this profile is in is refused, with both ids. With neither,
 * one `not_found` names both and where to look (a contact's key: no chat with it); a name that matches more than one
 * chat or group stays that error.
 */
export function findChatOrGroup(links: readonly LinkView[], groups: readonly GroupView[], ref: string): { link: LinkView } | { group: GroupView } {
  if (groupPrefixed(ref) !== null) return { group: findGroup(groups, ref) };
  let chat: ReturnType<typeof chatBy>;
  try {
    chat = chatBy(links, ref);
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== "not_found") throw error;
    // Nor is it a group's name or a prefix of a group's id (its admin and its creator chose those; a group's own id is
    // longer): `group:<ref>` names a group.
    if (CHAT_ID_SHAPED.test(nameKey(ref))) throw error;
    try { return { group: findGroup(groups, ref) }; } catch (inner) {
      if (!(inner instanceof CliError) || inner.code !== "not_found") throw inner;
      if (CONTACT_KEY.test(ref)) throw error;
      throw new CliError("not_found", `No chat or group ${JSON.stringify(ref)} (ghostly chat list, ghostly group list)`);
    }
  }
  if (!chat.theirName) return { link: chat.link };
  const exact = groups.find((group) => group.id === ref);
  if (exact) return { group: exact };
  const key = nameKey(ref);
  const also = groups.filter((group) => !invitedOnly(group) && (group.id.startsWith(ref) || namedAs(key, group.name)));
  if (also.length) throw new CliError("bad_request", `${JSON.stringify(ref)} names a chat (by what its contact chose) and a group: use the chat's id or group:<id>`, { chat: chat.link.id, groups: also.map((group) => group.id) });
  return { link: chat.link };
}

/** The calls that act on one message (`message`) of the chat they name; `pin --remove` names none it needs. */
const ON_A_MESSAGE: ReadonlySet<string> = new Set(["chat.react", "chat.pin", "chat.edit", "chat.delete", "chat.retry"]);

/**
 * Whether the chat may have the message `ref` names: by its row's id, or by an id both sides know it by (its wire id,
 * the one a reaction or a pin names), as every call of `ON_A_MESSAGE` looks for it. The chat is read whole only when
 * the row's id finds nothing.
 */
async function mayHaveMessage(ctx: ApiContext, linkId: string, ref: string): Promise<boolean> {
  if (await node(ctx).getMessage(linkId, ref)) return true;
  return (await node(ctx).getMessages(linkId)).some((m) => m.wireId === ref || replyRef(m, false) === ref);
}

/**
 * Starts the chats a call names (its `chat`, a forward's `to`) in a runtime that left the saved chats unstarted
 * (`RuntimeOptions.deferChats`). A ref that names no chat, or names a group, starts nothing: the call says so itself.
 * Nor does a call on a message the chat does not have (`ON_A_MESSAGE`): it is refused `not_found` with nothing sent.
 * Started, the chat put its records on the relays and the one-shot's close waited for its leave packet there: a
 * mistyped message id took 4 to 10 s to say "No message".
 */
export async function startNamedChats(ctx: ApiContext, method: string, params: Params): Promise<void> {
  const { links, groups } = state(ctx);
  const message = false && ON_A_MESSAGE.has(method) && !(method === "chat.pin" && params.remove === true) && typeof params.message === "string" ? params.message : undefined;
  for (const ref of [params.chat, ...(Array.isArray(params.to) ? params.to : [])]) {
    if (typeof ref !== "string") continue;
    let found: ReturnType<typeof findChatOrGroup>;
    try { found = findChatOrGroup(links, groups, ref); } catch { continue; }
    if (!("link" in found)) continue;
    if (message !== undefined && !await mayHaveMessage(ctx, found.link.id, message)) continue;
    node(ctx).startDeferredChat(found.link.id);
  }
}

export const chatOf = (ctx: ApiContext, params: Params) => findChat(state(ctx).links, str(params, "chat", true), state(ctx).groups);

/** A chat of mine whose invite nobody took yet: no contact's key, so nothing goes out until they join. */
export const nobodyJoined = (link: LinkView): boolean => !!(link.profile && link.inviteCode && !link.peerParticipationKey);

/** `nobodyJoined` by the chat's id: a group's (`group:<id>`) is never one. */
export const nobodyJoinedChat = (ctx: ApiContext, chat: string): boolean => {
  const link = state(ctx).links.find((l) => l.id === chat);
  return !!link && nobodyJoined(link);
};

/**
 * Whether a one-shot waits by default on what it did in a 1:1 chat: it leaves with its process, so it stays until that
 * went out or the contact confirmed it. Not on a chat nobody joined yet: there is no one to wait for, and `edit`, `react`,
 * `pin`, a card or a file sat their whole wait (a file 300 s), then failed `timeout`, exit 4, which a bot retries: one
 * more card or file each time. What was done is kept and goes once they join; the answer says so (`keptForJoin`).
 */
export const oneShotWaits = (ctx: ApiContext, chat: string): boolean => ctx.mode === "one-shot" && !nobodyJoinedChat(ctx, chat);

/** An answer's `note` on a chat nobody joined yet: `what` is kept and goes once they join. Nothing on any other chat. */
export const keptForJoin = (ctx: ApiContext, chat: string, what: string): { note?: string } => nobodyJoinedChat(ctx, chat)
  ? { note: `Nobody joined this chat yet: ${what} goes once they join${ctx.mode === "one-shot" ? " while this profile is online (`ghostly daemon --detach`)" : ""}` }
  : {};

/**
 * A chat whose invite nobody took yet has no session to close either: `chat disconnect` answered done with the chat at
 * `connecting`, and `--hold` put the waiting invite on DHT only (a one-shot answered `pairing: error`).
 */
export function somebodyJoined(link: LinkView): void {
  if (nobodyJoined(link)) throw new CliError("unavailable", "Nobody joined this chat yet: its invite is still waiting to be taken");
}

/**
 * A chat whose invite nobody took yet: nobody is there to pay or to dial, and its stage says so. Before, `chat pay`
 * waited 15 s and `chat connect` 25 s for the contact, then answered `engine`. A chat whose invite someone else used
 * first is refused too, with the sentence `send` gives: its contact seals everything to them (`connect` waited 120 s,
 * then answered `timeout`, a code a bot retries).
 */
export function inviteTaken(link: LinkView): void {
  somebodyJoined(link);
  if (link.dhtDelivery?.inviteTaken && link.textDelivery !== "stream") throw new CliError("refused", INVITE_TAKEN);
}

/**
 * A chat on DHT only opens no live session: the engine refused `chat connect` as `engine`, "Both peers must choose a
 * live method first", which read as if this side had to change something. Refused instead, naming whose choice it is
 * (`details.reason`): the contact's (`peer-dht-only`, nothing to do here but wait), or this side's (`dht-only`).
 */
export function dhtOnly(link: LinkView): void {
  if (link.deliveryMode === "dht") throw new CliError("refused", "This chat is on DHT only on this side: choose a live method first (chat transport auto)", { reason: "dht-only" });
  if (link.dhtDelivery?.peerMode === "dht") throw new CliError("refused", "Your contact keeps this chat on DHT only: it goes live once they choose a live method. Short texts still go on the DHT", { reason: "peer-dht-only" });
}

const TRANSPORT_TITLES: Record<PairedTransport, string> = { "webrtc/1": "WebRTC", "iroh/1": "Iroh", "hyperdht/1": "HyperDHT" };

/**
 * A transport the chat's Connection menu offers: one this app runs (on DHT only, one it can start), and the contact's
 * app too, by its last word. `chat transport` took any: toward a contact with no WebRTC (`GHOSTLY_WEBRTC=0`) the choice
 * was kept and the chat stayed where it was, saying nothing; for one this app lacks, the engine answered `engine`,
 * "Transport unavailable". Refused instead, saying whose app lacks it (`details.reason`, as a chat's wait says it).
 */
export function transportOffered(link: LinkView, transport: PairedTransport): void {
  const mine = (link.deliveryMode === "dht" ? link.runnableTransports : undefined) ?? link.availableTransports;
  const title = TRANSPORT_TITLES[transport], error = link.transportErrors?.[transport];
  if (mine && !mine.includes(transport)) throw new CliError("refused", `This app has no ${title} running${error ? `: ${error}` : ""}`, { reason: "app-lacks", transport });
  if (link.peerTransports?.length && !link.peerTransports.includes(transport)) throw new CliError("refused", `Your contact's app doesn't have ${title}: choose another, or auto`, { reason: "contact-lacks", transport });
}

/** A chat or a group as `findChatOrGroup` reads it. `linkId` is what the engine calls it. */
export function chatOrGroup(ctx: ApiContext, ref: string): { id: string; linkId: string; group: boolean } {
  const found = findChatOrGroup(state(ctx).links, state(ctx).groups, ref);
  return "group" in found ? { id: found.group.id, linkId: `group:${found.group.id}`, group: true } : { id: found.link.id, linkId: found.link.id, group: false };
}

/**
 * The group a group command names. A chat's id, key or name says it is a chat, with `twin`, the chat command that takes
 * it (`group send` on a chat, where `send` is meant; `<chat>` stands for the ref), else where the groups are listed.
 * It read "No group" before. A name nothing has stays that error.
 */
export function groupOf(ctx: ApiContext, params: Params, twin?: string): GroupView {
  const ref = str(params, "group", true);
  try { return findGroup(state(ctx).groups, ref); } catch (error) {
    // `group:<ref>` names a group only: never a chat, as in `findChatOrGroup`.
    if (!(error instanceof CliError) || error.code !== "not_found" || groupPrefixed(ref) !== null) throw error;
    let chat: LinkView;
    try { chat = findChat(state(ctx).links, ref); } catch { throw error; }
    const shown = /^[\w.:-]+$/.test(ref) ? ref : JSON.stringify(ref);
    throw new CliError("not_found", `${JSON.stringify(ref)} is a chat, not a group${twin ? `: ghostly ${twin.replace("<chat>", shown)}` : " (ghostly group list)"}`, { chat: chat.id });
  }
}

/**
 * A message of a chat or a group (`group:<id>`) named by its id here, read as one row; only a name that is no such
 * row's key (the id both sides know, `wireId`) reads the whole history. `keep`: only a message it accepts (mine, or
 * someone else's). The history is synchronous work on the daemon's one thread, about 120 ms at 10,000 messages.
 */
export async function messageOf(ctx: ApiContext, linkId: string, ref: string, keep: (message: StoredMessage) => boolean = () => true): Promise<StoredMessage | undefined> {
  const found = await node(ctx).getMessage(linkId, ref);
  if (found && keep(found)) return found;
  const all = linkId.startsWith("group:") ? await node(ctx).groupMessages({ groupId: linkId.slice("group:".length) }) : await node(ctx).getMessages(linkId);
  return all.find((m) => keep(m) && m.wireId === ref);
}

// ---------- waiting ----------

/**
 * Resolves with `check`'s first defined answer: now, or on a later state; `timeout` error after `ms`. A check that
 * throws on a later state (`chat wait`'s chat removed) ends the wait with its error: the hub swallows what its
 * listeners throw, and the wait went on to its timeout.
 *
 * `stopping` (a daemon's `ctx.stopping`): the daemon's stop ends it too, as a timeout with `details.reason:
 * "daemon-stopped"`, for a wait whose command did something (`file send --wait`) and answers with what it knows. A
 * wait that changes nothing is left to its connection's end, and its client asks it again (main.ts `READ_WAITS`).
 */
export function waitForState<T>(ctx: ApiContext, check: (state: EngineState) => T | undefined, ms: number, what: string, stopping?: AbortSignal): Promise<T> {
  const now = check(state(ctx));
  if (now !== undefined) return Promise.resolve(now);
  return new Promise<T>((resolve, reject) => {
    const end = (error: unknown) => { clearTimeout(timer); off(); stopping?.removeEventListener("abort", stopped); if (error) reject(error); };
    const stopped = () => end(new CliError("timeout", `The daemon stopped before the wait ended, waiting for ${what}`, { reason: "daemon-stopped" }));
    const timer = setTimeout(() => end(new CliError("timeout", `Timed out after ${Math.round(ms / 1000)} s waiting for ${what}`)), ms);
    const off = ctx.hub.onState((next) => {
      let value: T | undefined;
      try { value = check(next); } catch (error) { end(error); return; }
      if (value === undefined) return;
      end(null);
      resolve(value);
    });
    if (stopping?.aborted) stopped();
    else stopping?.addEventListener("abort", stopped, { once: true });
  });
}

