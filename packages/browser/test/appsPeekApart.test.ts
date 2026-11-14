import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { APP_CHECK_TIMINGS } from "../src/engine/apps";
import { fileBytes } from "../src/shared/fileBytes";
import { BUNDLE_URL, FakeNet, NOW_MS, STORE_URL, apps, bundle, emptyProfile, listing, storeFiles } from "./appsSupport";
// covers: apps.engine.installed

/*
 * A host that answers the peek's range read with one bundle and the whole read with another (a publisher's server, or a
 * CDN that keeps ranges and whole files apart): the bundle read whole is not taken, and it is not downloaded whole again
 * at every update check while the peek shows the same. Each Apps page visit checks; up to 16 MiB a URL each time.
 */

const SOURCE = "https://raw.githubusercontent.com/ana/chess/HEAD/dist/app.ghostlyapp";
const MIRROR = "https://raw.githubusercontent.com/ana/chess1/HEAD/app.ghostlyapp";

beforeEach(emptyProfile);

describe("an update whose whole read brings another bundle than its peek", () => {
  let now = NOW_MS;
  const ranged = (init?: RequestInit) => !!((init?.headers ?? {}) as Record<string, string>).range;
  const setup = async (sources = [SOURCE]) => {
    now = NOW_MS;
    const net = new FakeNet();
    const store = apps(net, { now: () => now });
    const v1 = await bundle({ sources });
    net.put(BUNDLE_URL, v1.bytes);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    // `url` peeks as `peek` and is read whole as `whole`.
    const answer = net.fetch.getMockImplementation()!;
    const apart = (url: string, peek: Uint8Array, whole: Uint8Array) => {
      const before = net.fetch.getMockImplementation()!;
      net.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) !== url) return before(input, init);
        net.put(url, ranged(init) ? peek : whole);
        return answer(input, init);
      });
    };
    const whole = (url: string) => net.fetch.mock.calls.filter(([at, init]) => String(at) === url && !ranged(init)).length;
    return { net, store, v1, apart, whole, sources };
  };

  it("at a source that serves the version installed whole is read whole once, again an hour later", async () => {
    const { store, v1, apart, whole } = await setup();
    const v2 = await bundle({ sequence: 2, sources: [SOURCE] });
    apart(SOURCE, v2.bytes, v1.bytes);
    for (let visit = 0; visit < 3; visit++) expect((await store.checkUpdates())[0]!.outcome).toBe("none");
    expect(whole(SOURCE), "read whole once, then only peeked").toBe(1);
    expect((await store.list())[0]).toMatchObject({ sequence: 1, digest: v1.digest });

    // Served as it peeks now: taken once the hour went by.
    apart(SOURCE, v2.bytes, v2.bytes);
    now += APP_CHECK_TIMINGS.freshMs + 1;
    expect((await store.checkUpdates())[0]!.outcome).toBe("updated");
    expect(whole(SOURCE)).toBe(2);
  });

  it("at a store listing's URL that serves another app whole is read whole once", async () => {
    const { net, store, apart, whole } = await setup();
    const v99 = await bundle({ sequence: 99, sources: [SOURCE] });
    const other = await bundle({ sequence: 99, name: "other", sources: [MIRROR] });
    apart(MIRROR, v99.bytes, other.bytes);
    await net.putStore(await storeFiles({ kind: "indexed", apps: [listing(v99, [MIRROR])] }));
    await store.addStore({ url: STORE_URL });
    for (let visit = 0; visit < 3; visit++) expect((await store.checkUpdates())[0]!.outcome).toBe("none");
    expect(whole(MIRROR)).toBe(1);
  });

  it("at a source that serves another build of the installed number whole marks the app, read whole once", async () => {
    const { store, apart, whole, sources } = await setup([SOURCE, MIRROR]);
    const v2 = await bundle({ sequence: 2, sources });
    const twin = await bundle({ sources, entry: "<p>a second version 1" });
    apart(SOURCE, v2.bytes, twin.bytes);
    expect((await store.checkUpdates())[0]!.outcome).toBe("equivocation");
    for (let visit = 0; visit < 3; visit++) {
      now += 60_000;
      await store.checkUpdates();
    }
    expect(whole(SOURCE)).toBe(1);
    expect((await store.list())[0]!.equivocation, "the mark stays").toMatchObject({ sequence: 1 });
  });

  it("asked for an installed app's missing files, a source whose peek shows them and whose whole read does not is read whole once", async () => {
    const { net, store, v1, apart, whole } = await setup();
    await (await fileBytes()).remove(`app-${v1.digest}`);
    net.files.delete(BUNDLE_URL);
    const v2 = await bundle({ sequence: 2, sources: [SOURCE] });
    apart(SOURCE, v1.bytes, v2.bytes);
    for (let open = 0; open < 3; open++) {
      now += 60_000;
      expect(await store.fetchFiles({ ref: v1.ref })).toEqual({ status: "needs-files" });
    }
    expect(whole(SOURCE), "read whole once, then only peeked").toBe(1);

    // Served whole as it peeks now: fetched once the hour went by.
    apart(SOURCE, v1.bytes, v1.bytes);
    now += APP_CHECK_TIMINGS.freshMs + 1;
    expect(await store.fetchFiles({ ref: v1.ref })).toEqual({ status: "ok" });
  });
});
