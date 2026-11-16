import { engineError, identityStatement, type IdentityBinding } from "@ghostly/core";
import { STORES, store, transact, wrap } from "../shared/idb";
import { createProfileKey, isSealedField, openField, rewrapProfileKey, sealField, unlockProfileKey, type ProfileKeyRecord, type SealedField } from "../shared/profileKey";
import { dropDataKey, setDataKey, setSealedOnly, type SealedSecret, type SecretPlace } from "./dataKey";
import { newDeviceKey, sealSeed, unsealSeed, type EncryptedSeed } from "./paymentAdapters/persistence";
import { walletKeyOf, type NetworkRail } from "./paymentAdapters/walletNetworks";
import { openRow, sealRow, SEALED_STORES } from "./sealedRows";

/**
 * Turning a profile's encryption on, off, and changing its passphrase (WISP 04, Encrypted profile, slice 4). Run with
 * the engine stopped: the migration is the only writer. Each step is idempotent (a value already as wanted is left),
 * so a walk cut short by a crash or a closed tab is finished by `unlockProfile` at the next start, from its mark.
 */

/** Where a client keeps the wrapped key record: the local key `ghostly_<p>_profile_key`, or the CLI's `profile-key.json`. */
export interface ProfileKeyHome {
  read(): Promise<ProfileKeyRecord | null>;
  /** Replaces the record in one write. */
  write(record: ProfileKeyRecord): Promise<void>;
  remove(): Promise<void>;
}

type Walk = "on" | "off";
type Mark = "migrating" | "decrypting";
type Row = Record<string, unknown>;

const PEER_DB = "ghostly";
/**
 * The migration's mark, in the settings store, sealed under the data key: one only the passphrase could have written,
 * so a copy of the profile can't be made to accept unsealed values again by writing it. No mark: the walk has ended.
 */
const MARK = "profileEncryption";
const MARK_AT = { db: PEER_DB, store: STORES.settings, key: MARK, field: "mark" };

const settingsAt = (key: string, field: string): SecretPlace => ({ store: STORES.settings, key, field });

/** Refused with nothing written: a Fedimint file keeps the phrase and the notes in the clear (WISP 04, What is encrypted). */
async function refuseFedimint(): Promise<void> {
  const settings = await store(STORES.settings, "readonly");
  for (const mode of ["mainnet", "testnet"]) {
    const saved = await wrap<{ federations?: unknown[] } | undefined>(settings.get(`fedimintWallet-${mode}`));
    if (saved?.federations?.length) throw engineError("encryptWithFedimint");
  }
}

/** On: a new data key, wrapped under the passphrase, then every phase 1 secret sealed under it. */
export async function encryptProfile(home: ProfileKeyHome, passphrase: string, profile: string): Promise<void> {
  if (await home.read()) throw new Error("This profile is already encrypted");
  await refuseFedimint();
  const { record, key } = await createProfileKey(passphrase, profile);
  await holding(key, async () => {
    // The mark before the record: a record is never there without its mark until the walk has ended.
    await putMark(key, "migrating");
    await home.write(record);
    await finish(home, key, "migrating");
  });
}

/** Off: every sealed secret back to how a profile that is not encrypted keeps it, then the record goes. */
export async function decryptProfile(home: ProfileKeyHome, passphrase: string, profile: string): Promise<void> {
  const key = await openRecord(home, passphrase, profile);
  await holding(key, async () => {
    await putMark(key, "decrypting");
    await finish(home, key, "decrypting");
  });
}

/** Change passphrase: the same data key under a new one, the record replaced in one write; no data is rewritten. */
export async function changeProfilePassphrase(home: ProfileKeyHome, current: string, next: string, profile: string): Promise<void> {
  const record = await home.read();
  if (!record) throw new Error("This profile is not encrypted");
  await home.write(await rewrapProfileKey(record, current, next, profile));
}

/**
 * The start of an encrypted profile: the data key into the engine's slot, and a migration cut short finished. A wrong
 * passphrase reads nothing else. False for a profile that is not encrypted (or no longer is, its turning off finished).
 */
export async function unlockProfile(home: ProfileKeyHome, passphrase: string, profile: string): Promise<boolean> {
  if (!(await home.read())) return false;
  return applyProfileKey(home, await openRecord(home, passphrase, profile));
}

/**
 * The same with the data key already unwrapped (the CLI paces its passphrase tries itself, `profile-key.json`): the
 * key into the slot, a migration cut short finished, then only sealed values read.
 */
export async function applyProfileKey(home: ProfileKeyHome, key: CryptoKey): Promise<boolean> {
  return holding(key, async () => {
    const mark = await readMark(key);
    if (mark) return finish(home, key, mark);
    setSealedOnly(true);
    return true;
  });
}

/**
 * The key in the engine's slot while `run` works, unsealed values still read (a walk under way holds both). Anything
 * that fails empties the slot: the engine does not start, and the next unlock finishes from the mark.
 */
async function holding<T>(key: CryptoKey, run: () => Promise<T>): Promise<T> {
  setDataKey(key);
  setSealedOnly(false);
  try { return await run(); } catch (error) { dropDataKey(); throw error; }
}

async function openRecord(home: ProfileKeyHome, passphrase: string, profile: string): Promise<CryptoKey> {
  const record = await home.read();
  if (!record) throw new Error("This profile is not encrypted");
  return unlockProfileKey(record, passphrase, profile);
}

/** The walk the mark says, then the mark cleared: true when the profile ends encrypted. */
async function finish(home: ProfileKeyHome, key: CryptoKey, mark: Mark): Promise<boolean> {
  const walk: Walk = mark === "migrating" ? "on" : "off";
  await walkSettings(key, walk);
  for (const name of SEALED_STORES) await walkStore(name, walk);
  if (walk === "on") {
    await transact([STORES.settings], (stores) => { stores[STORES.settings].delete(MARK); });
    setSealedOnly(true);
    return true;
  }
  // The record first: a mark left behind is a sealed value nothing reads, a record left behind would lock plain data.
  await home.remove();
  await transact([STORES.settings], (stores) => { stores[STORES.settings].delete(MARK); });
  dropDataKey();
  return false;
}

async function putMark(key: CryptoKey, mark: Mark): Promise<void> {
  const sealed = await sealField(key, MARK_AT, mark);
  await transact([STORES.settings], (stores) => { stores[STORES.settings].put(sealed, MARK); });
}

async function readMark(key: CryptoKey): Promise<Mark | undefined> {
  const sealed = await wrap<SealedField | undefined>((await store(STORES.settings, "readonly")).get(MARK));
  if (sealed === undefined) return undefined;
  const mark = await openField(key, MARK_AT, sealed);
  if (mark !== "migrating" && mark !== "decrypting") throw new Error("This profile's encryption mark is not one this version knows");
  return mark;
}

/** One phase 1 store: each row sealed (on) or opened (off) by the database layer's own field map, and written back. */
async function walkStore(name: string, walk: Walk): Promise<void> {
  const rows = await wrap<Row[]>((await store(name, "readonly")).getAll());
  const changes: { row: Row; drop?: string }[] = [];
  for (const row of rows) {
    const next = walk === "on" ? await sealRow(name, row) : await openRow(name, row);
    if (JSON.stringify(next) === JSON.stringify(row)) continue;
    // A proof is kept under its secret while plain, under that secret's hash once sealed.
    const drop = name === STORES.proofs ? String(row.secret) : undefined;
    changes.push({ row: next, drop });
  }
  if (!changes.length) return;
  await transact([name], (stores) => {
    for (const { row, drop } of changes) { if (drop !== undefined) stores[name].delete(drop); stores[name].put(row); }
  });
}

/**
 * Seals or opens one secret of the engine's own records (slice 2: `{sealed, deviceKey}` beside nothing else). Off, a
 * secret goes back to version 1 under a fresh device key, as clients write them today.
 */
function resealer(key: CryptoKey, walk: Walk) {
  const bound = (at: SecretPlace) => ({ db: PEER_DB, ...at });
  return async (secret: SealedSecret | undefined, at: SecretPlace): Promise<SealedSecret | undefined> => {
    if (!secret) return secret;
    if (walk === "on") return isSealedField(secret) ? secret : sealField(key, bound(at), await unsealSeed(secret.sealed, secret.deviceKey));
    if (!isSealedField(secret)) return secret;
    const deviceKey = newDeviceKey();
    return { sealed: await sealSeed(await openField(key, bound(at), secret), deviceKey), deviceKey };
  };
}

type WalletRecord = Row & { deviceKey?: string; automatic?: true; seed?: EncryptedSeed | SealedField };

/**
 * A wallet record's secrets: every field beside one `deviceKey` (version 1) or each under DK with none (version 2).
 * `automatic` rails (Ark, USDT) say "opens by itself" with a field of its own once the device key is gone; a seed
 * sealed with the person's own password keeps it, inside a version 2 field while the profile is encrypted.
 */
async function walletRecord(key: CryptoKey, walk: Walk, saved: WalletRecord, bindTo: string, fields: Record<string, string>, automatic: boolean): Promise<WalletRecord> {
  const at = (name: string) => ({ db: PEER_DB, store: STORES.settings, key: bindTo, field: fields[name] });
  const present = Object.keys(fields).filter((name) => saved[name] !== undefined);
  const out: WalletRecord = { ...saved };
  const password = automatic && !saved.deviceKey && !saved.automatic;
  if (walk === "on") {
    if (saved.deviceKey) {
      for (const name of present) if (!isSealedField(saved[name])) out[name] = await sealField(key, at(name), await unsealSeed(saved[name] as EncryptedSeed, saved.deviceKey));
      delete out.deviceKey;
      if (automatic) out.automatic = true;
    } else if (password && saved.seed && !isSealedField(saved.seed)) out.seed = await sealField(key, at("seed"), JSON.stringify(saved.seed));
    return out;
  }
  if (password) {
    if (isSealedField(saved.seed)) out.seed = JSON.parse(await openField(key, at("seed"), saved.seed)) as EncryptedSeed;
    return out;
  }
  if (saved.deviceKey || !present.some((name) => isSealedField(saved[name]))) return out;
  const deviceKey = newDeviceKey();
  for (const name of present) out[name] = await sealSeed(await openField(key, at(name), saved[name] as SealedField), deviceKey);
  delete out.automatic;
  return { ...out, deviceKey };
}

const RAILS: { prefix: string; rail?: NetworkRail; fields: Record<string, string>; automatic?: true }[] = [
  { prefix: "arkWallet", rail: "arkWallet", fields: { seed: "ark.seed" }, automatic: true },
  { prefix: "usdtWallet", rail: "usdtWallet", fields: { seed: "usdt.seed" }, automatic: true },
  { prefix: "barkWallet", rail: "barkWallet", fields: { seed: "bark.seed" } },
  { prefix: "sparkWallet", rail: "sparkWallet", fields: { seed: "spark.seed", apiKey: "spark.apiKey" } },
];

/** The wallet a settings key holds, and the key its secrets are bound to; undefined for any other record. */
function walletOf(name: string, saved: Row): { bindTo: string; fields: Record<string, string>; automatic: boolean } | undefined {
  for (const { prefix, rail, fields, automatic } of RAILS) {
    if (name !== prefix && !name.startsWith(`${prefix}-mode-`) && !name.startsWith(`${prefix}-retired-`)) continue;
    const bindTo = walletKeyOf(rail!, saved);
    return bindTo ? { bindTo, fields, automatic: !!automatic } : undefined;
  }
  const fedimint = /^fedimintWallet-(?:retired-)?(mainnet|testnet)(?:-|$)/.exec(name);
  if (fedimint) return { bindTo: `fedimintWallet-${fedimint[1]}`, fields: { seed: "fedimint.seed" }, automatic: false };
  if (/^(lightning|onchain)Source-(mainnet|testnet)(-|$)/.test(name)) return { bindTo: name, fields: { secrets: "providerSource.secrets" }, automatic: false };
  return undefined;
}

type Reseal = ReturnType<typeof resealer>;
type Secretful = Row & { seed?: SealedSecret };
const each = <T extends Row>(list: unknown, change: (item: T) => Promise<T>) => Array.isArray(list) ? Promise.all((list as T[]).map(change)) : Promise.resolve(list);

/** The engine's own records with secrets in the settings store (slice 2), each with the binding its reader uses. */
const OWN: Record<string, (value: Row, reseal: Reseal) => Promise<unknown>> = {
  profileDid: async (did, reseal) => ({ ...did, seed: await reseal(did.seed as SealedSecret, settingsAt("profileDid", "did.seed")) }),
  identityProofs: (proofs, reseal) => each<Secretful>(proofs, async (p) => ({ ...p, seed: await reseal(p.seed, settingsAt(identityStatement(p.binding as IdentityBinding).id, "identityProof.seed")) })),
  identityRevocations: (revocations, reseal) => each<Secretful>(revocations, async (r) => ({ ...r, seed: await reseal(r.seed, settingsAt(String(r.id), "identityProof.seed")) })),
  contactAsks: (asks, reseal) => each<Secretful>(asks, async (a) => ({ ...a, seed: await reseal(a.seed, settingsAt(String(a.link), "contactAsk.seed")) })),
  contactLinks: async (links, reseal) => {
    const link = async (l: Secretful) => ({ ...l, seed: await reseal(l.seed, settingsAt(String(l.linkKeyZ32), "contactLink.seed")) });
    return { ...links, ...(links.current ? { current: await link(links.current as Secretful) } : {}), ...(links.retired ? { retired: await each<Secretful>(links.retired, link) } : {}) };
  },
  x401Credentials: async (x401, reseal) => ({ ...x401, keys: await each<Row>(x401.keys, async (k) => ({ ...k, secret: await reseal(k.secret as SealedSecret, settingsAt(String(k.id), "x401.holderKey")) })) }),
};

async function walkSettings(key: CryptoKey, walk: Walk): Promise<void> {
  const settings = await store(STORES.settings, "readonly");
  const [names, values] = await Promise.all([wrap<IDBValidKey[]>(settings.getAllKeys()), wrap<unknown[]>(settings.getAll())]);
  const reseal = resealer(key, walk);
  const changes = new Map<string, unknown>();
  for (const [i, name] of names.entries()) {
    const value = values[i];
    if (typeof name !== "string" || !value || typeof value !== "object") continue;
    const wallet = walletOf(name, value as Row);
    const next = wallet ? await walletRecord(key, walk, value as WalletRecord, wallet.bindTo, wallet.fields, wallet.automatic)
      : OWN[name] ? await OWN[name](value as Row, reseal) : value;
    if (JSON.stringify(next) !== JSON.stringify(value)) changes.set(name, next);
  }
  if (changes.size) await transact([STORES.settings], (stores) => { for (const [name, value] of changes) stores[STORES.settings].put(value, name); });
}
