import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeNet, apps, bundle, emptyProfile } from "./appsSupport";
// covers: apps.engine.installed

/*
 * With no app installed the update check reads nothing (WISP 1200 § Updates): it tells no page it ran, so no page reads
 * its installed apps again for it (each Apps page visit asks for a check).
 */

const URL = "https://raw.githubusercontent.com/ana/app/HEAD/app.ghostlyapp";

beforeEach(emptyProfile);

describe("an update check with no app installed", () => {
  it("tells no page, and one with an app installed tells them once", async () => {
    const net = new FakeNet();
    const checked = vi.fn();
    const store = apps(net, { checked });
    expect(await store.checkUpdates()).toEqual([]);
    expect(checked).not.toHaveBeenCalled();

    const app = await bundle();
    net.put(URL, app.bytes);
    await store.preview({ url: URL });
    await store.install({ digest: app.digest, grant: ["chat"] });
    checked.mockClear();
    expect(await store.checkUpdates()).toHaveLength(1);
    expect(checked).toHaveBeenCalledTimes(1);
  });
});
