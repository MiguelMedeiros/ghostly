import { readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRef, type AppManifest } from "@ghostly/core";
import { error, ghostly, home, hyperdhtTestnet, localRelay, ok, Running } from "./support/cli";
// covers: apps.chat.wire, headless.daemon, headless.events

/**
 * Two bots that serve the same app, each a `ghostly` daemon on its own profile (WISP 1200 § A bot on the other side):
 * one opens the app in their chat and the other gets its card and `app.opened`; once both opened it, the app's messages
 * go both ways as `app.message`; a close is heard. Everything on loopback, as test/twoPeers.test.ts. The app is a bundle
 * of the core's test vectors: no app runs, the bots speak for it.
 */
type Segment = { hex: string } | { fill: string; size: number };
const vector = (JSON.parse(readFileSync(resolve(import.meta.dirname, "../../core/test/vectors/app-bundle.json"), "utf8")) as {
  valid: { name: string; bytes: Segment[]; read: { digest: string; manifest: AppManifest } }[];
}).valid.find((v) => v.name === "the entry only")!;
const REF = appRef(vector.read.manifest.publisher, vector.read.manifest.name);

let relays: { url: string; server: Server }[] = [];
let dht: { bootstrap: string; destroy(): Promise<void> };
const running: Running[] = [];
const alice = home("app-alice"), bob = home("app-bob");
let env: NodeJS.ProcessEnv;
const as = (dir: string, ...args: string[]) => ghostly(["--home", dir, ...args], { env });

type AppEvent = { type: string; chat: string; app: string; version?: string; data?: unknown; offline?: boolean };
/** `dir`'s app events so far, in order. */
const appEvents = async (dir: string) => (ok(await as(dir, "events")).events as AppEvent[]).filter((e) => e.type.startsWith("app."))
  .map(({ type, app, version, data }) => ({ type, app, ...(version !== undefined && { version }), ...(data !== undefined && { data }) }));
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  let value = await read();
  while (!done(value) && Date.now() < end) { await new Promise((r) => setTimeout(r, 250)); value = await read(); }
  return value;
}

beforeAll(async () => {
  relays = await Promise.all([localRelay(), localRelay()]);
  dht = await hyperdhtTestnet();
  env = { GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap, GHOSTLY_PKARR_RELAYS: relays.map((r) => r.url).join(",") };
}, 30_000);

afterAll(async () => {
  await Promise.all(running.map((r) => r.stop()));
  await dht?.destroy();
  for (const relay of relays) relay.server.close();
}, 30_000);

describe("two bots that serve the same app", { timeout: 180_000 }, () => {
  let chatA = "", chatB = "";

  it("serve the app before their daemons start, pair and go live", async () => {
    for (const [dir, name] of [[alice, "Alice bot"], [bob, "Bob bot"]] as const) {
      ok(await as(dir, "settings", "set", "relays", JSON.stringify(relays.map((r) => r.url))));
      ok(await as(dir, "profile", "set", "--name", name));
      const bundle = join(dir, "app.ghostlyapp");
      writeFileSync(bundle, Buffer.concat(vector.bytes.map((s) => ("hex" in s ? Buffer.from(s.hex, "hex") : Buffer.alloc(s.size, Number.parseInt(s.fill, 16))))));
      error(await as(dir, "app", "serve", bundle), "confirm", 5);
      expect(ok(await as(dir, "app", "serve", bundle, "--grant", "chat"))).toMatchObject({ served: { ref: REF, digest: vector.read.digest, granted: ["chat"] } });
      // A one-shot holds nothing open.
      error(await as(dir, "app", "open", "nobody", "chess"), "unavailable", 1);
      const daemon = new Running(["--home", dir, "daemon"], env);
      running.push(daemon);
      await daemon.waitFor((l) => l.daemon === "ready");
      expect(ok(await as(dir, "app", "served"))).toMatchObject({ apps: [{ ref: REF }], offered: true });
    }
    const invite = ok(await as(alice, "invite", "create", "--label", "bob"));
    chatA = invite.chat as string;
    chatB = ok(await as(bob, "invite", "join", invite.link as string, "--label", "alice")).chat as string;
    for (const [dir, chat] of [[alice, chatA], [bob, chatB]])
      expect(ok(await as(dir, "chat", "wait", chat, "--until", "live", "--timeout", "90"))).toMatchObject({ live: true });
  });

  it("one opens the app: the other gets its card and app.opened, and nothing can be sent until it opens too", async () => {
    const opened = ok(await as(alice, "app", "open", "bob", "chess"));
    expect(opened).toMatchObject({ chat: chatA, app: REF, version: vector.read.manifest.version, peer: null, live: true });
    expect(opened.card).toEqual(expect.any(String));
    expect(await until(() => appEvents(bob), (e) => e.length >= 1)).toEqual([{ type: "app.opened", app: REF, version: vector.read.manifest.version }]);
    const cards = await until(async () => (ok(await as(bob, "chat", "history", "alice")).messages as { card?: Record<string, unknown> }[]).filter((m) => m.card?.kind === "app"), (m) => m.length >= 1);
    expect(cards.map((m) => m.card)).toEqual([expect.objectContaining({ kind: "app", ref: REF, digest: vector.read.digest, sequence: vector.read.manifest.sequence, title: vector.read.manifest.title, opened: true })]);
    expect(error(await as(alice, "app", "send", "bob", "chess", '{"k":"too soon"}'), "unavailable", 1)).toMatchObject({ details: { reason: "peer-closed" } });
    expect(error(await as(bob, "app", "send", "alice", "chess", "1"), "refused", 1)).toMatchObject({ details: { reason: "not-open" } });
  });

  it("the other opens it, with no second card, and the app's messages go both ways", async () => {
    expect(ok(await as(bob, "app", "open", "alice", REF))).toMatchObject({ chat: chatB, app: REF, card: null, peer: vector.read.manifest.version });
    expect(await until(() => appEvents(alice), (e) => e.length >= 1)).toEqual([{ type: "app.opened", app: REF, version: vector.read.manifest.version }]);
    expect(ok(await as(alice, "app", "send", "bob", "chess", '{"p":"chess","v":2,"k":"hello"}'))).toMatchObject({ sent: true });
    expect(ok(await ghostly(["--home", bob, "app", "send", "alice", "chess", "-"], { env, input: '{"k":"move","m":"e2e4"}' }))).toMatchObject({ sent: true });
    expect((await until(() => appEvents(bob), (e) => e.length >= 2)).at(-1)).toEqual({ type: "app.message", app: REF, data: { p: "chess", v: 2, k: "hello" } });
    expect((await until(() => appEvents(alice), (e) => e.length >= 2)).at(-1)).toEqual({ type: "app.message", app: REF, data: { k: "move", m: "e2e4" } });
    error(await as(alice, "app", "send", "bob", "chess", "{not json"), "usage", 2);
  });

  it("a close is heard, and ends the talk", async () => {
    expect(ok(await as(alice, "app", "close", "bob", "chess"))).toMatchObject({ closed: true });
    expect((await until(() => appEvents(bob), (e) => e.length >= 3)).at(-1)).toEqual({ type: "app.closed", app: REF });
    expect(error(await as(bob, "app", "send", "alice", "chess", "1"), "unavailable", 1)).toMatchObject({ details: { reason: "peer-closed" } });
  });
});
