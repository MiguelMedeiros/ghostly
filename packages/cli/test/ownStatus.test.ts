import { afterAll, describe, expect, it, vi } from "vitest";
import type { EngineState } from "@ghostly/browser/shared/types";
import type { PersonStatus } from "@ghostly/core";
import { callApi, type ApiContext } from "../src/api";
import { parseArgs } from "../src/args";
import { COMMANDS, idSlot, positionals, takesText } from "../src/commands";
import { CARD_TIME_FORMS } from "../src/commands/shared";
import { error, ghostly, home, ok, Running } from "./support/cli";
// covers: headless.cli

/** `status set|clear|show`: this profile's status (WISP 401 § Presence and status), beside plain `status`. */

const line = (...argv: string[]) => {
  const spec = COMMANDS["status set"], parsed = parseArgs(argv, spec.options ?? {}, idSlot(spec), { command: "status set", text: takesText(spec) });
  return spec.params!(parsed, positionals(spec, parsed.positionals));
};
const usage = (...argv: string[]) => {
  try { line(...argv); } catch (e) { expect(e).toMatchObject({ code: "usage" }); return (e as Error).message; }
  throw new Error(`taken: ${argv.join(" ")}`);
};

describe("status set's line", () => {
  it("takes a text, one emoji, an availability and an end, as the engine keeps them", () => {
    const before = Date.now();
    const params = line("At", "lunch", "--emoji", "🍕", "--availability", "busy", "--until", "30m");
    expect(params).toMatchObject({ text: "At lunch", emoji: "🍕", availability: "busy" });
    expect(params.until).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(params.until).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
    // One line, as contacts see it; an availability alone, or an emoji alone, is a status too.
    expect(line("in\na  call ")).toEqual({ text: "in a call" });
    expect(line("--availability", "dnd")).toEqual({ availability: "dnd" });
    expect(line("--emoji", "❤")).toEqual({ emoji: "❤️" });
    expect(line("Away", "--force")).toEqual({ text: "Away", force: true });
    // A date, or milliseconds, as a card's time is written.
    const at = new Date(Date.now() + 10 * 86_400_000).toISOString(), ms = Date.now() + 60_000;
    expect(line("Off", "--until", at).until).toBe(Date.parse(at));
    expect(line("Off", "--until", String(ms)).until).toBe(ms);
  });

  it("refuses what the engine would cut or drop, before the profile opens, naming the option (exit 2)", () => {
    expect(usage("x".repeat(61))).toBe("<text> is up to 60 characters, not 61 characters");
    // Emoji count as one character each, invisible ones not at all.
    expect(line(`${"x".repeat(58)}👻👻`).text).toBe(`${"x".repeat(58)}👻👻`);
    expect(line(`${"x".repeat(60)}\u200b`).text).toBe("x".repeat(60));
    // A text that fits is kept whole however much invisible padding it has: it was cut to 240 raw units first (48 kept).
    const padded = Array.from({ length: 50 }, (_, i) => `${String.fromCharCode(97 + (i % 26))}\u200b\u200b\u200b\u200b`).join("");
    expect(line(padded).text).toBe(padded.replaceAll("\u200b", ""));
    expect(usage("see", "https://example.com")).toBe("<text> is plain text: no link or markup");
    expect(usage("\u200b")).toBe("<text> needs a character that shows");
    expect(usage("hi", "--emoji", "ab")).toBe('--emoji takes one emoji, not "ab"');
    expect(usage("hi", "--emoji", "🍕🍕")).toBe('--emoji takes one emoji, not "🍕🍕"');
    expect(usage("hi", "--availability", "lunch")).toMatch(/^--availability takes available, busy, away or dnd, not "lunch"/);
    expect(usage("hi", "--until", "2020-01-01")).toBe('--until takes a time to come, not "2020-01-01": a status that ended is none');
    expect(usage("hi", "--until", "0m")).toMatch(/^--until takes a time to come/);
    expect(usage("hi", "--until", "400d")).toBe('--until takes a time within a year from now, not "400d"');
    // A time it cannot read names every form it takes, as its help does: before, only milliseconds and dates.
    for (const until of ["soon", "2y", "30s", "1.5h", "-1h"]) {
      expect(usage("hi", "--until", until)).toBe(`--until takes 30m, 2h or 1d from now (whole minutes, hours or days), milliseconds or a date: ${CARD_TIME_FORMS}, not ${JSON.stringify(until)}`);
    }
    expect(usage()).toBe("Nothing to set: give a <text>, --emoji or --availability");
    expect(usage("--until", "1h")).toBe("Nothing to set: give a <text>, --emoji or --availability");
  });
});

function fake(initial?: PersonStatus) {
  let own = initial;
  const node = {
    getState: () => ({ links: [], groups: [], settings: {}, transport: {} }) as unknown as EngineState,
    setOwnStatus: vi.fn(async ({ status }: { status: PersonStatus }) => { own = status; }),
    clearOwnStatus: vi.fn(async () => { own = undefined; }),
    getOwnStatus: vi.fn(() => ({ ...(own ? { status: own } : {}), sharePresence: true })),
    setPresence: vi.fn(),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node };
}

describe("the socket's status.set|clear|get", () => {
  it("sets, shows and clears through the engine, answering every field, and never says presence", async () => {
    const { ctx, node } = fake();
    expect(await callApi(ctx, "status.get", {})).toEqual({ status: null });
    const until = Date.now() + 60_000;
    const set = { status: { text: "At lunch", emoji: "🍕", availability: "busy", until } };
    expect(await callApi(ctx, "status.set", { text: "At lunch", emoji: "🍕", availability: "busy", until })).toEqual(set);
    expect(node.setOwnStatus).toHaveBeenLastCalledWith({ status: { text: "At lunch", emoji: "🍕", availability: "busy", until } });
    expect(await callApi(ctx, "status.get", {})).toEqual(set);
    // A new one replaces it whole: what it leaves out is null.
    expect(await callApi(ctx, "status.set", { text: "Back" })).toEqual({ status: { text: "Back", emoji: null, availability: null, until: null } });
    expect(await callApi(ctx, "status.clear", {})).toEqual({ status: null });
    expect(node.clearOwnStatus).toHaveBeenCalledOnce();
    expect(node.setPresence).not.toHaveBeenCalled();
  });

  it("refuses a bad parameter as bad_request named by it, and a secret unless force", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "status.set", { text: "x".repeat(61) })).rejects.toMatchObject({ code: "bad_request", message: "text is up to 60 characters, not 61 characters" });
    await expect(callApi(ctx, "status.set", { text: "hi", emoji: "a" })).rejects.toMatchObject({ code: "bad_request", message: 'emoji takes one emoji, not "a"' });
    await expect(callApi(ctx, "status.set", { text: "hi", until: Date.now() - 1 })).rejects.toMatchObject({ code: "bad_request", message: "until is a time to come: a status that ended is none" });
    await expect(callApi(ctx, "status.set", { text: "hi", until: "tomorrow" })).rejects.toMatchObject({ code: "bad_request" });
    // Within a year, as the command line's --until: past the last time a Date holds, the picker read "Invalid Date".
    for (const until of [Date.now() + 400 * 86_400_000, 8.64e15 + 1, Number.MAX_SAFE_INTEGER]) {
      await expect(callApi(ctx, "status.set", { text: "hi", until })).rejects.toMatchObject({ code: "bad_request", message: "until is a time within a year from now" });
    }
    await expect(callApi(ctx, "status.set", {})).rejects.toMatchObject({ code: "bad_request", message: "Nothing to set: give a text, emoji or availability" });
    const seed = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";
    await expect(callApi(ctx, "status.set", { text: seed })).rejects.toMatchObject({ code: "confirm" });
    expect(node.setOwnStatus).not.toHaveBeenCalled();
    expect(await callApi(ctx, "status.set", { text: seed, force: true })).toMatchObject({ status: { text: seed } });
  });
});

describe("ghostly status set|clear|show", { timeout: 120_000 }, () => {
  const dir = home("own-status");
  let daemon: Running | undefined;
  afterAll(async () => { await daemon?.stop(); });

  it("sets, shows and clears this profile's status as a one-shot, and plain status is unchanged", async () => {
    ok(await ghostly(["--home", dir, "profile", "create", "bot", "--use"]));
    expect(ok(await ghostly(["--home", dir, "status", "show"]))).toEqual({ status: null });
    const set = ok(await ghostly(["--home", dir, "status", "set", "At", "lunch", "--emoji", "🍕", "--availability", "busy", "--until", "2h"]));
    expect(set).toEqual({ status: { text: "At lunch", emoji: "🍕", availability: "busy", until: expect.any(Number) } });
    expect(ok(await ghostly(["--home", dir, "status", "show"]))).toEqual(set);
    const plain = ok(await ghostly(["--home", dir, "status"]));
    expect(plain).toMatchObject({ profile: "bot", mode: "one-shot" });
    expect(plain).not.toHaveProperty("status");
    expect(ok(await ghostly(["--home", dir, "status", "clear"]))).toEqual({ status: null });
    expect(ok(await ghostly(["--home", dir, "status", "show"]))).toEqual({ status: null });
  });

  it("refuses a bad line with exit 2 and changes nothing; plain status still takes no word", async () => {
    ok(await ghostly(["--home", dir, "status", "set", "Here"]));
    expect(error(await ghostly(["--home", dir, "status", "set", "x".repeat(61)]), "usage", 2).message).toBe("<text> is up to 60 characters, not 61 characters");
    expect(error(await ghostly(["--home", dir, "status", "set", "hi", "--until", "yesterday"]), "usage", 2).message).toMatch(/^--until takes/);
    expect(error(await ghostly(["--home", dir, "status", "set", "hi", "--availability", "lunch"]), "usage", 2).message).toMatch(/^--availability takes/);
    expect(error(await ghostly(["--home", dir, "status", "frob"]), "usage", 2).message).toBe("Unknown command: status frob: ghostly status takes clear, set or show (ghostly help status)");
    expect(ok(await ghostly(["--home", dir, "status", "show"]))).toMatchObject({ status: { text: "Here" } });
  });

  it("goes through a running daemon, which keeps it for the next one-shot", async () => {
    daemon = new Running(["--home", dir, "daemon"]);
    await daemon.waitFor((l) => l.daemon === "ready");
    expect(ok(await ghostly(["--home", dir, "status"]))).toMatchObject({ mode: "daemon" });
    expect(ok(await ghostly(["--home", dir, "status", "set", "On", "call", "--availability", "dnd"]))).toEqual({ status: { text: "On call", emoji: null, availability: "dnd", until: null } });
    expect(ok(await ghostly(["--home", dir, "status", "show"]))).toMatchObject({ status: { text: "On call", availability: "dnd" } });
    await daemon.stop();
    expect(ok(await ghostly(["--home", dir, "status", "show"]))).toMatchObject({ status: { text: "On call", availability: "dnd" } });
    expect(ok(await ghostly(["--home", dir, "status", "clear"]))).toEqual({ status: null });
  });
});
