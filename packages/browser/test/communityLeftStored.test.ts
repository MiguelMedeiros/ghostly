import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommunityLeaveFrame, CommunityState } from "@ghostly/core";
import { db } from "../src/engine/db";
import { dropDataKey, setDataKey } from "../src/engine/dataKey";
import { createProfileKey } from "../src/shared/profileKey";
import { clearProfileStores, openDb, wrap } from "../src/shared/idb";
import type { StoredLeftCommunity } from "../src/shared/types";
// covers: groups.leave

/*
 * A community I left whose chain my app still follows is kept in a row of its own (`StoredLeftCommunity`, settings
 * store), so a restart resumes the follow. A version from before reads none of it: its groups and settings come back
 * as they were. Its member seed and epoch secrets are sealed as a group record's are.
 */

const derive = crypto.subtle.deriveKey.bind(crypto.subtle);
const dataKey = async () => {
  vi.spyOn(crypto.subtle, "deriveKey").mockImplementationOnce(((algorithm: Pbkdf2Params, ...rest: [CryptoKey, AesKeyGenParams, boolean, KeyUsage[]]) =>
    derive({ ...algorithm, iterations: 1_000 }, ...rest)) as typeof crypto.subtle.deriveKey);
  return (await createProfileKey("throwaway passphrase 1", "")).key;
};
async function rawDatabase(): Promise<string> {
  const database = await openDb();
  const names = [...database.objectStoreNames];
  const tx = database.transaction(names, "readonly");
  return JSON.stringify(await Promise.all(names.map((name) => wrap(tx.objectStore(name).getAll()))));
}

const SECRETS = ["left-member-seed", "left-epoch-secret", "left-entry-seed", "left-rendezvous-secret"];
const left = {
  id: "g1",
  community: { id: "g1", status: "left", seedB64: SECRETS[0], secrets: { h1: SECRETS[1] }, entry: { key: "entry-public-key", seedB64: SECRETS[2] }, rv: SECRETS[3], chain: [] } as unknown as CommunityState,
  frame: { t: "group-leave", v: 2, g: "g1", s: "member-key", ls: "signature" } as CommunityLeaveFrame,
  since: 1_000, heard: ["other-key"], kept: "h1",
} satisfies StoredLeftCommunity;

beforeEach(async () => { dropDataKey(); await clearProfileStores(); });
afterEach(() => { dropDataKey(); vi.restoreAllMocks(); });

describe("a community left whose chain the app follows, as stored", () => {
  it("reads back as written, and is gone once deleted", async () => {
    await db.putGroupLeft(left);
    expect(await db.getGroupsLeft()).toEqual([left]);
    await db.deleteGroupLeft("g1");
    expect(await db.getGroupsLeft()).toEqual([]);
  });

  it("is read by none of the readers a version from before has: its groups and settings are as they were", async () => {
    await db.putSettings({ name: "me" } as never);
    await db.putGroupLeft(left);
    expect(await db.getGroups()).toEqual([]);
    expect(await db.getSettings()).toEqual({ name: "me" });
    expect((await db.getGroupLive()).size).toBe(0);
    expect((await db.getGroupLight()).size).toBe(0);
  });

  it("with the data key, its member seed and secrets are sealed, and read back as they were", async () => {
    setDataKey(await dataKey());
    await db.putGroupLeft(left);
    expect(await db.getGroupsLeft()).toEqual([left]);
    const raw = await rawDatabase();
    expect(SECRETS.filter(secret => raw.includes(secret))).toEqual([]);
  });

  it("goes with the rest of the profile on Clear all data", async () => {
    await db.putGroupLeft(left);
    await clearProfileStores();
    expect(await db.getGroupsLeft()).toEqual([]);
  });
});
