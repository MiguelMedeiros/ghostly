import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalJsonBytes } from "@ghostly/core";
import { BUNDLE_URL, FakeNet, REPO, apps, appRows, bundle, emptyProfile, revocation } from "./appsSupport";
// covers: apps.engine.installed

/*
 * A version installed from a contact's card or a pasted URL takes that URL as where it came from, and its own sources.
 * The publisher's `ghostly-revoke.json` is still read beside where the earlier versions came from and the sources they
 * named (WISP 1200 § Publisher keys: the publisher revokes a version where it still can), within a bound.
 */

const ELSEWHERE = "https://raw.githubusercontent.com/someone/chess/HEAD";
const ELSEWHERE_URL = `${ELSEWHERE}/app.ghostlyapp`;
const revokeFiles = (net: FakeNet) => net.requests.filter((u) => u.endsWith("/ghostly-revoke.json"));

let net: FakeNet;
beforeEach(async () => {
  await emptyProfile();
  net = new FakeNet();
});

async function installOriginal() {
  const v1 = await bundle({ sources: [BUNDLE_URL] });
  net.put(BUNDLE_URL, v1.bytes);
  const store = apps(net);
  await store.preview({ url: BUNDLE_URL });
  await store.install({ digest: v1.digest, grant: ["chat"] });
  return { v1, store };
}

/** A newer version that names only URLs elsewhere, installed from a contact's card. */
async function installFromCard(store: ReturnType<typeof apps>, sequence: number, url: string, sources: string[]) {
  const v = await bundle({ sequence, sources });
  net.put(url, v.bytes);
  await store.preview({ card: { ref: v.ref, url, sequence: v.sequence, digest: v.digest } });
  await store.install({ digest: v.digest, grant: ["chat"] });
  return v;
}

describe("revocations beside where an app's earlier versions came from", () => {
  it("the update check reads the publisher's file beside the first version's source after a card installed one naming only others", async () => {
    const { store } = await installOriginal();
    const v2 = await installFromCard(store, 2, ELSEWHERE_URL, [ELSEWHERE_URL]);
    // The publisher revokes it where it published the app.
    net.put(`${REPO}/ghostly-revoke.json`, canonicalJsonBytes([await revocation(v2.ref, [v2.digest], "Signed with a stolen key")]));

    await store.checkUpdates();
    expect(await store.runCheck({ ref: v2.ref })).toEqual({ status: "revoked", reason: "Signed with a stolen key" });
  });

  it("the install screen of a card's version naming only other URLs reads beside the installed one's source", async () => {
    const { store } = await installOriginal();
    const v2 = await bundle({ sequence: 2, sources: [ELSEWHERE_URL] });
    net.put(ELSEWHERE_URL, v2.bytes);
    net.put(`${REPO}/ghostly-revoke.json`, canonicalJsonBytes([await revocation(v2.ref, [v2.digest], "Signed with a stolen key")]));

    const preview = await store.preview({ card: { ref: v2.ref, url: ELSEWHERE_URL, sequence: v2.sequence, digest: v2.digest } });
    expect(preview.run).toEqual({ status: "revoked", reason: "Signed with a stolen key" });
    await expect(store.install({ digest: v2.digest, grant: ["chat"] })).rejects.toThrow(/^revoked/);
  });

  it("keeps at most 16 places, the first ones met: later versions naming many do not push the first source out", async () => {
    const { store } = await installOriginal();
    const many = (v: number) => Array.from({ length: 8 }, (_, i) => `https://raw.githubusercontent.com/other${v}x${i}/chess/HEAD/app.ghostlyapp`);
    let last;
    for (let v = 2; v <= 5; v++) last = await installFromCard(store, v, `https://raw.githubusercontent.com/card${v}/chess/HEAD/app.ghostlyapp`, many(v));
    const [row] = await appRows() as { formerSources?: string[] }[];
    expect(row!.formerSources).toHaveLength(16);
    expect(row!.formerSources![0]).toBe(`${REPO}/ghostly-revoke.json`);

    net.put(`${REPO}/ghostly-revoke.json`, canonicalJsonBytes([await revocation(last!.ref, [last!.digest])]));
    net.requests.length = 0;
    await store.checkUpdates();
    expect(await store.runCheck({ ref: last!.ref })).toEqual({ status: "revoked", reason: "Leaked key" });
    // Its own URL and 8 sources, and the 16 kept.
    expect(new Set(revokeFiles(net)).size).toBeLessThanOrEqual(9 + 16);
  });

  it("an app that never changed version reads only beside its own URL and sources, as before", async () => {
    const { v1, store } = await installOriginal();
    expect(await appRows()).toEqual([expect.not.objectContaining({ formerSources: expect.anything() })]);
    net.requests.length = 0;
    await store.checkUpdates();
    expect(new Set(revokeFiles(net))).toEqual(new Set([`${REPO}/ghostly-revoke.json`]));
    expect(await store.runCheck({ ref: v1.ref })).toEqual({ status: "ok" });
  });
});
