import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_STATEMENT_LIMITS, canonicalJsonBytes, utf8Encode } from "@ghostly/core";
import { BUNDLE_URL, FakeNet, REPO, apps, bundle, emptyProfile, revocation } from "./appsSupport";
// covers: apps.engine.installed

/*
 * A `ghostly-revoke.json` is read one entry at a time, each found by a scan that parses nothing, so a large file of
 * junk beside an app link is refused at its first entry: the page's thread never parses the whole file in one step.
 */

let net: FakeNet;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
});
afterEach(() => { vi.restoreAllMocks(); });

/** About `bytes` of a list of `entry`, under the 16 MiB a revocations file may hold. */
const junk = (entry: string, bytes: number) => utf8Encode(`[${Array.from({ length: Math.floor((bytes - 2) / (entry.length + 1)) }, () => entry).join(",")}]`);

describe("a large ghostly-revoke.json", () => {
  it("of junk beside a pasted link is refused with nothing larger than one entry parsed, and the app previews", async () => {
    const v1 = await bundle({ sources: [BUNDLE_URL] });
    net.put(BUNDLE_URL, v1.bytes);
    net.put(`${REPO}/ghostly-revoke.json`, junk("{}", 16 * 1024 * 1024 - 1));
    const store = apps(net);

    const parse = vi.spyOn(JSON, "parse");
    expect((await store.preview({ url: BUNDLE_URL })).run).toEqual({ status: "ok" });
    expect(Math.max(0, ...parse.mock.calls.map(([text]) => String(text).length))).toBeLessThanOrEqual(APP_STATEMENT_LIMITS.revocationBytes);
  });

  it("with an entry larger than any revocation after a good one is refused whole, its revocations taken from none", async () => {
    const v1 = await bundle({ sources: [BUNDLE_URL] });
    net.put(BUNDLE_URL, v1.bytes);
    const revoked = await revocation(v1.ref, [v1.digest], "Leaks chats");
    const good = canonicalJsonBytes([revoked]);
    const large = utf8Encode(`,"${"x".repeat(APP_STATEMENT_LIMITS.revocationBytes)}"]`);
    net.put(`${REPO}/ghostly-revoke.json`, new Uint8Array([...good.subarray(0, -1), ...large]));
    expect((await apps(net).preview({ url: BUNDLE_URL })).run).toEqual({ status: "ok" });

    net.put(`${REPO}/ghostly-revoke.json`, good);
    expect((await apps(net).preview({ url: BUNDLE_URL })).run).toEqual({ status: "revoked", reason: "Leaks chats" });
  });
});
