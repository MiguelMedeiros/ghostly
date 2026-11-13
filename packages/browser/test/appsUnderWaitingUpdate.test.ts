import "fake-indexeddb/auto";
import { beforeEach, expect, it } from "vitest";
import { BUNDLE_URL, FakeNet, NOW_MS, apps, bundle, emptyProfile } from "./appsSupport";
// covers: apps.engine.installed

/*
 * A version between the installed one and the update waiting for the person's yes is never taken: Accept takes the
 * waiting one. A source that serves it (a mirror behind the publisher's own link) is peeked, not downloaded whole at
 * every update check (up to 16 MiB each, and each Apps page visit checks).
 */

const SOURCE = "https://raw.githubusercontent.com/ana/chess/HEAD/dist/app.ghostlyapp";
const MIRROR = "https://raw.githubusercontent.com/ana/chess-mirror/HEAD/app.ghostlyapp";

beforeEach(emptyProfile);

it("a version under the waiting update, at a source, is peeked at each check, never read whole", async () => {
  const net = new FakeNet();
  const store = apps(net, { now: () => NOW_MS });
  const v1 = await bundle({ sources: [SOURCE, MIRROR] });
  net.put(BUNDLE_URL, v1.bytes);
  await store.preview({ url: BUNDLE_URL });
  await store.install({ digest: v1.digest, grant: ["chat"] });
  const whole = (url: string) => net.fetch.mock.calls.filter(([at, init]) => String(at) === url && !((init?.headers ?? {}) as Record<string, string>).range).length;

  // 3 asks a new permission and waits; the mirror is behind, at 2, which asks the same.
  const v3 = await bundle({ sequence: 3, permissions: ["chat", "name"], sources: [SOURCE, MIRROR] });
  const v2 = await bundle({ sequence: 2, permissions: ["chat", "name"], sources: [SOURCE, MIRROR] });
  net.put(SOURCE, v3.bytes);
  net.put(MIRROR, v2.bytes);
  expect((await store.checkUpdates())[0]!.outcome).toBe("ask");
  for (let visit = 0; visit < 3; visit++) expect((await store.checkUpdates())[0]!.outcome).toBe("none");
  expect((await store.list())[0]!.pending).toMatchObject({ sequence: 3 });
  expect(whole(MIRROR), "only peeked").toBe(0);
});
