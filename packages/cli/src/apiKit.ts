import type { GhostlyNode } from "@ghostly/browser/engine/node";
import type { EngineState, GroupView, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { CliError } from "./errors";
import type { CallManager } from "./calls/manager";
import type { EventHub } from "./events";
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
  /** How the host runs: a daemon stays; a one-shot leaves when its command is done. */
  mode: "daemon" | "one-shot";
  version: string;
  /** The daemon asks to stop (answered first). */
  stop?: () => void;
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
export function oneOf<T extends string>(params: Params, name: string, values: readonly T[], fallback: T): T {
  const value = str(params, name) ?? fallback;
  if (!values.includes(value as T)) throw new CliError("bad_request", `${name} must be one of ${values.join(", ")}`);
  return value as T;
}

// ---------- finding things ----------

/** A contact key as chats show it (`peer`): 52 characters of z-base-32. */
export const CONTACT_KEY = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;

/**
 * A chat by its id; by its contact's key (only by the key: a name is never taken for one); by a unique prefix of its
 * id; or by its name: the label this side gave it first, and only when no label matches, the name the contact gave
 * itself (which the contact controls, so it never wins over a label).
 */
export function findChat(links: readonly LinkView[], ref: string): LinkView {
  return chatBy(links, ref).link;
}

/** `findChat`, and whether only the name the contact gave itself (`theirName`) found the chat. */
function chatBy(links: readonly LinkView[], ref: string): { link: LinkView; theirName: boolean } {
  const exact = links.find((link) => link.id === ref);
  if (exact) return { link: exact, theirName: false };
  if (CONTACT_KEY.test(ref)) {
    const byKey = links.filter((link) => link.peerPubKeyZ32 === ref);
    if (byKey.length === 1) return { link: byKey[0], theirName: false };
    if (byKey.length > 1) throw new CliError("bad_request", `${JSON.stringify(ref)} names more than one chat: use its id`, { matches: byKey.map((link) => link.id) });
    throw new CliError("not_found", `No chat with ${JSON.stringify(ref)}`);
  }
  const byPrefix = links.filter((link) => link.id.startsWith(ref));
  if (byPrefix.length === 1) return { link: byPrefix[0], theirName: false };
  const lower = ref.toLowerCase();
  const named = (name: string | null | undefined) => name?.trim().toLowerCase() === lower;
  const byLabel = links.filter((link) => named(link.label));
  const byName = byLabel.length ? byLabel : links.filter((link) => named(link.peerNick));
  if (byName.length === 1) return { link: byName[0], theirName: !byLabel.length };
  if (byPrefix.length > 1 || byName.length > 1) throw new CliError("bad_request", `${JSON.stringify(ref)} names more than one chat: use its id`, { matches: [...byPrefix, ...byName].map((link) => link.id) });
  throw new CliError("not_found", `No chat ${JSON.stringify(ref)}`);
}

/** Only an invitation so far: this profile is not in the group (yet), and whoever invited chose its name. */
const invitedOnly = (group: GroupView) => group.status === undefined && !!group.invitation;

/**
 * A group by its id, by a unique prefix of its id, or by its name. A group this profile is in wins over an invitation
 * with the same prefix or name (the one who invites chooses those); an invitation is still found by its id, and by
 * prefix or name where no group of this profile has it.
 */
export function findGroup(groups: readonly GroupView[], ref: string): GroupView {
  const exact = groups.find((group) => group.id === ref);
  if (exact) return exact;
  const mineFirst = (found: GroupView[]) => { const mine = found.filter((group) => !invitedOnly(group)); return mine.length ? mine : found; };
  const byPrefix = mineFirst(groups.filter((group) => group.id.startsWith(ref)));
  if (byPrefix.length === 1) return byPrefix[0];
  const byName = mineFirst(groups.filter((group) => group.name.trim().toLowerCase() === ref.toLowerCase()));
  if (byName.length === 1) return byName[0];
  if (byPrefix.length > 1 || byName.length > 1) throw new CliError("bad_request", `${JSON.stringify(ref)} names more than one group: use its id`, { matches: [...byPrefix, ...byName].map((group) => group.id) });
  throw new CliError("not_found", `No group ${JSON.stringify(ref)}`);
}

/**
 * A chat or a group, where a command takes either: `group:<id>` is a group; anything else a chat first (`findChat`),
 * then a group. A chat found only by the name its contact gave itself never takes what also names a group: a group's
 * own id is that group, and a prefix or the name of a group this profile is in is refused, with both ids. With neither,
 * one `not_found` names both and where to look (a contact's key: no chat with it); a name that matches more than one
 * chat or group stays that error.
 */
export function findChatOrGroup(links: readonly LinkView[], groups: readonly GroupView[], ref: string): { link: LinkView } | { group: GroupView } {
  if (ref.startsWith("group:")) return { group: findGroup(groups, ref.slice("group:".length)) };
  let chat: ReturnType<typeof chatBy>;
  try {
    chat = chatBy(links, ref);
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== "not_found") throw error;
    try { return { group: findGroup(groups, ref) }; } catch (inner) {
      if (!(inner instanceof CliError) || inner.code !== "not_found") throw inner;
      if (CONTACT_KEY.test(ref)) throw error;
      throw new CliError("not_found", `No chat or group ${JSON.stringify(ref)} (ghostly chat list, ghostly group list)`);
    }
  }
  if (!chat.theirName) return { link: chat.link };
  const exact = groups.find((group) => group.id === ref);
  if (exact) return { group: exact };
  const lower = ref.toLowerCase();
  const also = groups.filter((group) => !invitedOnly(group) && (group.id.startsWith(ref) || group.name.trim().toLowerCase() === lower));
  if (also.length) throw new CliError("bad_request", `${JSON.stringify(ref)} names a chat (the name its contact chose) and a group: use the chat's id or group:<id>`, { chat: chat.link.id, groups: also.map((group) => group.id) });
  return { link: chat.link };
}

export const chatOf = (ctx: ApiContext, params: Params) => findChat(state(ctx).links, str(params, "chat", true));

/**
 * A chat whose invite nobody took yet: nobody is there to pay or to dial, and its stage says so. Before, `chat pay`
 * waited 15 s and `chat connect` 25 s for the contact, then answered `engine`.
 */
export function inviteTaken(link: LinkView): void {
  if (link.profile && link.inviteCode && !link.peerParticipationKey) throw new CliError("unavailable", "Nobody joined this chat yet: its invite is still waiting to be taken");
}

/** A chat or a group as `findChatOrGroup` reads it. `linkId` is what the engine calls it. */
export function chatOrGroup(ctx: ApiContext, ref: string): { id: string; linkId: string; group: boolean } {
  const found = findChatOrGroup(state(ctx).links, state(ctx).groups, ref);
  return "group" in found ? { id: found.group.id, linkId: `group:${found.group.id}`, group: true } : { id: found.link.id, linkId: found.link.id, group: false };
}

export const groupOf = (ctx: ApiContext, params: Params) => findGroup(state(ctx).groups, str(params, "group", true));

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

/** Resolves with `check`'s first defined answer: now, or on a later state; `timeout` error after `ms`. */
export function waitForState<T>(ctx: ApiContext, check: (state: EngineState) => T | undefined, ms: number, what: string): Promise<T> {
  const now = check(state(ctx));
  if (now !== undefined) return Promise.resolve(now);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new CliError("timeout", `Timed out after ${Math.round(ms / 1000)} s waiting for ${what}`)); }, ms);
    const off = ctx.hub.onState((next) => {
      const value = check(next);
      if (value === undefined) return;
      clearTimeout(timer);
      off();
      resolve(value);
    });
  });
}

