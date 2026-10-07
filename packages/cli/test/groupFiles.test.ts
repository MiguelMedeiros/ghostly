import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ghostly, home, hyperdhtTestnet, localRelay, ok, Running } from "./support/cli";
// covers: groups.files, groups.files.wire, headless.groups

/**
 * Files in a private group of three headless members (WISP 503 · Group Files): `file send <group>` announces a file
 * and a voice note, and the other two daemons fetch the bytes by themselves (they are under the automatic limits),
 * from the author or from each other. Everything on loopback, as meshGroup.test.ts runs it.
 */
let relays: { url: string; server: Server }[] = [];
let hyperdht: Awaited<ReturnType<typeof hyperdhtTestnet>> | undefined;
const running = new Map<string, Running>();
const homes = ["alice", "bob", "carol"].map((name) => home(name));
const [alice, bob, carol] = homes;
const pinned = (): NodeJS.ProcessEnv => ({
  GHOSTLY_PKARR_RELAYS: relays.map((relay) => relay.url).join(","),
  ...(hyperdht ? { GHOSTLY_HYPERDHT_BOOTSTRAP: hyperdht.bootstrap } : {}),
});
const as = (dir: string, ...args: string[]) => ghostly(["--home", dir, ...args], { env: pinned() });
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

async function up(dir: string): Promise<void> {
  const daemon = new Running(["--home", dir, "daemon"], pinned());
  running.set(dir, daemon);
  await daemon.waitFor((l) => l.daemon === "ready");
}

async function until<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, ms = 180_000): Promise<T> {
  const end = Date.now() + ms;
  let value = await read();
  while (!done(value)) {
    if (Date.now() > end) throw new Error(`${what}: not done in ${ms / 1000} s; last ${JSON.stringify(value).slice(0, 1500)}`);
    await new Promise((r) => setTimeout(r, 1000));
    value = await read();
  }
  return value;
}

type Listed = { messageId: string; from: string; file: { id: string; name: string; size: number; voice?: { duration: number } }; transfer: { state: string } | null };
const files = async (dir: string, group: string) => ok(await as(dir, "file", "list", group)).files as Listed[];

beforeAll(async () => { relays = [await localRelay(), await localRelay()]; hyperdht = await hyperdhtTestnet(); }, 30_000);
afterAll(async () => {
  await Promise.all([...running.values()].map((daemon) => daemon.stop()));
  for (const relay of relays) relay.server.close();
  await hyperdht?.destroy();
}, 60_000);

describe("files in a private group of three daemons", { timeout: 480_000 }, () => {
  it("a file and a voice note sent with file send reach the other two, the same bytes", async () => {
    for (const [i, dir] of homes.entries()) {
      ok(await as(dir, "settings", "set", "relays", JSON.stringify(relays.map((relay) => relay.url))));
      ok(await as(dir, "profile", "set", "--name", ["Alice", "Bob", "Carol"][i]));
    }
    await Promise.all(homes.map(up));
    const group = ok(await as(alice, "group", "create", "Files", "--mesh")).group as string;
    const link = ok(await as(alice, "group", "link", group)).link as string;
    for (const dir of [bob, carol]) {
      ok(await as(dir, "group", "join", link));
      await until("admitted", async () => ok(await as(dir, "group", "show", group)).status, (s) => s === "active");
    }
    for (const dir of homes) {
      await until(`${dir} reaches everyone`, async () => ok(await as(dir, "group", "show", group)).members as { online: boolean }[], (m) => m.length === 3 && m.every((x) => x.online));
    }

    const report = join(alice, "report.bin"), voice = join(alice, "note.ogg");
    writeFileSync(report, randomBytes(300_000));
    writeFileSync(voice, randomBytes(40_000));
    const sent = ok(await as(alice, "file", "send", group, report, "--name", "report.bin"));
    expect(sent).toMatchObject({ group, messageId: expect.any(String), file: { name: "report.bin", size: 300_000 } });
    // A length and loudness bars given: nothing to measure from these bytes.
    const said = ok(await as(alice, "file", "send", group, voice, "--voice", "4000", "--peaks", "0,60,200,255,30"));
    expect(said).toMatchObject({ group, file: { voice: true } });
    // Mine: held here at once.
    expect((await files(alice, group)).map((f) => [f.file.name, f.transfer?.state])).toEqual([["report.bin", "done"], ["note.ogg", "done"]]);

    for (const dir of [bob, carol]) {
      const listed = await until(`${dir} has both`, () => files(dir, group), (l) => l.length === 2 && l.every((f) => f.transfer?.state === "done"));
      expect(listed.map((f) => f.file.name)).toEqual(["report.bin", "note.ogg"]);
      expect(listed[1].file.voice).toMatchObject({ duration: 4000 });
      expect(listed.map((f) => f.messageId)).toEqual([sent.messageId, said.messageId]);
      for (const [f, original] of [[listed[0], report], [listed[1], voice]] as const) {
        const saved = ok(await as(dir, "file", "save", f.file.id, "--path", join(dir, f.file.name)));
        expect(sha(saved.path as string)).toBe(sha(original));
      }
    }
  });
});
