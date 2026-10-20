import { STATUS_CARD_LIMITS, cardLine, checkStatusCard, randomBytes, toBase64Url, type StatusCard } from "@ghostly/core";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import { findSecret } from "../../../apps/ui/src/lib/parse/secrets";
import { bool, chatOrGroup, node, num, oneOf, state, str, type ApiContext, type Method, type Params } from "./apiKit";
import { CliError, asCliError } from "./errors";
import { waitForEdit, waitForGroupFrame, waitForMessage } from "./waits";

/*
 * Status cards (WISP 405 · Status Cards): a bot's task or routine, sent as a message with a card and kept current by
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

/** Every text in a card's fields (title, step, items, runs, links…), as the contact's app may show it. */
function cardTexts(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) cardTexts(item, out);
  else if (isObject(value)) for (const item of Object.values(value)) cardTexts(item, out);
  return out;
}

/**
 * The first text in `value` (a card's fields, a message's text…) that looks like a seed, a private key or a Cashu token,
 * read as given and as a card carries it (`cardLine`).
 */
export function secretIn(value: unknown): ReturnType<typeof findSecret> {
  for (const text of cardTexts(value)) {
    const secret = findSecret(text) ?? findSecret(cardLine(text, Infinity) ?? "");
    if (secret) return secret;
  }
  return null;
}

/**
 * The secret guard `send` has (docs/CLI.md § Safety): a card whose text looks like a seed, a private key or a Cashu
 * token goes only with `--force`. `fields` are what this command gives (an update's own, not the card it merges over).
 * A card's text is read as given and as the card carries it (`cardLine`): a line loses its invisible characters on the
 * way, so a key one of them broke in two is whole again on the card. The fallback text goes as it is, as `send`'s.
 */
function guardSecrets(fields: unknown, params: Params, verb: string): void {
  if (bool(params, "force")) return;
  const check = (text: string) => {
    const secret = findSecret(text);
    if (secret) throw new CliError("confirm", `The card's text looks like ${secret.kind === "cashu" ? "a Cashu token (money anyone who reads it can take)" : "a secret (a seed or a private key)"}; ${verb} it with --force if you mean to`, { kind: secret.kind });
  };
  for (const text of cardTexts([fields, params.run])) { check(text); check(cardLine(text, Infinity) ?? ""); }
  if (typeof params.text === "string") check(params.text);
}

/** How many cards a process remembers the message of; one past them is found in the history again. */
export const CARDS_REMEMBERED = 1_000;

/** Per card (its chat or group, its kind and its id): the message of mine that carries it, as this process last saw it. */
const carriers = new WeakMap<ApiContext, Map<string, string>>();
const carrierKey = (linkId: string, kind: string, id: string) => `${linkId}\n${kind}\n${id}`;

function carriersOf(ctx: ApiContext): Map<string, string> {
  let map = carriers.get(ctx);
  if (map) return map;
  carriers.set(ctx, (map = new Map()));
  const cards = map;
  // A newer card of mine stands for its id from the moment it is stored, whoever sent it (`engine call` too).
  ctx.hub.onEvent((event) => {
    if (event.type !== "message.sent" && event.type !== "group.sent") return;
    const message = event.message as { id?: unknown; card?: { kind?: unknown; id?: unknown } } | undefined;
    const card = message?.card;
    if (typeof message?.id !== "string" || typeof card?.id !== "string" || (card.kind !== "task" && card.kind !== "routine" && card.kind !== "usage")) return;
    carried(cards, carrierKey(event.type === "group.sent" ? `group:${String(event.group)}` : String(event.chat), card.kind, card.id), message.id);
  });
  return map;
}

function carried(cards: Map<string, string>, key: string, messageId: string): void {
  cards.delete(key);
  cards.set(key, messageId);
  if (cards.size > CARDS_REMEMBERED) cards.delete(cards.keys().next().value!);
}

/**
 * The latest message of mine in this chat or group with a card of this kind and id: the one an update edits. A card
 * this process sent or found before is read by its message's key, so its updates cost the same in a long chat as in a
 * short one; only a card not seen yet (the first update after a start, a one-shot) is looked for in the whole history.
 */
async function cardMessage(ctx: ApiContext, target: Target, kind: Kind, id: string): Promise<StoredMessage> {
  const cards = carriersOf(ctx), key = carrierKey(target.linkId, kind, id);
  const carries = (message: StoredMessage | undefined): message is StoredMessage => message?.sender === "me" && message.card?.kind === kind && message.card.id === id;
  const known = cards.get(key);
  if (known !== undefined) {
    const message = await node(ctx).getMessage(target.linkId, known);
    if (carries(message)) return message;
    // Deleted since, or it carries another card now: the history says which message stands for the id.
    cards.delete(key);
  }
  const messages = target.group ? await node(ctx).groupMessages({ groupId: target.id }) : await node(ctx).getMessages(target.linkId);
  // A card stored while the history was read is newer than what was read: that one stands for the id.
  if (cards.has(key)) return cardMessage(ctx, target, kind, id);
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (!carries(message)) continue;
    carried(cards, key, message.id);
    return message;
  }
  throw new CliError("not_found", `No ${kind} ${JSON.stringify(id)} of yours in this ${target.group ? "group" : "chat"}: send it first with ghostly ${kind} send`);
}

function answer(target: Target, kind: Kind, id: string, messageId: string, extra: Record<string, unknown>): Record<string, unknown> {
  return { [target.group ? "group" : "chat"]: target.id, [kind]: id, messageId, ...extra };
}

/**
 * A task's parent is another task of mine in the same chat or group (WISP 405 · Status Cards § A task): one that is
 * not there is refused here, with its name, rather than sent to stand alone on every board (a reader keeps the field
 * and shows the task ungrouped). Send the parent first.
 */
async function parentThere(ctx: ApiContext, target: Target, card: StatusCard): Promise<void> {
  if (card.kind !== "task" || !card.parent) return;
  const parent = card.parent;
  await cardMessage(ctx, target, "task", parent).catch(() => {
    throw new CliError("not_found", `--parent: no task ${JSON.stringify(parent)} of yours in this ${target.group ? "group" : "chat"}: send the parent first`);
  });
}

/** A new card: a message whose text is written from it, in a chat or a group. */
async function sendCard(ctx: ApiContext, params: Params, kind: Kind): Promise<Record<string, unknown>> {
  const target = chatOrGroup(ctx, str(params, "chat", true));
  const fields = fieldsOf(params);
  guardSecrets(fields, params, "send");
  const now = Date.now();
  const id = typeof fields.id === "string" && fields.id ? fields.id : `${kind}-${toBase64Url(randomBytes(6))}`;
  const card = checked(withRun({
    ...(kind === "task" ? { status: "running", startedAt: now, updatedAt: now } : kind === "routine" ? { state: "active" } : {}),
    ...fields, kind, id,
  }, params, now));
  await parentThere(ctx, target, card);
  const text = str(params, "text") ?? "";
  const wait = oneOf(params, "wait", target.group ? ["none", "sent"] as const : ["none", "sent", "delivered"] as const, "none");
  const ms = num(params, "timeout", 30, { min: 1, max: 3600 }) * 1000;
  if (target.group) {
    const result = await node(ctx).sendGroupMessage({ groupId: target.id, text, card });
    if (result.error || !result.messageId) throw new CliError(result.refused ? "refused" : "unavailable", result.error ?? "Nothing to send");
    carried(carriersOf(ctx), carrierKey(target.linkId, kind, id), result.messageId);
    const edges = wait === "sent" ? await waitForGroupFrame(ctx, target.id, result.messageId, undefined, ms) : undefined;
    return answer(target, kind, id, result.messageId, { card, ...(edges !== undefined && { edges }) });
  }
  const result = await node(ctx).sendMessage({ linkId: target.linkId, text, card });
  if (result.error) throw new CliError(result.refused ? "refused" : "unavailable", result.error);
  if (!result.messageId) throw new CliError("bad_request", "Nothing to send");
  carried(carriersOf(ctx), carrierKey(target.linkId, kind, id), result.messageId);
  let message = await node(ctx).getMessage(target.linkId, result.messageId);
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
  guardSecrets(patch, params, "update");
  const message = await cardMessage(ctx, target, kind, id);
  // A card message takes `STATUS_CARD_LIMITS.edits` updates (WISP 405 · Status Cards); past them, a new card goes on.
  if ((message.edit?.seq ?? 0) >= STATUS_CARD_LIMITS.edits)
    throw new CliError("refused", `This ${kind}'s message took ${STATUS_CARD_LIMITS.edits} updates, the most one takes: start a new card with ghostly ${kind} send (a new --id, or the same one: the newest card of an id stands for it)`, { messageId: message.id, edits: message.edit!.seq });
  const pace = paceOf(ctx, `${target.linkId}\n${message.id}`);
  const base = pace.next ?? (message.card as unknown as Record<string, unknown>);
  const merged = withRun(mergeCard(base, { ...patch, ...(kind === "task" && { updatedAt: Date.now() }) }), params);
  const card = checked(merged);
  if (isObject(patch) && patch.parent !== undefined) await parentThere(ctx, target, card);
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
  let edited = await node(ctx).getMessage(target.linkId, message.id);
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

/** A usage card's fields: all of them are said again by each report, so one not given goes from the card. */
const USAGE_FIELDS = ["left", "used", "limit", "label", "account", "window", "resetsAt", "updatedAt", "windows"] as const;

/** The id a bot's usage card goes by when it names none: one live card per chat. */
export const USAGE_CARD_ID = "usage";

/**
 * One chat's usage report (WISP 405 § Usage): the bot's usage card there, kept as one message. The first report sends
 * it; every later one edits it in place (quiet: no sound, no unread, no move in the list), paced as a task's updates.
 * A report is whole: what it does not say goes from the card. A card at its edits' cap gives way to a new message.
 */
async function reportUsage(ctx: ApiContext, ref: string, fields: Record<string, unknown>, params: Params): Promise<Record<string, unknown>> {
  const target = chatOrGroup(ctx, ref);
  const id = typeof fields.id === "string" && fields.id ? fields.id : USAGE_CARD_ID;
  const report = { updatedAt: Date.now(), ...fields, kind: "usage", id };
  checked(report);
  const sent = await cardMessage(ctx, target, "usage", id).catch(() => undefined);
  const wait = oneOf(params, "wait", ["none", "sent"] as const, "none");
  if (!sent || (sent.edit?.seq ?? 0) >= STATUS_CARD_LIMITS.edits) {
    const answer = await sendCard(ctx, { ...params, chat: ref, card: report, wait }, "usage");
    return { ...answer, updated: false };
  }
  const patch: Record<string, unknown> = {};
  for (const key of USAGE_FIELDS) patch[key] = report[key as keyof typeof report] ?? null;
  const answer = await updateCard(ctx, { ...params, chat: ref, usage: id, card: patch, wait: wait === "none" ? "none" : target.group ? "sent" : "confirmed" }, "usage");
  return { ...answer, updated: true };
}

/**
 * `usage send`: one chat or group, or (`all`) every 1:1 chat with a contact; a chat that refuses is said (its
 * `{code, message}`), not fatal, unless every chat refused: then nothing was reported and the call fails.
 */
async function sendUsage(ctx: ApiContext, params: Params): Promise<Record<string, unknown>> {
  const fields = fieldsOf(params);
  if (!bool(params, "all")) return reportUsage(ctx, str(params, "chat", true), fields, params);
  if (str(params, "chat")) throw new CliError("bad_request", "Name a chat or --all, not both");
  checked({ updatedAt: Date.now(), ...fields, kind: "usage", id: typeof fields.id === "string" && fields.id ? fields.id : USAGE_CARD_ID });
  // The person's mistake, said once: before, each chat refused it on its own and the call still answered.
  oneOf(params, "wait", ["none", "sent"] as const, "none");
  num(params, "timeout", 30, { min: 1, max: 3600 });
  const chats = state(ctx).links.filter((link) => link.profile && link.peerPubKeyZ32);
  const results: Record<string, unknown>[] = [];
  const failed: { chat: string; error: CliError }[] = [];
  for (const link of chats) {
    try { results.push(await reportUsage(ctx, link.id, fields, params)); }
    catch (error) {
      const refusal = { chat: link.id, error: asCliError(error) };
      failed.push(refusal);
      results.push({ chat: link.id, error: refusal.error.toJSON() });
    }
  }
  if (failed.length && failed.length === chats.length) {
    const codes = new Set(failed.map((f) => f.error.code));
    throw new CliError(codes.size === 1 ? failed[0]!.error.code : "refused", `No chat took the usage card: ${failed.map((f) => `${f.chat}: ${f.error.message}`).join("; ")}`, { chats: results });
  }
  return { chats: results };
}

export const STATUS_CARD_METHODS: Record<string, Method> = {
  /** WISP 405 · Status Cards: a task card in a chat or a group; the answer names the task's id and its message. */
  "task.send": (ctx, params) => sendCard(ctx, params, "task"),
  /** A task's update: the fields given, merged over its latest state, paced one per `CARD_UPDATE_GAP_MS`. */
  "task.update": (ctx, params) => updateCard(ctx, params, "task"),
  /** A routine card (its schedule, state, runs); `run` records one. */
  "routine.send": (ctx, params) => sendCard(ctx, params, "routine"),
  /** A routine's update, as a task's; `run` records a run as its last and the newest of its recent ones. */
  "routine.update": (ctx, params) => updateCard(ctx, params, "routine"),
  /** WISP 405 § Usage: how much of a quota the bot has left, kept as one card per chat; `all` for every 1:1 chat. */
  "usage.send": sendUsage,
};
