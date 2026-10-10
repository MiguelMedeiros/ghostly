import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as core from "@ghostly/core";
import { canonicalJsonBytes, readAppRevocation, signAppRevocation, type SignedAppRevocation } from "@ghostly/core";
import { BUNDLE_URL, FakeNet, PUBLISHER, REPO, apps, bundle, emptyProfile, keyOf, revocation } from "./appsSupport";
// covers: apps.engine.installed

/*
 * A publisher's `ghostly-revoke.json` (WISP 1200 § Publisher keys) holds up to 4096 signed revocations, each an Ed25519
 * verify of about a millisecond. The engine runs in the page on the web and Desktop, so an update check verifies them in
 * short slices, and a file it already verified (the same bytes) is not verified again.
 */

vi.mock("@ghostly/core", async (importOriginal) => {
  const actual = await importOriginal<typeof core>();
  return { ...actual, readAppRevocation: vi.fn(actual.readAppRevocation) };
});
const verifies = vi.mocked(readAppRevocation);

let net: FakeNet;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
  verifies.mockClear();
});

/** The longest time between 1 ms timer ticks while `work` runs: how long the thread the page shares was held. */
async function longestHold(work: () => Promise<unknown>): Promise<number> {
  let last = performance.now(), longest = 0, on = true;
  const tick = () => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; if (on) setTimeout(tick, 1); };
  setTimeout(tick, 1);
  await work();
  on = false;
  await new Promise((resolve) => setTimeout(resolve, 5));
  return longest;
}

describe("a publisher's ghostly-revoke.json", () => {
  it("is verified in short slices at an update check, and not again while its bytes are the same", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    const list: SignedAppRevocation[] = [await revocation(v1.ref, [v1.digest])];
    for (let i = 0; i < 399; i++) list.push(await signAppRevocation({ ghostlyRevoke: 1, app: `${keyOf(PUBLISHER)}/other-${i}`, upTo: 1 + i }, PUBLISHER));
    net.put(`${REPO}/ghostly-revoke.json`, canonicalJsonBytes(list));
    verifies.mockClear();

    expect(await longestHold(() => store.checkUpdates())).toBeLessThan(100);
    expect(verifies).toHaveBeenCalledTimes(400);
    expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "revoked", reason: "Leaked key" });

    await store.checkUpdates();
    expect(verifies).toHaveBeenCalledTimes(400);
    expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "revoked", reason: "Leaked key" });
  }, 60_000);

  it("one entry that does not verify still refuses the whole file, even one naming another app", async () => {
    const v1 = await bundle();
    net.put(BUNDLE_URL, v1.bytes);
    const store = apps(net);
    await store.preview({ url: BUNDLE_URL });
    await store.install({ digest: v1.digest, grant: ["chat"] });
    const other = await signAppRevocation({ ghostlyRevoke: 1, app: `${keyOf(PUBLISHER)}/other`, upTo: 1 }, PUBLISHER);
    const forged = { statement: { ...other.statement, upTo: 2 }, signature: other.signature };
    net.put(`${REPO}/ghostly-revoke.json`, canonicalJsonBytes([await revocation(v1.ref, [v1.digest]), forged]));
    await store.checkUpdates();
    expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "ok" });
  });
});
