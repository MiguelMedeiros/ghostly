import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, LinkView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { AUTO_FROM_CHATS } from "../src/apiKit";
import { CallManager, type CallEngine } from "../src/calls/manager";
import { connectDaemon } from "../src/client";
import { CliError } from "../src/errors";
import { GroupAutoJoin } from "../src/groupAuto";
import { serve, type Host } from "../src/host";
import { lockPath } from "../src/profiles";
import { chatViewOf } from "./support/chatView";
import { error, ghostly, home, localRelay, ok } from "./support/cli";
// covers: headless.group-auto, headless.calls

/**
 * `call auto on --from` and `group auto on --from` (`call.auto`, `group.auto` on the socket) take at most 256 distinct
 * refs: more are refused (`bad_request`, the limit and the count in the message, no ref echoed) before any is looked
 * up, and nothing is kept. Each distinct ref is a lookup over every chat; the same ref given again is read once, so
 * copies do not count.
 */
const refused = (count: number) => ({ code: "bad_request", message: `At most ${AUTO_FROM_CHATS} chats in --from; got ${count}.` });

/** Every way of writing `word` in upper and lower case: 2^length refs that each name the chat labelled `word`. */
const cases = (word: string) => Array.from({ length: 2 ** word.length }, (_, n) => [...word].map((c, i) => (n & (1 << i) ? c.toUpperCase() : c)).join(""));

describe("--from takes at most 256 distinct refs", () => {
  it("is 256", () => {
    expect(AUTO_FROM_CHATS).toBe(256);
    expect(new Set(cases("abcdefgh")).size).toBe(AUTO_FROM_CHATS);
  });

  describe("over the socket (call.auto, group.auto)", () => {
    const ids = Array.from({ length: AUTO_FROM_CHATS }, (_, i) => `chat-${String(i).padStart(3, "0")}`);
    const dir = mkdtempSync(join(tmpdir(), "ghostly-auto-from-cap-"));
    const paths = { dir, db: join(dir, "db"), files: join(dir, "files"), socket: join(dir, "daemon.sock") };
    const s = { links: ids.map((id, i) => ({ id, peerPubKeyZ32: `key-${i}`, profile: "paired-chat/1" }) as unknown as LinkView), groups: [] as GroupView[] };
    const engine = { chatView: chatViewOf, getState: () => s as unknown as EngineState, acceptGroupInvitation: vi.fn(async () => {}), switchGroup: vi.fn(async () => {}), setCallSignal: async () => {} };
    const groupAuto = new GroupAutoJoin({ engine, profileDir: dir, joins: true });
    const calls = new CallManager({ engine: engine as unknown as CallEngine, emit: () => {}, profileDir: dir });
    const ctx = { runtime: { paths, server: { node: engine } }, hub: { onEvent: () => () => {} }, calls, groupAuto, mode: "daemon", version: "test" } as unknown as ApiContext;
    let served: Awaited<ReturnType<typeof serve>>;
    let client: NonNullable<Awaited<ReturnType<typeof connectDaemon>>>;
    const saved = () => ({ calls: readFileSync(join(dir, "calls.json"), "utf8"), groups: readFileSync(join(dir, "groups.json"), "utf8") });

    beforeAll(async () => {
      mkdirSync(paths.db, { recursive: true, mode: 0o700 });
      mkdirSync(paths.files, { recursive: true, mode: 0o700 });
      writeFileSync(lockPath(dir), String(process.pid));
      served = await serve({ ctx } as unknown as Host);
      client = (await connectDaemon(paths))!;
    });
    afterAll(async () => {
      client?.destroy();
      await served?.close();
    });

    it("refuses 257 distinct refs before reading any, and keeps what was set", async () => {
      expect(await client.call("call.auto", { on: true, from: ["chat-000"], rate: 16000 })).toEqual({ autoAnswer: { on: true, from: ["chat-000"], rate: 16000 } });
      expect(await client.call("group.auto", { on: true, from: ["chat-000"] })).toEqual({ autoJoin: { on: true, from: ["chat-000"] } });
      const before = saved();
      // A ref no chat has comes first: read, it would be not_found.
      const many = ["nobody", ...ids];
      for (const method of ["call.auto", "group.auto"]) {
        const failure = await client.call(method, { on: true, from: many }).then(() => expect.fail(`${method} took ${many.length}`), (e: unknown) => e);
        expect(failure, method).toBeInstanceOf(CliError);
        expect((failure as CliError).toJSON(), method).toEqual(refused(AUTO_FROM_CHATS + 1));
      }
      // In process (a one-shot), the same; nothing written either way.
      await expect(callApi(ctx, "call.auto", { on: true, from: many })).rejects.toMatchObject(refused(AUTO_FROM_CHATS + 1));
      await expect(callApi(ctx, "group.auto", { on: true, from: many })).rejects.toMatchObject(refused(AUTO_FROM_CHATS + 1));
      expect(saved()).toEqual(before);
      expect(calls.getAuto()).toEqual({ on: true, from: ["chat-000"], rate: 16000 });
      expect(groupAuto.get()).toEqual({ on: true, from: ["chat-000"] });
    });

    it("takes 256 distinct refs, each chat once", async () => {
      expect(await client.call("call.auto", { on: true, from: ids })).toEqual({ autoAnswer: { on: true, from: ids, rate: 48000 } });
      expect(await client.call("group.auto", { on: true, from: ids })).toEqual({ autoJoin: { on: true, from: ids } });
      expect(JSON.parse(saved().calls).autoAnswer.from).toEqual(ids);
    });

    it("counts distinct refs: 300 refs, 10 of them distinct, are taken", async () => {
      const ten = ids.slice(0, 10), from = Array.from({ length: 300 }, (_, i) => ten[i % 10]);
      expect(await client.call("call.auto", { on: true, from })).toEqual({ autoAnswer: { on: true, from: ten, rate: 48000 } });
      expect(await client.call("group.auto", { on: true, from })).toEqual({ autoJoin: { on: true, from: ten } });
      // 50,000 copies of 256 refs are 256.
      const copies = Array.from({ length: 50_000 }, (_, i) => ids[i % AUTO_FROM_CHATS]);
      expect(await client.call("group.auto", { on: true, from: copies })).toEqual({ autoJoin: { on: true, from: ids } });
    });
  });

  describe("on the command line (call auto on --from, group auto on --from)", { timeout: 120_000 }, () => {
    const dir = home("auto-from-cap");
    const profile = join(dir, "profiles", "default");
    let relay: Awaited<ReturnType<typeof localRelay>>;
    let env: NodeJS.ProcessEnv;
    let chat: string;
    const as = (...args: string[]) => ghostly(["--home", dir, ...args], { env });
    const flags = (refs: string[]) => refs.flatMap((ref) => ["--from", ref]);
    const kept = () => ({ calls: readFileSync(join(profile, "calls.json"), "utf8"), groups: readFileSync(join(profile, "groups.json"), "utf8") });

    beforeAll(async () => {
      relay = await localRelay();
      env = { GHOSTLY_PKARR_RELAYS: relay.url };
      chat = ok(await as("invite", "create", "--label", "abcdefgh")).chat as string;
    });
    afterAll(() => { relay?.server.closeAllConnections(); relay?.server.close(); });

    it("refuses 257 distinct refs (exit 1) and keeps what was set; takes 256, and 300 with 10 distinct", async () => {
      ok(await as("call", "auto", "on", "--from", chat, "--rate", "16000"));
      ok(await as("group", "auto", "on", "--from", chat));
      expect(existsSync(join(profile, "calls.json")) && existsSync(join(profile, "groups.json"))).toBe(true);
      const before = kept();
      // 256 ways of writing the chat's label, and its id: 257 distinct refs, all for one chat.
      const variants = cases("abcdefgh");
      for (const command of [["call", "auto"], ["group", "auto"]]) {
        const failure = error(await as(...command, "on", ...flags([...variants, chat])), "bad_request", 1);
        expect(failure, command.join(" ")).toEqual(refused(AUTO_FROM_CHATS + 1));
      }
      expect(kept()).toEqual(before);
      expect(ok(await as("call", "auto"))).toEqual({ autoAnswer: { on: true, from: [chat], rate: 16000 } });

      expect(ok(await as("call", "auto", "on", ...flags(variants)))).toEqual({ autoAnswer: { on: true, from: [chat], rate: 48000 } });
      expect(ok(await as("group", "auto", "on", ...flags(variants)))).toEqual({ autoJoin: { on: true, from: [chat] } });
      const repeated = Array.from({ length: 300 }, (_, i) => variants[i % 10]);
      expect(ok(await as("call", "auto", "on", ...flags(repeated)))).toEqual({ autoAnswer: { on: true, from: [chat], rate: 48000 } });
      expect(ok(await as("group", "auto", "on", ...flags(repeated)))).toEqual({ autoJoin: { on: true, from: [chat] } });
    });
  });
});
