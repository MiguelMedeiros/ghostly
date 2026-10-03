import "fake-indexeddb/auto";
import { afterEach, expect, it } from "vitest";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { setDatabaseName, wrap } from "../src/shared/idb";
import { BREEZ_DATABASE, breezDatabase, breezDatabaseName, breezDatabasesFor, breezDatabasesOf, breezLegacyName, dropBreezDatabase, dropBreezDatabasesOf } from "../src/engine/paymentAdapters/providers/breezDatabases";
import { breezOpen, forgetBreez, openBreez } from "../src/engine/paymentAdapters/providers/breezSdk";
import { BreezLightning } from "../src/engine/paymentAdapters/providers/breez";
import { SparkAdapter } from "../src/engine/paymentAdapters/spark";
import { FakeBreezNetwork } from "./helpers/fakeBreez";
// covers: wallet.spark.storage

const phrase = () => generateMnemonic(wordlist);
const ORIGINAL = "ghostly", COPY = "ghostly_restoredcopy";
afterEach(() => setDatabaseName("ghostly"));

/** A database as the SDK leaves one: something in it, under its name. */
async function makeDatabase(name: string) {
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => { request.result.createObjectStore("data"); };
  (await wrap(request)).close();
}
const databases = async () => (await indexedDB.databases()).map((d) => d.name);

it("a Breez database is named per profile, network and phrase, and the name shows none of them", () => {
  const mnemonic = phrase();
  const name = breezDatabaseName("regtest", mnemonic, ORIGINAL);
  expect(name).toMatch(BREEZ_DATABASE);
  expect(breezLegacyName("regtest", mnemonic)).toMatch(BREEZ_DATABASE);
  expect(breezDatabaseName("regtest", mnemonic, ORIGINAL), "the same every time").toBe(name);
  expect(breezDatabaseName("regtest", mnemonic, COPY), "another profile").not.toBe(name);
  expect(breezDatabaseName("bitcoin", mnemonic, ORIGINAL), "another network").not.toBe(name);
  expect(breezDatabaseName("bitcoin", mnemonic, ORIGINAL)).toMatch(/^ghostly-breez-mainnet-/);
  expect(breezDatabaseName("regtest", phrase(), ORIGINAL), "another phrase").not.toBe(name);
  expect(breezLegacyName("regtest", mnemonic), "the old shared name is not a profile's").not.toBe(name);
  for (const word of mnemonic.split(" ")) expect(name.slice("ghostly-breez-regtest-".length)).not.toContain(word);
  expect(breezDatabaseName("regtest", mnemonic, COPY)).not.toContain("restoredcopy");
});

it("an old shared database stays the first profile's to open it; a copy on the same device gets a database of its own", async () => {
  const mnemonic = phrase();
  const legacy = breezLegacyName("regtest", mnemonic);
  await makeDatabase(legacy);
  expect(await breezDatabase("regtest", mnemonic, ORIGINAL), "the profile that has been using it keeps it").toBe(legacy);
  expect(await breezDatabase("regtest", mnemonic, COPY), "the copy starts from the phrase").toBe(breezDatabaseName("regtest", mnemonic, COPY));
  expect(await breezDatabase("regtest", mnemonic, ORIGINAL), "kept on every later open").toBe(legacy);
  expect(await breezDatabase("regtest", mnemonic, COPY)).toBe(breezDatabaseName("regtest", mnemonic, COPY));
  expect(await breezDatabasesOf(ORIGINAL)).toContain(legacy);
  expect(await breezDatabasesOf(COPY)).toEqual([breezDatabaseName("regtest", mnemonic, COPY)]);
});

it("two profiles opening one phrase at once never both take the old database", async () => {
  const mnemonic = phrase();
  const legacy = breezLegacyName("regtest", mnemonic);
  await makeDatabase(legacy);
  const names = await Promise.all([breezDatabase("regtest", mnemonic, "ghostly_racea"), breezDatabase("regtest", mnemonic, "ghostly_raceb")]);
  expect(names.filter((n) => n === legacy)).toHaveLength(1);
  expect(new Set(names).size).toBe(2);
});

it("with no old database, a profile opens its own name, and a profile that once had its own never moves to an old one", async () => {
  const mnemonic = phrase();
  const own = breezDatabaseName("regtest", mnemonic, ORIGINAL);
  expect(await breezDatabase("regtest", mnemonic, ORIGINAL)).toBe(own);
  // An old build in another tab makes the old one later: this profile's data is in its own.
  await makeDatabase(breezLegacyName("regtest", mnemonic));
  expect(await breezDatabase("regtest", mnemonic, ORIGINAL)).toBe(own);
});

it("a same-device copy: two profiles, one phrase, two SDK instances over two databases; the original keeps its wallet", async () => {
  const net = new FakeBreezNetwork();
  const mnemonic = phrase();
  await makeDatabase(breezLegacyName("regtest", mnemonic));
  setDatabaseName(ORIGINAL);
  const original = await SparkAdapter.connect({ network: "regtest", mnemonic }, async () => net.sdk);
  net.wallets.get(original.storage)!.balance = 2100;
  setDatabaseName(COPY);
  const copy = await SparkAdapter.connect({ network: "regtest", mnemonic }, async () => net.sdk);
  expect(copy.storage).not.toBe(original.storage);
  expect(original.storage, "the original kept the database it had").toBe(breezLegacyName("regtest", mnemonic));
  expect(copy.storage).toBe(breezDatabaseName("regtest", mnemonic, COPY));
  expect(net.connects.map((c) => c.storage)).toEqual([original.storage, copy.storage]);
  expect(net.connects.every((c) => c.mnemonic === mnemonic), "both from the one phrase").toBe(true);
  expect(await original.balance()).toBe(2100);
  expect(net.wallets.get(copy.storage), "the copy did not open the original's wallet").not.toBe(net.wallets.get(original.storage));
  await original.close(); await copy.close();
});

it("in one profile, the Spark wallet and a Breez card of one phrase stay one wallet", async () => {
  const net = new FakeBreezNetwork();
  const mnemonic = phrase();
  const spark = await SparkAdapter.connect({ network: "regtest", mnemonic }, async () => net.sdk);
  const card = await BreezLightning.connect({ network: "regtest", mnemonic }, async () => net.sdk);
  expect(card.storage).toBe(spark.storage);
  expect(net.connects, "one SDK instance").toHaveLength(1);
  await spark.close(); await card.close();
});

it("removing a wallet deletes its Breez databases, unless the other wallet of that phrase still has them open", async () => {
  const net = new FakeBreezNetwork();
  const mnemonic = phrase();
  const spark = await SparkAdapter.connect({ network: "regtest", mnemonic }, async () => net.sdk);
  const card = await BreezLightning.connect({ network: "regtest", mnemonic }, async () => net.sdk);
  const name = spark.storage;
  for (const file of [name, `${name}-tree`]) await makeDatabase(file);
  await spark.close();
  await forgetBreez(name);
  expect(breezOpen(name)).toBe(true);
  expect(await databases(), "the card still runs on it").toContain(name);
  await card.forget();
  expect(breezOpen(name)).toBe(false);
  expect(await databases()).not.toContain(name);
  expect(await databases(), "the SDK's second database too").not.toContain(`${name}-tree`);
  expect(await breezDatabasesOf("ghostly")).not.toContain(name);
});

it("deleting a profile's Breez databases leaves every other profile's, and refuses a name that is not Breez's", async () => {
  const mnemonic = phrase();
  const gone = await breezDatabase("regtest", mnemonic, "ghostly_goneprof");
  const kept = await breezDatabase("regtest", mnemonic, "ghostly_keptprof");
  for (const name of [gone, `${gone}-tree`, kept, `${kept}-tree`, "ghostly_keptprof"]) await makeDatabase(name);
  expect(await breezDatabasesFor("regtest", mnemonic, "ghostly_goneprof")).toEqual([gone]);
  await dropBreezDatabasesOf("ghostly_goneprof");
  const left = await databases();
  expect(left).not.toContain(gone);
  expect(left).not.toContain(`${gone}-tree`);
  expect(left).toEqual(expect.arrayContaining([kept, `${kept}-tree`]));
  await dropBreezDatabase("ghostly_keptprof");
  expect(await databases(), "only Breez names are deleted").toContain("ghostly_keptprof");
});

it("a browser without indexedDB.databases() still tells an old database apart from none, and makes none while looking", async () => {
  const list = indexedDB.databases;
  const [there, absent] = [phrase(), phrase()];
  await makeDatabase(breezLegacyName("regtest", there));
  Object.defineProperty(indexedDB, "databases", { value: undefined, configurable: true });
  try {
    expect(await breezDatabase("regtest", there, "ghostly_nolistprof")).toBe(breezLegacyName("regtest", there));
    expect(await breezDatabase("regtest", absent, "ghostly_nolistprof")).toBe(breezDatabaseName("regtest", absent, "ghostly_nolistprof"));
  } finally { Object.defineProperty(indexedDB, "databases", { value: list, configurable: true }); }
  expect(await databases(), "looking did not make the old one").not.toContain(breezLegacyName("regtest", absent));
});

it("openBreez names the storage the profile uses at the time it opens", async () => {
  const net = new FakeBreezNetwork();
  const mnemonic = phrase();
  setDatabaseName("ghostly_otherprof");
  const opened = await openBreez({ network: "regtest", mnemonic }, async () => net.sdk);
  expect(opened.storage).toBe(breezDatabaseName("regtest", mnemonic, "ghostly_otherprof"));
  await opened.release();
});
