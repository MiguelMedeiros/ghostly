import { type Command, here } from "./shared";

/** The profile's status, its picture, the event journal: one entry per command, in alphabetical order (test/commands.test.ts checks). */
export const commands: Record<string, Command> = {
  "events": {
    method: "events.replay", usage: "events [--since seq]", summary: "Events the journal holds, without following",
    options: { since: { type: "number", description: "Only events after this seq" } }, params: ({ options }) => ({ since: options.since ?? 0 }),
  },
  "profile picture": {
    method: "profile.picture", usage: "profile picture <jpeg> | --clear", summary: "The picture contacts see (a square JPEG, 128 px is what the app sends)", args: ["path..."],
    options: { clear: { type: "boolean", description: "Remove the picture" } },
    params: ({ options }, a) => ({ path: here(a.path), clear: options.clear === true }),
  },
  "status": { method: "status", usage: "status", summary: "The profile, its chats and whether a daemon runs it" },
};
