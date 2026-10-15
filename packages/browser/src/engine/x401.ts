import { newX401HolderKey, readX401SdJwtVc, sameX401HolderJwk, toBase64Url, type X401ClaimPath, type X401HolderJwk, type X401SdJwtVc } from "@ghostly/core";
import { STORES, store, transact, wrap } from "../shared/idb";
import { newDeviceKey, sealSeed } from "./paymentAdapters/persistence";
import type { SealedProofKey } from "./identities";

/** A holder key: its public JWK, and its secret sealed as an identity proof's seed is. */
interface StoredHolderKey { id: string; jwk: X401HolderJwk; secret: SealedProofKey; createdAt: number }

/** An issued credential the profile keeps (WISP 3xx § Credentials kept per profile), with the key it is bound to. */
interface StoredX401Credential {
  id: string;
  label: string;
  format: "dc+sd-jwt";
  credential: string;
  type: string;
  issuer: string;
  holderKey: StoredHolderKey;
  addedAt: number;
  expiresAt?: number;
}

/** The `x401Credentials` record: credentials, and the keys made for one that no credential is bound to yet. */
interface StoredX401 { keys: StoredHolderKey[]; credentials: StoredX401Credential[] }

export interface X401CredentialView {
  id: string; label: string; format: "dc+sd-jwt"; type: string; issuer: string; addedAt: number; expiresAt: number | null;
  /** The paths of its claims, and of those a presentation may leave out. */
  claims: X401ClaimPath[]; disclosable: X401ClaimPath[];
  /** The claims' values: only when asked for. */
  values?: Record<string, unknown>;
}

export const X401_KEY = "x401Credentials";
const MAX_CREDENTIALS = 32;
/** Keys waiting for an issuer: the oldest goes when one more is made. */
const MAX_WAITING_KEYS = 8;
const LABEL_CHARS = 80;
const newId = () => toBase64Url(crypto.getRandomValues(new Uint8Array(12)));

/** The paths of an object's members, nested objects' own members included. */
function paths(value: Record<string, unknown>, at: X401ClaimPath = []): X401ClaimPath[] {
  return Object.entries(value).flatMap(([key, item]) => {
    const path = [...at, key];
    return typeof item === "object" && item !== null && !Array.isArray(item) ? [path, ...paths(item as Record<string, unknown>, path)] : [path];
  });
}

/**
 * x401 credentials (WISP 3xx), engine side: the profile's holder keys and the credentials issuers bound to them, in
 * the settings store beside the identity proofs. Read from the store on each call: nothing of it stays in memory.
 * Nothing here is shared with a contact, and no presentation is made here yet.
 */
export class X401Credentials {
  /** Changes one after another: each reads the record and writes it back, and two at once would lose one. */
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(change: () => Promise<T>): Promise<T> {
    const next = this.queue.then(change, change);
    this.queue = next.catch(() => {});
    return next;
  }

  private async load(): Promise<StoredX401> {
    const stored = await wrap<StoredX401 | undefined>((await store(STORES.settings, "readonly")).get(X401_KEY));
    return stored ?? { keys: [], credentials: [] };
  }
  private async save(value: StoredX401): Promise<void> {
    await transact([STORES.settings], (stores) => { stores[STORES.settings].put(value, X401_KEY); });
  }

  /** A fresh P-256 holder key, kept until a credential bound to it is added. Its public JWK goes to the issuer. */
  async newKey(): Promise<{ id: string; jwk: X401HolderJwk }> {
    const { secret, jwk } = newX401HolderKey();
    const deviceKey = newDeviceKey();
    const key: StoredHolderKey = { id: newId(), jwk, secret: { sealed: await sealSeed(toBase64Url(secret), deviceKey), deviceKey }, createdAt: Date.now() };
    secret.fill(0);
    return this.serial(async () => {
      const stored = await this.load();
      await this.save({ ...stored, keys: [...stored.keys, key].slice(-MAX_WAITING_KEYS) });
      return { id: key.id, jwk };
    });
  }

  /**
   * Adds an issued credential bound to one of the keys `newKey` made. Refused: a credential that does not read, one
   * that has expired, one bound to another key, one already kept.
   */
  add({ credential, label }: { credential: string; label?: string }): Promise<X401CredentialView> {
    const read = readX401SdJwtVc(credential);
    if (!read.ok) return Promise.reject(new Error(`Not an SD-JWT VC Ghostly can keep: ${read.reason}`));
    const vc = read.value;
    if (vc.expiresAt !== undefined && vc.expiresAt * 1000 <= Date.now()) return Promise.reject(new Error(`This credential expired on ${new Date(vc.expiresAt * 1000).toISOString()}`));
    return this.serial(() => this.keep(credential.trim(), vc, label));
  }

  private async keep(credential: string, vc: X401SdJwtVc, label?: string): Promise<X401CredentialView> {
    const stored = await this.load();
    if (stored.credentials.some((c) => c.credential === credential)) throw new Error("This credential is kept already");
    const holderKey = stored.keys.find((k) => sameX401HolderJwk(k.jwk, vc.holder));
    if (!holderKey) throw new Error("This credential is bound to a key this profile did not make: ask the issuer to bind it to a key from x401 key new");
    if (stored.credentials.length >= MAX_CREDENTIALS) throw new Error(`A profile keeps at most ${MAX_CREDENTIALS} credentials: remove one first`);
    const kept: StoredX401Credential = {
      id: newId(), label: (label?.trim() || vc.type).slice(0, LABEL_CHARS), format: vc.format, credential, type: vc.type, issuer: vc.issuer,
      holderKey, addedAt: Date.now(), ...(vc.expiresAt !== undefined ? { expiresAt: vc.expiresAt * 1000 } : {}),
    };
    await this.save({ keys: stored.keys.filter((k) => k !== holderKey), credentials: [...stored.credentials, kept] });
    return this.viewOf(kept, false);
  }

  async list({ values = false } = {}): Promise<X401CredentialView[]> {
    return (await this.load()).credentials.map((c) => this.viewOf(c, values));
  }

  /** Removes a credential and its holder key. False when the profile has no credential with that id. */
  remove({ id }: { id: string }): Promise<boolean> {
    return this.serial(async () => {
      const stored = await this.load();
      if (!stored.credentials.some((c) => c.id === id)) return false;
      await this.save({ ...stored, credentials: stored.credentials.filter((c) => c.id !== id) });
      return true;
    });
  }

  private viewOf(c: StoredX401Credential, values: boolean): X401CredentialView {
    const read = readX401SdJwtVc(c.credential);
    const claims = read.ok ? read.value.claims : {};
    return {
      id: c.id, label: c.label, format: c.format, type: c.type, issuer: c.issuer, addedAt: c.addedAt, expiresAt: c.expiresAt ?? null,
      claims: paths(claims), disclosable: read.ok ? read.value.disclosable : [], ...(values ? { values: claims } : {}),
    };
  }
}
