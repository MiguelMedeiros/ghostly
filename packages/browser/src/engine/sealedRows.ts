import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { STORES } from "../shared/idb";
import { isSealedField, type SealedField } from "../shared/profileKey";
import { hasDataKey, openSecret, sealPlace, takesUnsealed, type SecretPlace } from "./dataKey";

/**
 * Phase 1 of the encrypted profile (WISP 04, What is encrypted): the fields of the peer database that let someone act
 * as the person or spend, by store, as paths into the row. With the data key set they are written sealed (version 2,
 * bound to the store, the row's key and the path) and opened as they are read; without it, rows are written and read
 * as they always were. A field is sealed as its JSON, so an object (transport seeds, epoch secrets) is one field.
 */
const FIELDS: Record<string, readonly string[]> = {
  [STORES.links]: ["seedB64", "encKeyB64", "participationSeed", "transportSeeds", "inviteCode", "pairedPeerKey", "peerTrust.verifiedKey", "ratchetState"],
  [STORES.groups]: ["invitation.seedB64", "entry.seedB64", "joining.seedB64", "state.seedB64", "state.secrets", "community.seedB64", "community.secrets", "community.entry.seedB64", "community.rv"],
  [STORES.swaps]: ["swap", "token"],
  [STORES.melts]: ["secrets", "outputs"],
};
/** A group removed and invited again keeps the group it was (`previous`), with secrets of its own. */
const NESTED: Record<string, string> = { [STORES.groups]: "previous" };

/**
 * A proof's secret is its row's key (`keyPath: "secret"`), and a sealed value can't be one: a sealed proof is kept under
 * this hash of its secret, the secret itself sealed beside it. The hash, not the secret, can be found again inside a
 * transaction, where WebCrypto can't be waited for.
 */
export const proofKey = (secret: string): string => bytesToHex(sha256(utf8ToBytes(`ghostly-proof/1\n${secret}`)));
const SEALED_SECRET = "sealedSecret";

type Row = Record<string, unknown>;
type Seal = (json: string, at: SecretPlace) => SealedField;

const keyOf = (store: string, row: Row) => String(store === STORES.melts ? row.quote : row.id);

function read(row: Row, path: string): unknown {
  return path.split(".").reduce<unknown>((at, part) => (at && typeof at === "object" ? (at as Row)[part] : undefined), row);
}
/** The row with `value` at `path`, copied along the way: the caller's row is never changed. */
function written(row: Row, [part, ...rest]: string[], value: unknown): Row {
  return { ...row, [part]: rest.length ? written(row[part] as Row, rest, value) : value };
}

/** Every phase 1 value of a row that is there, with its path. */
function places(store: string, row: Row, prefix = ""): { path: string; value: unknown }[] {
  const found = (FIELDS[store] ?? []).map((path) => ({ path: prefix + path, value: read(row, path) })).filter(({ value }) => value !== undefined);
  const nested = NESTED[store] && row[NESTED[store]];
  return nested && typeof nested === "object" ? [...found, ...places(store, nested as Row, `${prefix}${NESTED[store]}.`)] : found;
}

function sealWith<T>(store: string, value: T, seal: Seal): T {
  const row = value as Row;
  if (store === STORES.proofs) {
    if (row[SEALED_SECRET] !== undefined) return value;
    const secret = String(row.secret), key = proofKey(secret);
    return { ...row, secret: key, [SEALED_SECRET]: seal(JSON.stringify(secret), { store, key, field: "secret" }) } as T;
  }
  const key = keyOf(store, row);
  let out = row;
  for (const { path, value: at } of places(store, row)) {
    if (!isSealedField(at)) out = written(out, path.split("."), seal(JSON.stringify(at), { store, key, field: path }));
  }
  return out as T;
}

const slotOf = (json: string, at: SecretPlace) => [at.store, at.key, at.field, json].join("\n");

/**
 * Seals made ahead of a transaction, for `row` to use inside it: IndexedDB commits a transaction that waits for
 * anything else, WebCrypto included. Whether rows are sealed is fixed when this is made, so a key dropped meanwhile
 * makes a write fail, never go out in the clear.
 */
export class RowSeals {
  /** Seals are made one batch after another, so writes that seal first are saved in the order they were asked for. */
  private static turn: Promise<unknown> = Promise.resolve();
  readonly on = hasDataKey();
  private ready = new Map<string, SealedField>();

  /** What these rows (or the proofs of these secrets) hold, sealed now. */
  async prepare(store: string, rows: readonly object[]): Promise<this> {
    if (!this.on) return this;
    const wanted = new Map<string, [string, SecretPlace]>();
    for (const row of rows) sealWith(store, row, (json, at) => { wanted.set(slotOf(json, at), [json, at]); return { v: 2, iv: "", ct: "" }; });
    const sealing = RowSeals.turn.then(async () => {
      for (const [slot, [json, at]] of wanted) if (!this.ready.has(slot)) this.ready.set(slot, await sealPlace(json, at));
    });
    RowSeals.turn = sealing.catch(() => {});
    await sealing;
    return this;
  }

  /** The row as it is written. Throws for a value not prepared: its transaction aborts, and nothing goes out in the clear. */
  row<T>(store: string, row: T): T {
    if (!this.on) return row;
    return sealWith(store, row, (json, at) => {
      const sealed = this.ready.get(slotOf(json, at));
      if (!sealed) throw new Error("A secret was not sealed before it was saved");
      return sealed;
    });
  }
}

export async function sealRow<T extends object>(store: string, row: T): Promise<T> {
  return (await new RowSeals().prepare(store, [row])).row(store, row);
}

/**
 * The store as a transaction's work sees it: what it puts is sealed from `seals`, and a proof is found by its secret.
 * Without the data key, the store itself.
 */
export function sealedStore(store: IDBObjectStore, seals: RowSeals): IDBObjectStore {
  if (!seals.on) return store;
  const proofs = store.name === STORES.proofs;
  return new Proxy(store, {
    get(target, name) {
      if (name === "put") return (row: object, ...key: [IDBValidKey?]) => target.put(seals.row(target.name, row), ...key);
      // A proof stored before the profile was encrypted is kept under its secret until the migration reseals it.
      if (proofs && name === "delete") return (secret: string) => { target.delete(secret); return target.delete(proofKey(secret)); };
      if (proofs && name === "get") return (secret: string) => target.get(proofKey(secret));
      const value: unknown = Reflect.get(target, name, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function unsealed(): void {
  if (!takesUnsealed()) throw new Error("A secret of this profile was not sealed with its key");
}

/** The row as the engine uses it: every sealed value opened, where it was. */
export async function openRow<T>(store: string, value: T): Promise<T> {
  if (!hasDataKey() || !value) return value;
  const row = value as Row;
  if (store === STORES.proofs) {
    const sealed = row[SEALED_SECRET];
    if (sealed === undefined) { unsealed(); return value; }
    const key = String(row.secret), secret = JSON.parse(await openSecret(sealed as SealedField, { store, key, field: "secret" })) as string;
    if (proofKey(secret) !== key) throw new Error("A sealed field could not be opened: it was changed, or it belongs to another record");
    const { [SEALED_SECRET]: _sealed, ...rest } = row;
    return { ...rest, secret } as T;
  }
  const key = keyOf(store, row);
  let out = row;
  for (const { path, value: at } of places(store, row)) {
    if (!isSealedField(at)) { unsealed(); continue; }
    out = written(out, path.split("."), JSON.parse(await openSecret(at, { store, key, field: path })));
  }
  return out as T;
}

export function openRows<T>(store: string, rows: T[]): Promise<T[]> {
  return hasDataKey() ? Promise.all(rows.map((row) => openRow(store, row))) : Promise.resolve(rows);
}
