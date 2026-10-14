import { createHash } from "node:crypto";
import { chatOrGroup, findGroup, node, state, type ApiContext, type Params } from "./apiKit";

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

/**
 * `params` with each turn's id in `message`, `reply` and `messages` as the id its message is stored under: looked for
 * among the chat's (or group's) newest messages first, where a turn's almost always is, then in all of them. One that
 * names no message stays as given, and its command says so as for any unknown id.
 */
export async function withStoredIds(ctx: ApiContext, params: Params): Promise<Params> {
  const wanted = new Set([params.message, params.reply, ...(Array.isArray(params.messages) ? params.messages : [])].filter(isRef));
  if (!wanted.size) return params;
  let target: { id: string; linkId: string; group: boolean } | null = null;
  try {
    if (typeof params.group === "string") { const group = findGroup(state(ctx).groups, params.group); target = { id: group.id, linkId: `group:${group.id}`, group: true }; }
    else if (typeof params.chat === "string") target = chatOrGroup(ctx, params.chat);
  } catch { /* the command says what is wrong with its chat or group */ }
  if (!target) return params;
  const { id, linkId, group } = target;
  const found = new Map<string, string>();
  const look = (messages: readonly { id: string }[]) => {
    for (const message of messages) { const ref = turnRef(id, message.id); if (wanted.has(ref)) found.set(ref, message.id); }
    return found.size === wanted.size;
  };
  if (!look((await node(ctx).messagePage({ linkId, limit: 200 })).messages)) look(group ? await node(ctx).groupMessages({ groupId: id }) : await node(ctx).getMessages(linkId));
  const stored = (value: unknown) => (isRef(value) ? found.get(value) ?? value : value);
  return {
    ...params,
    ...(params.message !== undefined && { message: stored(params.message) }),
    ...(params.reply !== undefined && { reply: stored(params.reply) }),
    ...(Array.isArray(params.messages) && { messages: params.messages.map(stored) }),
  };
}
