import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileBytes } from "../src/shared/fileBytes";
import { STORES, openDb, wrap } from "../src/shared/idb";
import { BUNDLE_URL, FakeNet, appRows, apps, bundle, bundleIds, emptyProfile } from "./appsSupport";
// covers: apps.engine.installed

/*
 * A profile restored from another kind of device (its records name files kept elsewhere) fetches an app's files back
 * at Open, then writes where they are now on the record. Install of a newer version by link may write its record
 * meanwhile: the last write wins, and Open goes on with the version Install reported.
 */

let net: FakeNet;
beforeEach(async () => { await emptyProfile(); net = new FakeNet(); });
afterEach(() => { vi.restoreAllMocks(); });

const URL2 = "https://raw.githubusercontent.com/ana/chess/v2/app.ghostlyapp";
const tick = () => new Promise((r) => setImmediate(r));
type Row = { ref: string; digest: string; sequence: number; bytes: string };
type Private = Record<"writeBundle" | "putAppIfUnchanged", (...a: unknown[]) => Promise<unknown>>;

describe("Open of a restored app's files while Install writes a newer version", () => {
  // `held`: ticks between Install starting its record write and the files Open fetched being written back.
  it.each([0, 1, 2, 3, 4, 5, 6])("Install's version stays installed with its files, and Open opens it (%i ticks apart)", async (held) => {
    const v1 = await bundle({ sequence: 1 });
    const v2 = await bundle({ sequence: 2 });
    net.put(BUNDLE_URL, v1.bytes);
    net.put(URL2, v2.bytes);
    const first = apps(net);
    await first.preview({ url: BUNDLE_URL });
    await first.install({ digest: v1.digest, grant: ["chat"] });
    // Restored from a Desktop: the record names files kept natively, none of them here.
    const [row] = await appRows() as Row[];
    row!.bytes = "native";
    await wrap((await openDb()).transaction(STORES.apps, "readwrite").objectStore(STORES.apps).put(row));
    await (await fileBytes()).remove(`app-${v1.digest}`);

    const store = apps(net);
    await store.preview({ url: URL2 });
    const engine = store as unknown as Private;
    const write = engine.writeBundle.bind(store);
    const put = engine.putAppIfUnchanged.bind(store);
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let written!: () => void;
    const wroteV1 = new Promise<void>((r) => { written = r; });
    // Open's fetched files are written, then held until Install writes v2's record.
    vi.spyOn(engine, "writeBundle").mockImplementation(async (digest, bytes) => {
      const kind = await write(digest, bytes);
      if (digest === v1.digest) { written(); await released; }
      return kind;
    });
    vi.spyOn(engine, "putAppIfUnchanged").mockImplementation(async (next, was) => {
      const writing = put(next, was);
      if ((next as Row).digest === v2.digest) void (async () => { for (let i = 0; i < held; i++) await tick(); release(); })();
      return writing;
    });

    const opening = store.entry({ ref: v1.ref });
    await wroteV1;
    const installed = await store.install({ digest: v2.digest, grant: ["chat"] });
    const entry = await opening;

    expect(installed.sequence).toBe(2);
    expect(entry.digest, "Open opens the version Install reported").toBe(v2.digest);
    const [now] = await appRows() as Row[];
    expect({ digest: now?.digest, sequence: now?.sequence, bytes: now?.bytes }).toEqual({ digest: v2.digest, sequence: 2, bytes: (await fileBytes()).kind });
    expect(await bundleIds(), "the files fetched for v1 are not kept").toEqual([`app-${v2.digest}`]);

    // The next start sweeps what no record names: v2's files stay, and it runs.
    vi.restoreAllMocks();
    const later = apps(net);
    await later.start();
    later.stop();
    expect((await later.list()).map((a) => ({ sequence: a.sequence, run: a.run.status }))).toEqual([{ sequence: 2, run: "ok" }]);
    expect(await bundleIds()).toEqual([`app-${v2.digest}`]);
  });

  it("Open of a version replaced meanwhile fetches the installed version's files, never answering not-installed", async () => {
    const v1 = await bundle({ sequence: 1 });
    const v2 = await bundle({ sequence: 2 });
    net.put(BUNDLE_URL, v1.bytes);
    net.put(URL2, v2.bytes);
    // Both records as a Desktop kept them: v1's, and v2's once v1 was updated there.
    const first = apps(net);
    await first.preview({ url: BUNDLE_URL });
    await first.install({ digest: v1.digest, grant: ["chat"] });
    const [row1] = await appRows() as Row[];
    await first.preview({ url: URL2 });
    await first.install({ digest: v2.digest, grant: ["chat"] });
    const [row2] = await appRows() as Row[];
    for (const digest of [v1.digest, v2.digest]) await (await fileBytes()).remove(`app-${digest}`);
    const putRow = async (r: Row) => wrap((await openDb()).transaction(STORES.apps, "readwrite").objectStore(STORES.apps).put({ ...r, bytes: "native" }));
    await putRow(row1!);

    const store = apps(net);
    const engine = store as unknown as Private;
    const write = engine.writeBundle.bind(store);
    // While v1's files are written, another tab restores the profile again, from a backup made after the update: v2,
    // whose files are not here either. They are fetched in turn.
    vi.spyOn(engine, "writeBundle").mockImplementation(async (digest, bytes) => {
      const kind = await write(digest, bytes);
      if (digest === v1.digest) await putRow(row2!);
      return kind;
    });
    expect(await store.fetchFiles({ ref: v1.ref })).toEqual({ status: "ok" });
    expect(await bundleIds()).toEqual([`app-${v2.digest}`]);
    expect(((await appRows()) as Row[]).map((r) => ({ digest: r.digest, bytes: r.bytes }))).toEqual([{ digest: v2.digest, bytes: (await fileBytes()).kind }]);
  });
});
