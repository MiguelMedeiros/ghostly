import { createHash } from "node:crypto";
import { chatOrGroup, groupOf, node, type ApiContext, type Params } from "./apiKit";

/**
 * The id an agent turn names its message by (docs/CLI.md § Agent turns). A message is stored under an id its sender
 * chose most of (`peer_<the id they sent>`), so a turn carries this one instead, made here from the chat (or group) and
 * that id: `t_` and 32 hex digits, in which nobody can write a word. Every command that takes a message's id takes it.
 */
export function turnRef(where: string, messageId: string): string {
  return "t_" + createHash("sha256").update(`${where}\n${messageId}`).digest("hex").slice(0, 32);
}

const TURN_REF = /^t_[0-9a-f]{32}$/;
const isRef = (value: unknown): value is string => typeof value === "string" && TURN_REF.test(value);

/** How many turns' ids, older than the newest page, a profile's daemon keeps the answer for. */
const REMEMBERED = 1000;
/**
 * Per node, `<chat or group>\n<turn's id>` → the id its message is stored under, or null for none: what reading a whole
 * history found, so the reply, reaction and pin of one old turn read it once, and a turn whose message was deleted for
 * everyone (never stored again) once at all. Oldest asked first out.
 */
const remembered = new WeakMap<object, Map<string, string | null>>();
/**
 * Per node, the same for the newest messages of the last whole histories read, kept apart so that one read never pushes
 * out a turn that was asked for: an agent catching up answers one old turn after another, and each of them read the whole
 * history again (1,000 turns at 50,000 messages: 50 million hashes). Oldest read first out.
 */
const newestRead = new WeakMap<object, Map<string, string>>();
const mapOf = <V>(maps: WeakMap<object, Map<string, V>>, owner: object) => {
  let map = maps.get(owner);
  if (!map) maps.set(owner, map = new Map());
  return map;
};
const trim = (map: Map<string, unknown>) => { while (map.size > REMEMBERED) map.delete(map.keys().next().value!); };

/**
 * `params` with each turn's id in `message`, `reply`, `messages`, `before` and `after` as the id its message is stored
 * under: looked for among the chat's (or group's) newest messages first, where a turn's almost always is, then in what an
 * earlier read of all of them found, then in all of them. One that names no message stays as given, and its command says
 * so as for any unknown id. A timestamp in `before` or `after` is no turn's id and stays as it is.
 */
export async function withStoredIds(ctx: ApiContext, params: Params): Promise<Params> {
  const wanted = new Set([params.message, params.reply, params.before, params.after, ...(Array.isArray(params.messages) ? params.messages : [])].filter(isRef));
  if (!wanted.size) return params;
  let target: { id: string; linkId: string; group: boolean } | null = null;
  try {
    if (typeof params.group === "string") { const group = groupOf(ctx, { group: params.group }); target = { id: group.id, linkId: `group:${group.id}`, group: true }; }
    else if (typeof params.chat === "string") target = chatOrGroup(ctx, params.chat);
  } catch { /* the command says what is wrong with its chat or group */ }
  if (!target) return params;
  const { id, linkId, group } = target;
  const found = new Map<string, string>();
  const look = (messages: readonly { id: string }[]) => {
    for (const message of messages) { const ref = turnRef(id, message.id); if (wanted.has(ref)) found.set(ref, message.id); }
    return found.size === wanted.size;
  };
  if (!look((await node(ctx).messagePage({ linkId, limit: 200 })).messages)) {
    const known = mapOf(remembered, node(ctx)), bulk = mapOf(newestRead, node(ctx));
    const unknown = new Set<string>();
    for (const ref of wanted) {
      if (found.has(ref)) continue;
      const key = `${id}\n${ref}`, kept = known.has(key) ? known.get(key) : bulk.get(key);
      if (kept === undefined) { unknown.add(ref); continue; }
      known.delete(key);
      bulk.delete(key);
      // Deleted since: it names none now (and its refusal names the turn's id, not the one its sender chose).
      const now = kept !== null && await node(ctx).getMessage(linkId, kept) ? kept : null;
      known.set(key, now);
      if (now !== null) found.set(ref, now);
    }
    if (unknown.size) {
      const all = group ? await node(ctx).groupMessages({ groupId: id }) : await node(ctx).getMessages(linkId);
      const newest = all.length - REMEMBERED;
      all.forEach((message, at) => {
        const ref = turnRef(id, message.id);
        if (wanted.has(ref)) found.set(ref, message.id);
        else if (at >= newest) { const key = `${id}\n${ref}`; bulk.delete(key); bulk.set(key, message.id); }
      });
      for (const ref of unknown) known.set(`${id}\n${ref}`, found.get(ref) ?? null);
    }
    trim(known);
    trim(bulk);
  }
  const stored = (value: unknown) => (isRef(value) ? found.get(value) ?? value : value);
  return {
    ...params,
    ...(params.message !== undefined && { message: stored(params.message) }),
    ...(params.reply !== undefined && { reply: stored(params.reply) }),
    ...(params.before !== undefined && { before: stored(params.before) }),
    ...(params.after !== undefined && { after: stored(params.after) }),
    ...(Array.isArray(params.messages) && { messages: params.messages.map(stored) }),
  };
}
