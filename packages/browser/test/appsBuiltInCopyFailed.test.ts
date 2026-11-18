import "fake-indexeddb/auto";
import { beforeEach, expect, it } from "vitest";
import type { BuiltInApp } from "../src/engine/appDefaults";
import { AppFetchError } from "../src/engine/appFetch";
import { BUNDLE_URL, FakeNet, PUBLISHER, appRows, apps, bundle, bundleIds, emptyProfile, keyOf } from "./appsSupport";
// covers: apps.engine.built-in

/*
 * A built-in app's first Open reads the client's own copy (WISP 1200 § Built-in apps), which the client keeps for use
 * offline only once it was read. A read of it that failed for a reason that may pass (offline, the host not reached,
 * its own trouble) is said as that, so the install screen offers Try again; only a build with no such file, or a
 * file the host no longer has, is an app this build does not carry.
 */

const REF = `${keyOf(PUBLISHER)}/chess`;
beforeEach(emptyProfile);

it("a passing failure of the client's read is said as it came, and a read again that works opens it", async () => {
  const v1 = await bundle();
  const chess: BuiltInApp = { publisher: keyOf(PUBLISHER), name: "chess", digest: v1.digest, url: BUNDLE_URL, title: "Chess", tagline: "Play chess" };
  let failure: Error | null = null;
  const net = new FakeNet();
  const store = apps(net, { readBuiltIn: async () => { if (failure) throw failure; return v1.bytes.slice(); }, builtIns: [chess] });
  const said = async () => store.preview({ builtIn: REF }).then(() => "read", (e: Error) => e.message);
  failure = new AppFetchError("offline", "Offline");
  expect(await said()).toBe("offline: Offline");
  failure = new AppFetchError("network", "Failed to fetch");
  expect(await said()).toBe("network: Failed to fetch");
  failure = new AppFetchError("status", "The host answered 503", 503);
  expect(await said()).toBe("status: The host answered 503");
  failure = new AppFetchError("slow", "That took too long on this connection");
  expect(await said()).toBe("slow: That took too long on this connection");
  // Nothing of it was kept meanwhile; back online, it opens from the build.
  expect(await appRows()).toEqual([]);
  expect(await bundleIds()).toEqual([]);
  failure = null;
  expect(await said()).toBe("read");
  expect(net.requests).toEqual([]);
  store.stop();
});

it("a file the host no longer has, or any other failure, is an app this build does not carry", async () => {
  const v1 = await bundle();
  const chess: BuiltInApp = { publisher: keyOf(PUBLISHER), name: "chess", digest: v1.digest, url: BUNDLE_URL, title: "Chess", tagline: "Play chess" };
  for (const failure of [new AppFetchError("status", "The host answered 404", 404), new AppFetchError("too-large", "Too large"), new Error("This build does not carry this app"), new TypeError("Failed to fetch")]) {
    const store = apps(new FakeNet(), { readBuiltIn: async () => { throw failure; }, builtIns: [chess] });
    await expect(store.preview({ builtIn: REF }), failure.message).rejects.toThrow(/^not-carried: This build does not carry this app$/);
    store.stop();
  }
});
