import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { APP_CHECK_TIMINGS } from "../src/engine/apps";
import { BUNDLE_URL, FakeNet, NOW_MS, STORE_URL, apps, bundle, emptyProfile, listing, storeFiles } from "./appsSupport";
// covers: apps.engine.installed

/*
 * A newer version whose peek is fine but whose whole read is refused (a file hash that does not hold, a bad signature)
 * is not downloaded whole again at every update check while its URL serves the same: each Apps page visit checks.
 */

const SOURCE = "https://raw.githubusercontent.com/ana/chess/HEAD/dist/app.ghostlyapp";
const MIRRORS = [1, 2, 3, 4].map((i) => `https://raw.githubusercontent.com/ana/chess${i}/HEAD/app.ghostlyapp`);

/** The bundle with its last byte flipped: the manifest, and so the peek, stay as they were; the last file's hash fails. */
const broken = (bytes: Uint8Array) => { const out = bytes.slice(); out[out.length - 1]! ^= 1; return out; };

beforeEach(emptyProfile);

describe("an update whose whole read is refused", () => {
  let now = NOW_MS;
  const setup = async () => {
    now = NOW_MS;
    const net = new FakeNet();
    const store = apps(net, { now: () => now });
    const v1 = await bundle({ sources: [SOURCE] });
    net.put(BUNDLE_URL, v1.bytes);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    // Whole reads (no range), by URL.
    const whole = (url: string) => net.fetch.mock.calls.filter(([at, init]) => String(at) === url && !((init?.headers ?? {}) as Record<string, string>).range).length;
    return { net, store, v1, whole };
  };

  it("at a source is read whole once while it serves the same, again once it serves another version or an hour went by", async () => {
    const { net, store, whole } = await setup();
    const v2 = await bundle({ sequence: 2, sources: [SOURCE] });
    net.put(SOURCE, broken(v2.bytes));
    for (let visit = 0; visit < 3; visit++) expect((await store.checkUpdates())[0]!.outcome).toBe("none");
    expect(whole(SOURCE), "read whole once, then only peeked").toBe(1);

    // Fixed by an upload of the same version (the same manifest, so the same peek): taken once the hour went by.
    net.put(SOURCE, v2.bytes);
    now += APP_CHECK_TIMINGS.freshMs - 1;
    expect((await store.checkUpdates())[0]!.outcome).toBe("none");
    expect(whole(SOURCE)).toBe(1);
    now += 2;
    expect((await store.checkUpdates())[0]!.outcome).toBe("updated");
    expect(whole(SOURCE)).toBe(2);
    expect((await store.list())[0]).toMatchObject({ sequence: 2, digest: v2.digest });

    // Another broken version there: its peek differs, so it is read whole once.
    const v3 = await bundle({ sequence: 3, sources: [SOURCE] });
    net.put(SOURCE, broken(v3.bytes));
    for (let visit = 0; visit < 2; visit++) expect((await store.checkUpdates())[0]!.outcome).toBe("none");
    expect(whole(SOURCE)).toBe(3);
  });

  it("at the URLs of a store's listing is read whole once from each", async () => {
    const { net, store, whole } = await setup();
    const v99 = await bundle({ sequence: 99, sources: [SOURCE], data: new Uint8Array(64 * 1024) });
    for (const url of MIRRORS) net.put(url, broken(v99.bytes));
    await net.putStore(await storeFiles({ kind: "indexed", apps: [listing(v99, MIRRORS)] }));
    await store.addStore({ url: STORE_URL });
    for (let visit = 0; visit < 3; visit++) expect((await store.checkUpdates())[0]!.outcome).toBe("none");
    expect(MIRRORS.map(whole)).toEqual([1, 1, 1, 1]);
  });

  it("another bundle under the installed number at each of two sources is read whole once from each, not at every check", async () => {
    const net = new FakeNet();
    now = NOW_MS;
    const store = apps(net, { now: () => now });
    const v1 = await bundle({ sources: [SOURCE, MIRRORS[0]!] });
    net.put(BUNDLE_URL, v1.bytes);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    const whole = (url: string) => net.fetch.mock.calls.filter(([at, init]) => String(at) === url && !((init?.headers ?? {}) as Record<string, string>).range).length;
    // Its publisher rebuilt version 1 twice without raising the number: the mark took each in turn, both read whole.
    net.put(SOURCE, (await bundle({ sources: [SOURCE, MIRRORS[0]!], entry: "<p>a second version 1" })).bytes);
    net.put(MIRRORS[0]!, (await bundle({ sources: [SOURCE, MIRRORS[0]!], entry: "<p>a third version 1" })).bytes);
    expect((await store.checkUpdates())[0]!.outcome).toBe("equivocation");
    const marked = (await store.list())[0]!.equivocation;
    for (let visit = 0; visit < 3; visit++) {
      now += 60_000;
      expect((await store.checkUpdates())[0]!.outcome).toBe("equivocation");
    }
    expect([whole(SOURCE), whole(MIRRORS[0]!)]).toEqual([1, 1]);
    expect((await store.list())[0]!.equivocation, "the mark is not rewritten").toEqual(marked);
  });

  it("is read again after a failed read that brought no bundle (the host down)", async () => {
    const { net, store, whole } = await setup();
    const v2 = await bundle({ sequence: 2, sources: [SOURCE] });
    net.put(SOURCE, v2.bytes);
    // The peek answers, the whole read does not.
    const answer = net.fetch.getMockImplementation()!;
    net.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === SOURCE && !((init?.headers ?? {}) as Record<string, string>).range ? new Response("busy", { status: 503 }) : answer(input, init));
    expect((await store.checkUpdates())[0]!.outcome).toBe("none");
    net.fetch.mockImplementation(answer);
    expect((await store.checkUpdates())[0]!.outcome).toBe("updated");
    expect(whole(SOURCE)).toBe(2);
  });
});
