import { utf8Encode } from "./bytes";
import { MESSAGE_CLOCK_SKEW_MS } from "./messageTime";
import { sanitizeDisplayText } from "./text";

/*
 * Status cards (WISP 4xx · Status Cards): a bot's task or routine, shown as a small card instead of a text. A card rides
 * as `sc` beside the text of a message on every path that carries text with fields of its own (the live session's
 * `paired-message` and `paired-edit`, a private group's sealed box, a community's payload and its edit frame), and the
 * text is its fallback: what an app without cards, the DHT floor and a held item show. The bot keeps a card current by
 * editing its message; the highest edit number wins, as for any edit, and a card belongs to the version it came with.
 *
 *     {"kind":"task","id":"relay-rotation","title":"Fix relay rotation","status":"running","progress":40,
 *      "step":"Running the e2e","pr":{"url":"https://github.com/o/r/pull/612","number":612,"additions":123,"deletions":45}}
 *
 * Cards are display only: nothing on one runs anything, and its links are https, shown with their host. Every string
 * is one line of plain text without control, invisible or direction characters; every list and number is bounded.
 * `readStatusCard` is the reader's rule (what does not hold is left out, a card that cannot stand is dropped, never the
 * message); `checkStatusCard` is the sender's (anything out of bounds is refused, so nothing is lost silently).
 */

export const STATUS_CARD_LIMITS = {
  /** A card's JSON, as sent (UTF-8 bytes): with the fallback text it stays well inside every message bound. */
  bytes: 8 * 1024,
  /** The sender's id for the card: stable across its updates. */
  id: 64,
  title: 120,
  /** The current step, a list item, a run's summary. */
  line: 200,
  branch: 120,
  schedule: 80,
  cron: 64,
  linkLabel: 40,
  url: 512,
  items: 20,
  links: 4,
  runs: 10,
  /** Any count on a card (a PR's number, lines, files; steps). */
  count: 1_000_000_000,
  /** How far ahead a routine's next run may be. */
  nextRunMs: 366 * 24 * 60 * 60_000,
  /** Edits a message with a card takes (a text takes `MAX_EDITS_PER_MESSAGE`): a bot updates a long task often. */
  edits: 5_000,
  /** Buttons on a message (WISP 4xx · Message Buttons). */
  buttons: 6,
  /** A button's id: what a press names. */
  buttonId: 32,
  /** A button's label, in characters. */
  buttonLabel: 40,
} as const;

/** How a button looks: `primary` is the one highlighted, `danger` warns; `neutral` when none is said. */
export const BUTTON_STYLES = ["primary", "neutral", "danger"] as const;
export type ButtonStyle = typeof BUTTON_STYLES[number];

export const TASK_STATUSES = ["queued", "running", "blocked", "done", "failed", "cancelled"] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
/** A task that is still going: shown first, and counted on the chat's Tasks button. */
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ["queued", "running", "blocked"];
export const ITEM_STATES = ["pending", "running", "done", "failed", "skipped"] as const;
export type ItemState = typeof ITEM_STATES[number];
export const ROUTINE_STATES = ["active", "paused"] as const;
export type RoutineState = typeof ROUTINE_STATES[number];
export const RUN_RESULTS = ["ok", "failed", "skipped"] as const;
export type RunResult = typeof RUN_RESULTS[number];

export interface CardLink { url: string; label?: string }
export interface TaskItem { text: string; state: ItemState }
export interface TaskPr { url: string; number?: number; additions?: number; deletions?: number; files?: number }

export interface TaskCard {
  kind: "task";
  id: string;
  title: string;
  status: TaskStatus;
  /** 0 to 100. */
  progress?: number;
  /** Steps done of `total`. */
  done?: number;
  total?: number;
  /** What it is doing now. */
  step?: string;
  pr?: TaskPr;
  branch?: string;
  startedAt?: number;
  updatedAt?: number;
  items?: TaskItem[];
  links?: CardLink[];
}

export interface RoutineRun { at: number; result: RunResult; summary?: string }

export interface RoutineCard {
  kind: "routine";
  id: string;
  name: string;
  /** When it runs, as people say it ("every day 01:00"). */
  schedule: string;
  cron?: string;
  state: RoutineState;
  lastRun?: RoutineRun;
  nextRunAt?: number;
  /** Recent runs, newest first. */
  runs?: RoutineRun[];
  links?: CardLink[];
}

/**
 * A button under a bot's message (WISP 4xx · Message Buttons). `once`: a press on it answers the question for that
 * person, and their app offers none of the buttons again; a button without it may be pressed again.
 */
export interface CardButton { id: string; label: string; style?: ButtonStyle; once?: true }

/**
 * Buttons under a bot's message (WISP 4xx · Message Buttons): unlike a task or a routine, the message's text shows
 * with them, and is also what an app without buttons shows (so it should say how to answer in words). `chosen` is the
 * answer the bot took, marked for everyone; `closed`: no button takes a press any more.
 */
export interface ButtonsCard {
  kind: "buttons";
  id: string;
  buttons: CardButton[];
  chosen?: string;
  closed?: true;
}

export type StatusCard = TaskCard | RoutineCard | ButtonsCard;
export type StatusCardKind = StatusCard["kind"];

const ID = /^[A-Za-z0-9_.:][A-Za-z0-9_.:-]{0,63}$/;
/** A button's id: 1 to 32 of `A-Z a-z 0-9 _ . : -`, not starting with `-`. */
export const BUTTON_ID = /^[A-Za-z0-9_.:][A-Za-z0-9_.:-]{0,31}$/;
const CRON = /^[0-9A-Za-z*,/?#\- ]{1,64}$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** One line of display text: runs of space (line breaks included) become one space, then the display rules for names. */
export function cardLine(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return sanitizeDisplayText(value.replace(/\s+/gu, " "), max);
}

/**
 * An https link a card may show: no credentials, a host, no spaces or control characters, at most
 * `STATUS_CARD_LIMITS.url` characters. Returned as the parser writes it (a non-ASCII host in punycode).
 */
export function cardUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > STATUS_CARD_LIMITS.url || /[\s\p{Cc}\p{Cf}]/u.test(value)) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return undefined;
  return url.href.length <= STATUS_CARD_LIMITS.url ? url.href : undefined;
}

/** The host a card shows beside a link, so the reader sees where it goes before following it. */
export function cardLinkHost(url: string): string {
  try { return new URL(url).host; } catch { return ""; }
}

const count = (value: unknown, min = 0): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= STATUS_CARD_LIMITS.count ? value : undefined;

/** A time on a card as a reader keeps it: a positive whole number, never later than `latest`. */
const time = (value: unknown, latest: number): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? Math.min(value, latest) : undefined;

const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined =>
  typeof value === "string" && (values as readonly string[]).includes(value) ? value as T : undefined;

function readLinks(raw: unknown): CardLink[] {
  if (!Array.isArray(raw)) return [];
  const links: CardLink[] = [];
  for (const entry of raw.slice(0, STATUS_CARD_LIMITS.links)) {
    if (!isObject(entry)) continue;
    const url = cardUrl(entry.url);
    if (!url) continue;
    const label = cardLine(entry.label, STATUS_CARD_LIMITS.linkLabel);
    links.push({ url, ...(label && { label }) });
  }
  return links;
}

function readRun(raw: unknown, now: number): RoutineRun | undefined {
  if (!isObject(raw)) return undefined;
  const at = time(raw.at, now + MESSAGE_CLOCK_SKEW_MS), result = oneOf(RUN_RESULTS, raw.result);
  if (!at || !result) return undefined;
  const summary = cardLine(raw.summary, STATUS_CARD_LIMITS.line);
  return { at, result, ...(summary && { summary }) };
}

/** The bytes a card takes on the wire: what `STATUS_CARD_LIMITS.bytes` bounds. */
export function statusCardBytes(card: unknown): number {
  try { return utf8Encode(JSON.stringify(card) ?? "").length; } catch { return Infinity; }
}

/**
 * A card as a reader takes it from the wire (`sc`), or undefined when it cannot stand: not an object, past
 * `STATUS_CARD_LIMITS.bytes`, a kind this app does not know, no valid id, title or name, status or state. Fields that do
 * not hold are left out and lists are cut to their bound; times are kept no later than the reader's clock allows (a
 * routine's next run up to a year ahead). The message is always kept: without a card it shows its text.
 */
export function readStatusCard(raw: unknown, now = Date.now()): StatusCard | undefined {
  if (!isObject(raw) || statusCardBytes(raw) > STATUS_CARD_LIMITS.bytes) return undefined;
  const id = typeof raw.id === "string" && ID.test(raw.id) ? raw.id : undefined;
  if (!id) return undefined;
  const latest = now + MESSAGE_CLOCK_SKEW_MS;
  const links = readLinks(raw.links);
  if (raw.kind === "task") {
    const title = cardLine(raw.title, STATUS_CARD_LIMITS.title), status = oneOf(TASK_STATUSES, raw.status);
    if (!title || !status) return undefined;
    const progress = typeof raw.progress === "number" && Number.isFinite(raw.progress) ? Math.round(Math.min(100, Math.max(0, raw.progress))) : undefined;
    let done = count(raw.done), total = count(raw.total, 1);
    if (done === undefined || total === undefined || done > total) done = total = undefined;
    const step = cardLine(raw.step, STATUS_CARD_LIMITS.line), branch = cardLine(raw.branch, STATUS_CARD_LIMITS.branch);
    let pr: TaskPr | undefined;
    if (isObject(raw.pr)) {
      const url = cardUrl(raw.pr.url);
      if (url) {
        const number = count(raw.pr.number, 1), additions = count(raw.pr.additions), deletions = count(raw.pr.deletions), files = count(raw.pr.files);
        pr = { url, ...(number !== undefined && { number }), ...(additions !== undefined && { additions }), ...(deletions !== undefined && { deletions }), ...(files !== undefined && { files }) };
      }
    }
    const items: TaskItem[] = [];
    if (Array.isArray(raw.items)) for (const entry of raw.items.slice(0, STATUS_CARD_LIMITS.items)) {
      if (!isObject(entry)) continue;
      const text = cardLine(entry.text, STATUS_CARD_LIMITS.line);
      if (text) items.push({ text, state: oneOf(ITEM_STATES, entry.state) ?? "pending" });
    }
    const startedAt = time(raw.startedAt, latest), updatedAt = time(raw.updatedAt, latest);
    return {
      kind: "task", id, title, status,
      ...(progress !== undefined && { progress }), ...(done !== undefined && total !== undefined && { done, total }),
      ...(step && { step }), ...(pr && { pr }), ...(branch && { branch }),
      ...(startedAt && { startedAt }), ...(updatedAt && { updatedAt }),
      ...(items.length && { items }), ...(links.length && { links }),
    };
  }
  if (raw.kind === "routine") {
    const name = cardLine(raw.name, STATUS_CARD_LIMITS.title), schedule = cardLine(raw.schedule, STATUS_CARD_LIMITS.schedule), state = oneOf(ROUTINE_STATES, raw.state);
    if (!name || !schedule || !state) return undefined;
    const cron = typeof raw.cron === "string" && CRON.test(raw.cron.trim()) ? raw.cron.trim() : undefined;
    const lastRun = readRun(raw.lastRun, now);
    const nextRunAt = typeof raw.nextRunAt === "number" && Number.isSafeInteger(raw.nextRunAt) && raw.nextRunAt > 0 && raw.nextRunAt <= now + STATUS_CARD_LIMITS.nextRunMs ? raw.nextRunAt : undefined;
    const runs: RoutineRun[] = [];
    if (Array.isArray(raw.runs)) for (const entry of raw.runs.slice(0, STATUS_CARD_LIMITS.runs)) {
      const run = readRun(entry, now);
      if (run) runs.push(run);
    }
    return {
      kind: "routine", id, name, schedule, state,
      ...(cron && { cron }), ...(lastRun && { lastRun }), ...(nextRunAt && { nextRunAt }),
      ...(runs.length && { runs }), ...(links.length && { links }),
    };
  }
  if (raw.kind === "buttons") {
    if (!Array.isArray(raw.buttons)) return undefined;
    const buttons: CardButton[] = [], seen = new Set<string>();
    for (const entry of raw.buttons.slice(0, STATUS_CARD_LIMITS.buttons)) {
      if (!isObject(entry) || typeof entry.id !== "string" || !BUTTON_ID.test(entry.id) || seen.has(entry.id)) continue;
      const label = cardLine(entry.label, STATUS_CARD_LIMITS.buttonLabel);
      if (!label) continue;
      seen.add(entry.id);
      const style = oneOf(BUTTON_STYLES, entry.style);
      buttons.push({ id: entry.id, label, ...(style && style !== "neutral" && { style }), ...(entry.once === true && { once: true as const }) });
    }
    if (!buttons.length) return undefined;
    const chosen = typeof raw.chosen === "string" && seen.has(raw.chosen) ? raw.chosen : undefined;
    return { kind: "buttons", id, buttons, ...(chosen && { chosen }), ...(raw.closed === true && { closed: true as const }) };
  }
  return undefined;
}

/**
 * A card as a sender may send it, or why not: the reader's rule, but anything it would leave out or cut is refused
 * here instead (an unknown status, a link that is not https, a list past its bound, a line too long), so a bot learns
 * at once and nothing it said is lost on the way. Line breaks and invisible characters are cleaned, as a reader would.
 */
export function checkStatusCard(raw: unknown, now = Date.now()): { card: StatusCard } | { error: string } {
  if (!isObject(raw)) return { error: "A card is an object" };
  const bytes = statusCardBytes(raw);
  if (bytes > STATUS_CARD_LIMITS.bytes) return { error: `The card takes ${bytes} bytes; at most ${STATUS_CARD_LIMITS.bytes}` };
  if (raw.kind !== "task" && raw.kind !== "routine" && raw.kind !== "buttons") return { error: "kind is task, routine or buttons" };
  if (typeof raw.id !== "string" || !ID.test(raw.id)) return { error: `id is 1 to ${STATUS_CARD_LIMITS.id} of A-Z a-z 0-9 _ . : - and does not start with -` };
  const line = (field: string, value: unknown, max: number, required = false): string | null => {
    if (value === undefined && !required) return null;
    if (typeof value !== "string" || !cardLine(value, Infinity)) return `${field} is text`;
    if ([...cardLine(value, Infinity)!].length > max) return `${field} is at most ${max} characters`;
    return null;
  };
  const url = (field: string, value: unknown) => (cardUrl(value) ? null : `${field} must be an https link of at most ${STATUS_CARD_LIMITS.url} characters`);
  const whole = (field: string, value: unknown, min = 0) => (value === undefined || count(value, min) !== undefined ? null : `${field} is a whole number from ${min}`);
  const errors: (string | null)[] = [];
  if (raw.links !== undefined) {
    if (!Array.isArray(raw.links) || raw.links.length > STATUS_CARD_LIMITS.links) errors.push(`links is a list of at most ${STATUS_CARD_LIMITS.links}`);
    else for (const [i, link] of raw.links.entries()) {
      if (!isObject(link)) { errors.push(`links[${i}] is an object`); continue; }
      errors.push(url(`links[${i}].url`, link.url), line(`links[${i}].label`, link.label, STATUS_CARD_LIMITS.linkLabel));
    }
  }
  if (raw.kind === "buttons") {
    if (raw.links !== undefined) errors.push("buttons take no links");
    if (!Array.isArray(raw.buttons) || !raw.buttons.length || raw.buttons.length > STATUS_CARD_LIMITS.buttons) errors.push(`buttons is a list of 1 to ${STATUS_CARD_LIMITS.buttons}`);
    else {
      const ids = new Set<string>();
      for (const [i, button] of raw.buttons.entries()) {
        if (!isObject(button)) { errors.push(`buttons[${i}] is an object`); continue; }
        if (typeof button.id !== "string" || !BUTTON_ID.test(button.id)) errors.push(`buttons[${i}].id is 1 to ${STATUS_CARD_LIMITS.buttonId} of A-Z a-z 0-9 _ . : - and does not start with -`);
        else if (ids.has(button.id)) errors.push(`buttons[${i}].id "${button.id}" is used twice`);
        else ids.add(button.id);
        errors.push(line(`buttons[${i}].label`, button.label, STATUS_CARD_LIMITS.buttonLabel, true));
        if (button.style !== undefined && !oneOf(BUTTON_STYLES, button.style)) errors.push(`buttons[${i}].style is one of ${BUTTON_STYLES.join(", ")}`);
        if (button.once !== undefined && button.once !== true) errors.push(`buttons[${i}].once is true or left out`);
      }
      if (raw.chosen !== undefined && !(typeof raw.chosen === "string" && ids.has(raw.chosen))) errors.push("chosen names one of the buttons");
    }
    if (raw.closed !== undefined && raw.closed !== true) errors.push("closed is true or left out");
  } else if (raw.kind === "task") {
    errors.push(line("title", raw.title, STATUS_CARD_LIMITS.title, true));
    if (!oneOf(TASK_STATUSES, raw.status)) errors.push(`status is one of ${TASK_STATUSES.join(", ")}`);
    if (raw.progress !== undefined && !(typeof raw.progress === "number" && Number.isFinite(raw.progress) && raw.progress >= 0 && raw.progress <= 100)) errors.push("progress is a number from 0 to 100");
    if ((raw.done === undefined) !== (raw.total === undefined)) errors.push("done and total go together");
    else if (raw.done !== undefined) {
      errors.push(whole("done", raw.done), whole("total", raw.total, 1));
      if (typeof raw.done === "number" && typeof raw.total === "number" && raw.done > raw.total) errors.push("done is at most total");
    }
    errors.push(line("step", raw.step, STATUS_CARD_LIMITS.line), line("branch", raw.branch, STATUS_CARD_LIMITS.branch));
    if (raw.pr !== undefined) {
      if (!isObject(raw.pr)) errors.push("pr is an object");
      else errors.push(url("pr.url", raw.pr.url), whole("pr.number", raw.pr.number, 1), whole("pr.additions", raw.pr.additions), whole("pr.deletions", raw.pr.deletions), whole("pr.files", raw.pr.files));
    }
    for (const field of ["startedAt", "updatedAt"] as const) {
      const value = raw[field];
      if (value !== undefined && !(typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= now + MESSAGE_CLOCK_SKEW_MS)) errors.push(`${field} is a time in milliseconds, not in the future`);
    }
    if (raw.items !== undefined) {
      if (!Array.isArray(raw.items) || raw.items.length > STATUS_CARD_LIMITS.items) errors.push(`items is a list of at most ${STATUS_CARD_LIMITS.items}`);
      else for (const [i, item] of raw.items.entries()) {
        if (!isObject(item)) { errors.push(`items[${i}] is an object`); continue; }
        errors.push(line(`items[${i}].text`, item.text, STATUS_CARD_LIMITS.line, true));
        if (item.state !== undefined && !oneOf(ITEM_STATES, item.state)) errors.push(`items[${i}].state is one of ${ITEM_STATES.join(", ")}`);
      }
    }
  } else {
    errors.push(line("name", raw.name, STATUS_CARD_LIMITS.title, true), line("schedule", raw.schedule, STATUS_CARD_LIMITS.schedule, true));
    if (!oneOf(ROUTINE_STATES, raw.state)) errors.push(`state is one of ${ROUTINE_STATES.join(", ")}`);
    if (raw.cron !== undefined && !(typeof raw.cron === "string" && CRON.test(raw.cron.trim()))) errors.push(`cron is a cron line of at most ${STATUS_CARD_LIMITS.cron} characters`);
    if (raw.nextRunAt !== undefined && !(typeof raw.nextRunAt === "number" && Number.isSafeInteger(raw.nextRunAt) && raw.nextRunAt > 0 && raw.nextRunAt <= now + STATUS_CARD_LIMITS.nextRunMs)) errors.push("nextRunAt is a time in milliseconds, within a year");
    const run = (field: string, value: unknown) => {
      if (!isObject(value)) return errors.push(`${field} is an object`);
      if (!(typeof value.at === "number" && Number.isSafeInteger(value.at) && value.at > 0 && value.at <= now + MESSAGE_CLOCK_SKEW_MS)) errors.push(`${field}.at is a time in milliseconds, not in the future`);
      if (!oneOf(RUN_RESULTS, value.result)) errors.push(`${field}.result is one of ${RUN_RESULTS.join(", ")}`);
      errors.push(line(`${field}.summary`, value.summary, STATUS_CARD_LIMITS.line));
    };
    if (raw.lastRun !== undefined) run("lastRun", raw.lastRun);
    if (raw.runs !== undefined) {
      if (!Array.isArray(raw.runs) || raw.runs.length > STATUS_CARD_LIMITS.runs) errors.push(`runs is a list of at most ${STATUS_CARD_LIMITS.runs}`);
      else raw.runs.forEach((entry, i) => run(`runs[${i}]`, entry));
    }
  }
  const error = errors.find((e): e is string => typeof e === "string");
  if (error) return { error };
  const card = readStatusCard(raw, now);
  return card ? { card } : { error: "The card does not hold" };
}

/** The progress a task shows, 0 to 100: its own, else its steps done of total; undefined when it says neither. */
export function taskProgress(card: Pick<TaskCard, "progress" | "done" | "total">): number | undefined {
  if (card.progress !== undefined) return card.progress;
  return card.done !== undefined && card.total ? Math.round(card.done / card.total * 100) : undefined;
}

const TASK_MARK: Record<TaskStatus, string> = { queued: "⏳", running: "🔄", blocked: "⛔", done: "✅", failed: "❌", cancelled: "🚫" };
const STATUS_WORD: Record<TaskStatus, string> = { queued: "Queued", running: "Running", blocked: "Blocked", done: "Done", failed: "Failed", cancelled: "Cancelled" };
const RESULT_WORD: Record<RunResult, string> = { ok: "ok", failed: "failed", skipped: "skipped" };

/** A time as the fallback text says it: in UTC, to the minute ("2026-09-30 01:00 UTC"). */
export function cardTimeUtc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * The text a card's message carries: what an app without cards shows, the DHT floor carries, the chat list previews
 * and search finds. Plain lines, the first naming the card, no bars or layout that would read badly elsewhere.
 */
export function statusCardText(card: StatusCard): string {
  // Buttons show with the bot's own text; this is only what goes when it gave none.
  if (card.kind === "buttons") return `Reply: ${card.buttons.map(b => b.label).join(" / ")}`;
  if (card.kind === "task") {
    const progress = taskProgress(card);
    const state = [STATUS_WORD[card.status], ...(progress !== undefined ? [`${progress}%`] : []), ...(card.done !== undefined && card.total ? [`${card.done} of ${card.total} steps`] : [])].join(" · ");
    const pr = card.pr && [`PR${card.pr.number !== undefined ? ` #${card.pr.number}` : ""}`,
      ...(card.pr.additions !== undefined || card.pr.deletions !== undefined ? [`+${card.pr.additions ?? 0} -${card.pr.deletions ?? 0}`] : [])].join(" ") + `: ${card.pr.url}`;
    // "Now:" only while the task is going: a finished one's last step is not what it does now (the card hides it too).
    const now = card.step && ACTIVE_TASK_STATUSES.includes(card.status) ? [`Now: ${card.step}`] : [];
    return [`${TASK_MARK[card.status]} ${card.title}`, state, ...now, ...(pr ? [pr] : [])].join("\n");
  }
  const last = card.lastRun && `Last run: ${RESULT_WORD[card.lastRun.result]}, ${cardTimeUtc(card.lastRun.at)}${card.lastRun.summary ? ` · ${card.lastRun.summary}` : ""}`;
  return [`🔁 ${card.name}`, `${card.schedule} · ${card.state === "active" ? "active" : "paused"}`, ...(last ? [last] : []),
    ...(card.nextRunAt && card.state === "active" ? [`Next run: ${cardTimeUtc(card.nextRunAt)}`] : [])].join("\n");
}

/** Whether a message's edit number holds: a text's bound, or a card message's when the edit carries a card. */
export function cardEditNumber(e: unknown): e is number {
  return Number.isSafeInteger(e) && (e as number) >= 1 && (e as number) <= STATUS_CARD_LIMITS.edits;
}
