import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMMUNITY_LIMITS, GROUP_EDIT_TEXT_BYTES, GROUP_LIMITS, LIMITS, STATUS_CARD_LIMITS } from "@ghostly/core";
import type { EngineState, Settings } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { asCliError } from "../src/errors";
import { findSecret } from "../src/secretGuard";
// covers: headless.secret-guard, headless.engine-passthrough

/**
 * A raw engine send (`engine.call`) runs `send`'s secret guard on its texts, and that guard reads about 0.35 s a MB: a
 * 15 MB text held the daemon's thread for 5 s before the engine refused it for its size. A text the engine refuses by
 * its size alone is not read: the answer is the engine's, as it was, and nothing of it goes. Every other text still is.
 */
vi.mock("../src/secretGuard", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/secretGuard")>();
  return { ...real, findSecret: vi.fn(real.findSecret) };
});
const read = vi.mocked(findSecret);

/** Where the engine refuses a message's text, whichever call and kind of chat or group (checked below). */
const ENGINE_TEXT_BYTES = LIMITS.maxChatMessageBytes;
const SEED = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const utf8 = (text: string) => new TextEncoder().encode(text).length;
const bytes = (text: string) => utf8(text.trim());
/** The longest text any find asked about, in UTF-16 units. */
const longestRead = () => Math.max(0, ...read.mock.calls.map(([text]) => (typeof text === "string" ? text.length : 0)));

/** A fake engine that answers past 16 KiB as the real one does (node.ts, groupEdits.ts, groupSession/groupCommunity). */
function fake() {
  const tooLong = (text: unknown) => typeof text === "string" && bytes(text) > LIMITS.maxChatMessageBytes;
  const exceeds = { error: `Message exceeds ${LIMITS.maxChatMessageBytes} UTF-8 bytes.`, refused: true };
  const node = {
    getState: () => ({ links: [], groups: [], settings: { online: true } as unknown as Settings, transport: { protocol: "p", relays: [] } }) as unknown as EngineState,
    getSettings: () => ({ online: true }) as unknown as Settings,
    sendMessage: vi.fn(async ({ text }: { text?: string }) => (tooLong(text) ? exceeds : { error: null, messageId: "me_1" })),
    editMessage: vi.fn(async ({ text }: { text?: string }) => (tooLong(text) ? exceeds : { error: null, messageId: "me_1" })),
    sendGroupMessage: vi.fn(async ({ text }: { text?: string }) => (tooLong(text) ? { error: "Message exceeds 16 KiB" } : { error: null })),
    sendGroupFile: vi.fn(async ({ caption }: { caption?: string }) => (tooLong(caption) ? { error: "Message exceeds 16 KiB" } : { error: null })),
    sendPayment: vi.fn(async () => ({ error: null })),
    createGroup: vi.fn(async () => ({ groupId: "g" })),
    setOwnStatus: vi.fn(async () => undefined),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, calls: { list: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node };
}

const call = (ctx: ApiContext, method: string, params: Record<string, unknown>, force = false) =>
  callApi(ctx, "engine.call", { method, params, ...(force && { force: true }) }).then((answer) => ({ answer }), (error) => ({ error: asCliError(error).toJSON() }));

const file = { id: "group-g-out-1", name: "a.txt", mime: "text/plain", size: 1 };
const card = (extra: Record<string, unknown> = {}) => ({ kind: "task", id: "t", title: "x", status: "running", ...extra });

beforeEach(() => { read.mockClear(); });

describe("engine.call, a text past what the engine takes", { timeout: 120_000 }, () => {
  it("is one bound for every call: a chat's text, a group's, a community's and an edit's", () => {
    for (const limit of [GROUP_LIMITS.textBytes, COMMUNITY_LIMITS.textBytes, GROUP_EDIT_TEXT_BYTES]) expect(limit).toBe(ENGINE_TEXT_BYTES);
    // A card is refused past its own bound, far below that.
    expect(STATUS_CARD_LIMITS.bytes).toBeLessThan(ENGINE_TEXT_BYTES);
  });

  it("15 MB through sendMessage, editMessage, sendGroupMessage and a group file's caption: the engine's refusal, as before, without reading it", async () => {
    const { ctx, node } = fake();
    // Words, as a long text has them: read, they took 2.5-5.7 s. One run of a letter overflowed the guard's stack.
    const big = "hello world ".repeat((15 * 1024 * 1024) / 12);
    const calls: [string, Record<string, unknown>][] = [
      ["sendMessage", { linkId: "c", text: big }],
      ["sendMessage", { linkId: "c", text: "x".repeat(15 * 1024 * 1024) }],
      ["sendMessage", { linkId: "c", text: big, card: card() }],
      ["editMessage", { linkId: "c", messageId: "me_1", text: big }],
      ["editMessage", { linkId: "group:g", messageId: "me_1", text: big }],
      ["sendGroupMessage", { groupId: "g", text: big }],
      ["sendGroupFile", { groupId: "g", file, caption: big }],
      // A secret in it changes nothing: the engine refuses it whole, so it never goes.
      ["sendMessage", { linkId: "c", text: `${SEED} ${big}` }],
      ["editMessage", { linkId: "c", messageId: "me_1", text: `${big} ${SEED}` }],
    ];
    for (const [method, params] of calls) {
      read.mockClear();
      const at = performance.now();
      const answer = await call(ctx, method, params);
      const ms = performance.now() - at;
      // What the engine answers with --force (no guard at all), code and message.
      expect(answer, method).toEqual(await call(ctx, method, params, true));
      expect(answer, method).toMatchObject({ answer: { error: expect.stringMatching(/^Message exceeds 16/) } });
      expect(longestRead(), method).toBeLessThanOrEqual(ENGINE_TEXT_BYTES * 2);
      expect(ms, method).toBeLessThan(500);
    }
    // Each was asked, twice (with and without --force), and refused it.
    expect([node.sendMessage, node.editMessage, node.sendGroupMessage, node.sendGroupFile].map((f) => f.mock.calls.length)).toEqual([8, 6, 2, 2]);
  });

  it("a card past its bound is not read either: the engine refuses the card", async () => {
    const { ctx, node } = fake();
    node.sendMessage.mockImplementation(async () => ({ error: `Status card: The card takes more than ${STATUS_CARD_LIMITS.bytes} bytes`, refused: true }) as never);
    const answer = await call(ctx, "sendMessage", { linkId: "c", text: "", card: card({ step: `${SEED} ${"y".repeat(15 * 1024 * 1024)}` }) });
    expect(answer).toMatchObject({ answer: { refused: true } });
    expect(longestRead()).toBeLessThanOrEqual(ENGINE_TEXT_BYTES * 2);
  });

  it("a secret in a text just within the bound is still refused, in every field the bound skips", async () => {
    const { ctx, node } = fake();
    const within = (head: string, pad: string) => { const text = head + pad.repeat(Math.floor((ENGINE_TEXT_BYTES - utf8(head)) / utf8(pad))); expect(bytes(text)).toBe(ENGINE_TEXT_BYTES - ((ENGINE_TEXT_BYTES - utf8(head)) % utf8(pad))); return text; };
    for (const text of [
      within(`${SEED} `, "x"),
      within(`${SEED} `, "é"),
      // Blank around it is not counted: the engine trims it off and would send the seed.
      `${" ".repeat(ENGINE_TEXT_BYTES * 2)}${SEED}${"\n".repeat(ENGINE_TEXT_BYTES)}`,
    ]) {
      expect(bytes(text)).toBeLessThanOrEqual(ENGINE_TEXT_BYTES);
      for (const [method, params] of [
        ["sendMessage", { linkId: "c", text }],
        ["editMessage", { linkId: "c", messageId: "me_1", text }],
        ["editMessage", { linkId: "group:g", messageId: "me_1", text }],
        ["sendGroupMessage", { groupId: "g", text }],
        ["sendGroupFile", { groupId: "g", file, caption: text }],
      ] as const) {
        expect(await call(ctx, method, params), method).toMatchObject({ error: { code: "confirm", message: expect.stringContaining(`call ${method} with --force`) } });
      }
    }
    for (const sent of [node.sendMessage, node.editMessage, node.sendGroupMessage, node.sendGroupFile]) expect(sent).not.toHaveBeenCalled();
  });

  it("a field the engine may take at another size is read whatever its length", async () => {
    const { ctx, node } = fake();
    const long = `${SEED} ${"x".repeat(ENGINE_TEXT_BYTES * 2)}`;
    for (const [method, params] of [
      ["sendPayment", { linkId: "c", amount: 1, memo: long, timestamp: 1 }],
      // A `text` the call does not take is not skipped either.
      ["sendPayment", { linkId: "c", amount: 1, timestamp: 1, text: long }],
      ["createGroup", { name: long }],
      ["setOwnStatus", { status: { text: long } }],
      // A message's other fields stay read beside a text past the bound.
      ["sendMessage", { linkId: "c", text: "x".repeat(ENGINE_TEXT_BYTES + 1), memo: long }],
      ["sendMessage", { linkId: "c", text: "x".repeat(ENGINE_TEXT_BYTES + 1), card: card({ step: SEED }) }],
    ] as const) {
      expect(await call(ctx, method, params), method).toMatchObject({ error: { code: "confirm" } });
    }
    for (const sent of [node.sendMessage, node.sendPayment, node.createGroup, node.setOwnStatus]) expect(sent).not.toHaveBeenCalled();
  });
});
