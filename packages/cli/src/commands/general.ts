import { STATUS_AVAILABILITIES } from "@ghostly/core";
import { STATUS_CARD_LIMITS } from "@ghostly/core/statusCards";
import { CliError } from "../errors";
import { checkOwnStatus } from "../ownStatus";
import { type Command, CARD_TIME_FORMS, cardTime, force, here, since, translate } from "./shared";

/** `--until 30m`, `2h`, `1d`: that long from now. */
const DURATION = /^(\d+)(m|h|d)$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/**
 * `status set --until`: a time to come, as long from now (30m, 2h, 1d) or as a card's time is written (milliseconds or a
 * date, local time when it names no zone), within a year. A time past is refused: the engine would take it as no status.
 */
function statusUntil(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim(), duration = DURATION.exec(text);
  const ms = duration ? Date.now() + Number(duration[1]) * UNIT_MS[duration[2] as keyof typeof UNIT_MS] : cardTime(text, "until")!;
  if (duration && !(ms <= Date.now() + STATUS_CARD_LIMITS.nextRunMs)) throw new CliError("usage", `--until takes a time within a year from now, not ${JSON.stringify(value)}`);
  if (ms <= Date.now()) throw new CliError("usage", `--until takes a time to come, not ${JSON.stringify(value)}: a status that ended is none`);
  return ms;
}

/** The profile's status, its picture, the event journal: one entry per command, in alphabetical order (test/commands.test.ts checks). */
export const commands: Record<string, Command> = {
  "events": {
    method: "events.replay", usage: "events [--since seq] [--translate lang]", summary: "Events the journal holds, without following",
    options: { since: { type: "number", description: "Only events after this seq" }, translate }, params: ({ options }) => ({ since: since(options) ?? 0 }),
  },
  "profile picture": {
    method: "profile.picture", usage: "profile picture <jpeg> | --clear", summary: "The picture contacts see (a square JPEG, 128 px is what the app sends)", args: ["path...?"],
    options: { clear: { type: "boolean", description: "Remove the picture" } },
    params: ({ options }, a) => {
      if (!a.path && options.clear !== true) throw new CliError("usage", "Missing <jpeg>: ghostly profile picture <jpeg> | --clear");
      if (a.path && options.clear === true) throw new CliError("usage", "--clear removes the picture: not with a <jpeg>");
      return { path: here(a.path || undefined), clear: options.clear === true };
    },
  },
  "status": { method: "status", usage: "status", summary: "The profile, its chats and whether a daemon runs it" },
  "status clear": { method: "status.clear", usage: "status clear", summary: "Take back the status contacts see (status set)" },
  "status set": {
    method: "status.set", usage: `status set [text...] [--emoji <emoji>] [--availability ${STATUS_AVAILABILITIES.join("|")}] [--until <time>] [--force]`,
    summary: "The status paired contacts see: a short text, one emoji, available, busy, away or dnd (Do not disturb), until a time; it replaces the one before",
    args: ["text...?"],
    options: {
      emoji: { type: "string", description: "One emoji, shown before the text" },
      availability: { type: "string", choices: STATUS_AVAILABILITIES, description: "available, busy, away or dnd (Do not disturb)" },
      until: { type: "string", description: `When it ends by itself, within a year: 30m, 2h or 1d from now, or milliseconds or a date: ${CARD_TIME_FORMS}` },
      force: { ...force, description: "Set a text that looks like a seed, a key or ecash" },
    },
    // Checked here, before the profile opens, as the engine keeps it: a usage error that names the option.
    params: ({ options }, a) => {
      const input = { text: a.text, emoji: options.emoji as string | undefined, availability: options.availability as string | undefined, until: statusUntil(options.until) };
      const status = checkOwnStatus(input, (field) => (field === "text" ? "<text>" : `--${field}`), "usage");
      return { ...status, ...(options.force === true && { force: true }) };
    },
  },
  "status show": { method: "status.get", usage: "status show", summary: "This profile's status (status set), or null when it has none" },
};
