import { describe, expect, it, vi } from "vitest";
import type { EngineState, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { parseArgs } from "../src/args";
import { COMMANDS, idSlot, positionals } from "../src/commands";

// covers: headless.cli

/** A command line as main.ts reads it: its options and positionals, then the method's parameters. */
function params(name: string, argv: string[]): Record<string, unknown> {
  const command = COMMANDS[name]!;
  const parsed = parseArgs(argv, command.options ?? {}, idSlot(command));
  return command.params!(parsed, positionals(command, parsed.positionals));
}

const SECONDS = 1791849403;
const usage = (message: RegExp) => expect.objectContaining({ code: "usage", message: expect.stringMatching(message) });

/**
 * A time flag given in seconds (`$(date +%s)`) is refused and the milliseconds suggested: before, `--next` and
 * `--resets` sent cards dated January 1970, and `--before`/`--after` answered an empty page or the whole history.
 */
describe("a time given in seconds", () => {
  it("is refused by --next, --resets and --also, with the milliseconds to give", () => {
    expect(() => params("routine send", ["g1", "--name", "Backup", "--schedule", "every hour", "--next", String(SECONDS)])).toThrow(usage(new RegExp(`^--next takes milliseconds, not seconds: ${SECONDS}000$`)));
    expect(() => params("routine update", ["g1", "backup", "--next", String(SECONDS)])).toThrow(usage(/^--next takes milliseconds/));
    expect(() => params("usage send", ["Miguel", "--left", "50", "--resets", String(SECONDS)])).toThrow(usage(new RegExp(`^--resets takes milliseconds, not seconds: ${SECONDS}000$`)));
    expect(() => params("usage send", ["Miguel", "--left", "50", "--also", `week=80@${SECONDS}`])).toThrow(usage(/^--also takes milliseconds/));
  });

  it("is refused by --before and --after of chat history and group history", () => {
    for (const [name, flag] of [["chat history", "before"], ["chat history", "after"], ["group history", "before"], ["group history", "after"]] as const) {
      expect(() => params(name, ["c1", `--${flag}`, String(SECONDS)]), `${name} --${flag}`).toThrow(usage(new RegExp(`^--${flag} takes milliseconds, not seconds: ${SECONDS}000$`)));
    }
  });

  it("leaves milliseconds and dates as they were", () => {
    const ms = SECONDS * 1000;
    expect(params("routine send", ["g1", "--name", "Backup", "--schedule", "every hour", "--next", String(ms)])).toMatchObject({ card: { nextRunAt: ms } });
    expect(params("usage send", ["Miguel", "--left", "50", "--resets", "2026-10-07T18:00:00Z"])).toMatchObject({ card: { resetsAt: Date.UTC(2026, 9, 7, 18) } });
    expect(params("chat history", ["c1", "--before", String(ms)])).toMatchObject({ before: ms });
    expect(params("chat history", ["c1", "--after", "me_1700000000000"])).toMatchObject({ after: "me_1700000000000" });
    expect(params("group history", ["g1", "--before", "abc:3:7"])).toMatchObject({ before: "abc:3:7" });
  });
});

/** A short number after --before/--after is a time, never a message id: no id is all digits. */
describe("a history cursor under ten digits", () => {
  it("is a time: --after 0 is the whole history, not \"No message 0\"", async () => {
    expect(params("chat history", ["c1", "--after", "0"])).toMatchObject({ after: 0 });
    expect(params("chat history", ["c1", "--after", "1000"])).toMatchObject({ after: 1000 });
    expect(params("group history", ["g1", "--after", "0"])).toMatchObject({ after: 0 });
    expect(params("chat history", ["c1", "--before", "0"])).toMatchObject({ before: 0 });

    const rows = [1, 2, 3].map((n) => ({ linkId: "c1", id: `me_${n}`, text: `m${n}`, sender: "me", timestamp: n * 1000, via: "datalink" }) as StoredMessage);
    const link = { id: "c1", peerPubKeyZ32: "pc1", label: "Ana", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", pairing: { status: "ready" } } as unknown as LinkView;
    const node = { getState: () => ({ links: [link], groups: [], settings: {}, transport: {} }) as unknown as EngineState, getMessages: vi.fn(async () => rows) };
    const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
    const ids = async (after: string) => ((await callApi(ctx, "chat.history", params("chat history", ["Ana", "--after", after]))) as { messages: { id: string }[] }).messages.map((m) => m.id);
    expect(await ids("0")).toEqual(["me_1", "me_2", "me_3"]);
    expect(await ids("1000")).toEqual(["me_2", "me_3"]);
  });
});
