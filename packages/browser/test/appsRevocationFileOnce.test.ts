import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { APP_PREFIXES, canonicalJsonBytes, setAppSignatureFastPath, toBase64Url, utf8Encode } from "@ghostly/core";
import { FakeNet, apps, bundle, emptyProfile, revocation } from "./appsSupport";
// covers: apps.engine.installed

/*
 * Apps whose bundles sit in one folder share its `ghostly-revoke.json`, and the update check reads a few apps side by
 * side: each revocation in the file is checked once, not once per app reading it at the same time.
 */

const FOLDER = "https://raw.githubusercontent.com/ana/suite/HEAD";
const APPS = 6;
const ENTRIES = 300;

/** Revocation signatures checked since the test began: the fast path is asked of each one, and its no leaves the strict check. */
let checked = 0;
const REVOKE = utf8Encode(`${APP_PREFIXES.revoke}\0`);
beforeEach(async () => {
  await emptyProfile();
  checked = 0;
  setAppSignatureFastPath((_sig, message) => {
    if (REVOKE.every((b, i) => message[i] === b)) checked++;
    return false;
  });
});
afterEach(() => setAppSignatureFastPath(null));

describe("a revocation file shared by apps in one folder", () => {
  it("is checked once by an update check that reads it for each of them", async () => {
    const net = new FakeNet();
    const store = apps(net);
    const refs: string[] = [];
    for (let i = 0; i < APPS; i++) {
      const app = await bundle({ name: `app${i}` });
      net.put(`${FOLDER}/app${i}.ghostlyapp`, app.bytes);
      await store.preview({ url: `${FOLDER}/app${i}.ghostlyapp` });
      await store.install({ digest: app.digest, grant: ["chat"] });
      refs.push(app.ref);
    }
    // Builds none of them runs: long enough that the readers overlap.
    const digest = (k: number) => toBase64Url(sha256(utf8Encode(`a revoked build ${k}`)));
    const file = await Promise.all(Array.from({ length: ENTRIES }, (_, k) => revocation(refs[k % APPS]!, [digest(k)])));
    net.put(`${FOLDER}/ghostly-revoke.json`, canonicalJsonBytes(file as never));

    checked = 0;
    const results = await store.checkUpdates();
    expect(results.map((r) => r.outcome)).toEqual(Array(APPS).fill("none"));
    expect(checked, "each revocation of the file once").toBe(ENTRIES);

    checked = 0;
    await store.checkUpdates();
    expect(checked, "the same bytes again: none").toBe(0);
  }, 120_000);
});
