import { STATUS_CARD_LIMITS, checkStatusCard, randomBytes, toBase64Url, type StatusCard } from "@ghostly/core";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import { chatOrGroup, node, num, oneOf, str, type ApiContext, type Method, type Params } from "./apiKit";
import { CliError } from "./errors";
import { waitForEdit, waitForGroupFrame, waitForMessage } from "./waits";

/*
 * Status cards (WISP 4xx · Status Cards): a bot's task or routine, sent as a message with a card and kept current by
 * editing it. A routine's run (`run`) becomes its last run and the newest of its recent runs.
 * The engine checks every card by the sender's rule and writes its fallback text; this is the bot's side of it: a card
 * built from flags or JSON, found again by its id, merged with an update, and paced, one update per card every
 * `CARD_UPDATE_GAP_MS`. An update that comes sooner is merged into the next one, which goes when the time is up.
 */

/** A card's updates go at most this often: the rest merge into the next, so a chatty bot spends few edits. */
export const CARD_UPDATE_GAP_MS = 2_500;

type Kind = StatusCard["kind"];
type Target = { id: string; linkId: string; group: boolean };

/** Per card (its message): when its last update went, what waits to go next, and how to send it now. */
interface Pace { last: number; next?: Record<string, unknown>; timer?: ReturnType<typeof setTimeout>; flushed?: Promise<void>; flush?: () => void }
const paces = new WeakMap<ApiContext, Map<string, Pace>>();

function paceOf(ctx: ApiContext, key: string): Pace {
  let map = paces.get(ctx);
  if (!map) paces.set(ctx, (map = new Map()));
  let pace = map.get(key);
  if (!pace) map.set(key, (pace = { last: 0 }));
  return pace;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The fields a command gave: an object, or a usage error that says so. */
function fieldsOf(params: Params): Record<string, unknown> {
  const fields = params.card ?? {};
  if (!isObject(fields)) throw new CliError("bad_request", "card must be an object of the card's fields");
  return fields;
}

/**
 * An update merged over a card: fields given replace those there, `pr` field by field, and a field given as null goes
 * (`--json '{"step":null}'`). The kind and the id never change.
 */
export function mergeCard(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "kind" || key === "id") continue;
    if (value === null) { delete out[key]; continue; }
    if (key === "pr" && isObject(value) && isObject(base.pr)) {
      const pr: Record<string, unknown> = { ...base.pr };
      for (const [k, v] of Object.entries(value)) { if (v === null) delete pr[k]; else pr[k] = v; }
      out.pr = pr;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * A routine's run from the command (`run: {result, summary?}`), as its last run and the first of its recent runs,
 * `STATUS_CARD_LIMITS.runs` kept. Undefined when the command names none.
 */
export function withRun(fields: Record<string, unknown>, params: Params, now = Date.now()): Record<string, unknown> {
  const run = params.run;
  if (run === undefined) return fields;
  if (!isObject(run) || typeof run.result !== "string") throw new CliError("bad_request", "run is {result: ok|failed|skipped, summary?}");
  const lastRun = { at: now, result: run.result, ...(typeof run.summary === "string" && run.summary ? { summary: run.summary } : {}) };
  const before = Array.isArray(fields.runs) ? fields.runs : [];
  return { ...fields, lastRun, runs: [lastRun, ...before].slice(0, STATUS_CARD_LIMITS.runs) };
}

/** A card checked by the sender's rule, or a `bad_request` that says what is wrong. */
function checked(card: Record<string, unknown>): StatusCard {
  const result = checkStatusCard(card);
  if ("error" in result) throw new CliError("bad_request", `Status card: ${result.error}`, { card });
  return result.card;
}

/** The latest message of mine in this chat or group with a card of this kind and id: the one an update edits. */
async function cardMessage(ctx: ApiContext, target: Target, kind: Kind, id: string): Promise<StoredMessage> {
  const messages = target.group ? await node(ctx).groupMessages({ groupId: target.id }) : await node(ctx).getMessages(target.linkId);
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.sender === "me" && message.card?.kind === kind && message.card.id === id) return message;
  }
  throw new CliError("not_found", `No ${kind} ${JSON.stringify(id)} of yours in this ${target.group ? "group" : "chat"}: send it first with ghostly ${kind} send`);
}

function answer(target: Target, kind: Kind, id: string, messageId: string, extra: Record<string, unknown>): Record<string, unknown> {
  return { [target.group ? "group" : "chat"]: target.id, [kind]: id, messageId, ...extra };
}

/** A new card: a message whose text is written from it, in a chat or a group. */
async function sendCard(ctx: ApiContext, params: Params, kind: Kind): Promise<Record<string, unknown>> {
  const target = chatOrGroup(ctx, str(params, "chat", true));
  const fields = fieldsOf(params);
  const now = Date.now();
  const id = typeof fields.id === "string" && fields.id ? fields.id : `${kind}-${toBase64Url(randomBytes(6))}`;
  const card = checked(withRun({
    ...(kind === "task" ? { status: "running", startedAt: now, updatedAt: now } : { state: "active" }),
    ...fields, kind, id,
  }, params, now));
  const text = str(params, "text") ?? "";
  const wait = oneOf(params, "wait", target.group ? ["none", "sent"] as const : ["none", "sent", "delivered"] as const, "none");
  const ms = num(params, "timeout", 30, { min: 1, max: 3600 }) * 1000;
  if (target.group) {
    const result = await node(ctx).sendGroupMessage({ groupId: target.id, text, card });
    if (result.error || !result.messageId) throw new CliError("unavailable", result.error ?? "Nothing to send");
    const edges = wait === "sent" ? await waitForGroupFrame(ctx, target.id, result.messageId, undefined, ms) : undefined;
    return answer(target, kind, id, result.messageId, { card, ...(edges !== undefined && { edges }) });
  }
  const result = await node(ctx).sendMessage({ linkId: target.linkId, text, card });
  if (result.error) throw new CliError(result.refused ? "refused" : "unavailable", result.error);
  if (!result.messageId) throw new CliError("bad_request", "Nothing to send");
  let message = (await node(ctx).getMessages(target.linkId)).find((m) => m.id === result.messageId);
  if (wait !== "none") message = await waitForMessage(ctx, target.linkId, result.messageId, wait, ms);
  return answer(target, kind, id, result.messageId, { card, delivery: message?.delivery ?? null });
}

/** Edits the card's message with its merged card, now. */
async function editCard(ctx: ApiContext, target: Target, messageId: string, card: StatusCard, text: string): Promise<void> {
  const result = await node(ctx).editMessage({ linkId: target.linkId, messageId, text, card });
  if (result.error) throw new CliError(result.refused ? "refused" : "unavailable", result.error);
}

/**
 * An update of a card of mine: the fields given, merged over its latest state (what waits to go included). It goes at
 * once when the card's last update is `CARD_UPDATE_GAP_MS` old; otherwise it waits for that, merged with any update
 * that comes meanwhile (`queued: true`). A one-shot command waits the time out itself: it has no daemon to wait in.
 */
async function updateCard(ctx: ApiContext, params: Params, kind: Kind): Promise<Record<string, unknown>> {
  const target = chatOrGroup(ctx, str(params, "chat", true));
  const id = str(params, kind, true);
  const patch = fieldsOf(params);
  const message = await cardMessage(ctx, target, kind, id);
  // A card message takes `STATUS_CARD_LIMITS.edits` updates (WISP 4xx · Status Cards); past them, a new card goes on.
  if ((message.edit?.seq ?? 0) >= STATUS_CARD_LIMITS.edits)
    throw new CliError("refused", `This ${kind}'s message took ${STATUS_CARD_LIMITS.edits} updates, the most one takes: start a new card with ghostly ${kind} send (a new --id, or the same one: the newest card of an id stands for it)`, { messageId: message.id, edits: message.edit!.seq });
  const pace = paceOf(ctx, `${target.linkId}\n${message.id}`);
  const base = pace.next ?? (message.card as unknown as Record<string, unknown>);
  const merged = withRun(mergeCard(base, { ...patch, ...(kind === "task" && { updatedAt: Date.now() }) }), params);
  const card = checked(merged);
  const text = str(params, "text") ?? "";
  const wait = oneOf(params, "wait", target.group ? ["none", "sent"] as const : ["none", "confirmed"] as const, "none");
  const ms = num(params, "timeout", 30, { min: 1, max: 3600 }) * 1000;
  const last = Math.max(pace.last, message.edit?.at ?? message.timestamp);
  const due = last + CARD_UPDATE_GAP_MS - Date.now();
  let queued = false;
  if (due > 0 && ctx.mode === "daemon") {
    // Merged into what goes next; the first update in the gap sets the timer, the later ones only change what it sends.
    pace.next = card as unknown as Record<string, unknown>;
    queued = true;
    if (!pace.timer) pace.flushed = new Promise<void>((resolve) => {
      const send = () => {
        const next = pace.next;
        clearTimeout(pace.timer);
        pace.timer = undefined; pace.next = undefined; pace.flush = undefined; pace.last = Date.now();
        void (next ? editCard(ctx, target, message.id, next as unknown as StatusCard, text) : Promise.resolve()).catch(() => {}).finally(resolve);
      };
      pace.flush = send;
      pace.timer = setTimeout(send, due);
    });
    if (wait !== "none") await pace.flushed;
  } else {
    if (due > 0) await new Promise((resolve) => setTimeout(resolve, due));
    pace.last = Date.now();
    await editCard(ctx, target, message.id, card, text);
  }
  let edited = target.group ? (await node(ctx).groupMessages({ groupId: target.id })).find((m) => m.id === message.id) : (await node(ctx).getMessages(target.linkId)).find((m) => m.id === message.id);
  if (wait === "confirmed" && edited?.edit?.pending) edited = await waitForEdit(ctx, target.linkId, message.id, ms);
  const edges = wait === "sent" && edited?.edit ? await waitForGroupFrame(ctx, target.id, message.id, edited.edit.seq, ms) : undefined;
  return answer(target, kind, id, message.id, {
    card, queued, edits: edited?.edit?.seq ?? 0,
    // An update still waiting for its time went nowhere yet: it is not confirmed, whatever the message's last edit says.
    ...(target.group ? { ...(edges !== undefined && { edges }) } : { confirmed: (!queued || wait !== "none") && !!edited && !edited.edit?.pending }),
  });
}

/**
 * Sends now every update still waiting for its time: the daemon is stopping, and the update it answered `queued` for
 * (often a task's last one, done or failed) would otherwise go with it, leaving the card running for good. Called
 * while the engine can still store the edit; it goes to the contact as any edit does, now or once they are back.
 */
export async function flushCardUpdates(ctx: ApiContext): Promise<void> {
  const waiting = [...(paces.get(ctx)?.values() ?? [])].filter((pace) => pace.flush);
  for (const pace of waiting) pace.flush!();
  await Promise.all(waiting.map((pace) => pace.flushed));
}

export const STATUS_CARD_METHODS: Record<string, Method> = {
  /** WISP 4xx · Status Cards: a task card in a chat or a group; the answer names the task's id and its message. */
  "task.send": (ctx, params) => sendCard(ctx, params, "task"),
  /** A task's update: the fields given, merged over its latest state, paced one per `CARD_UPDATE_GAP_MS`. */
  "task.update": (ctx, params) => updateCard(ctx, params, "task"),
  /** A routine card (its schedule, state, runs); `run` records one. */
  "routine.send": (ctx, params) => sendCard(ctx, params, "routine"),
  /** A routine's update, as a task's; `run` records a run as its last and the newest of its recent ones. */
  "routine.update": (ctx, params) => updateCard(ctx, params, "routine"),
};
