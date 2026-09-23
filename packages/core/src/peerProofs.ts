// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- Share ambient types with importing workspaces without a runtime import.
/// <reference path="./keet-identity-key.d.ts" />
import b4a from 'b4a';
import { RING_LIFETIME, verifyRingEvidence, type RingEvidence } from './pubkyRing';
import { verify } from './identity';
import { schnorr } from '@noble/curves/secp256k1.js';
import { fromBase64Url, fromZ32, toZ32, randomBytes, toBase64Url, utf8Encode } from './bytes';

export type ProofAdapter = 'nostr' | 'pubky-import' | 'keet-import' | 'pubky-ring' | 'pubky-storage';
export const PROOF_ADAPTERS: ProofAdapter[] = ['nostr', 'pubky-import', 'keet-import', 'pubky-storage'];
export const proofCapability = (adapter: ProofAdapter) => `proof-${adapter}/1`;
export const isProofAdapter = (value: unknown): value is ProofAdapter => PROOF_ADAPTERS.includes(value as ProofAdapter);
export interface ProofScope { subject: string; audience: string; context: string; session: string }
export interface ProofChallenge extends ProofScope {
  adapter: ProofAdapter; externalKey: string; nonce: string; issuedAt: number; expiresAt: number;
}
export interface NostrProofEvent { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string }
export interface ImportedProof { id: string; scheme: 'pubky-import/1' | 'keet-import/1'; signature: string }
export interface StorageProof { scheme: 'pubky-storage/1'; id: string; folder: string }
export type StorageProofReader = (key: string, path: string) => Promise<string>;
export type ProofEvidence = NostrProofEvent | ImportedProof | RingEvidence | StorageProof;
export const STORAGE_LIFETIME = 600;
export const STORAGE_ROOT = '/pub/ghostly.app/proofs/';
export async function storageProof(c: ProofChallenge, folder: string): Promise<StorageProof> {
  if (c.adapter !== 'pubky-storage' || !/^[a-f0-9]{64}$/.test(folder)) throw new Error('Invalid storage proof');
  return { scheme: 'pubky-storage/1', folder, id: await proofHash(JSON.stringify(['pubky-storage/1', folder, proofStatement(c)])) };
}
export function storageProofPath(e: StorageProof): `/pub/${string}` { return `${STORAGE_ROOT}${e.folder}/${e.id}.json`; }
export function storageProofBody(c: ProofChallenge, e: StorageProof): string {
  // No participants, conversation identifier, key, or chat content is published.
  return JSON.stringify({ version: 1, commitment: e.id, expiresAt: c.expiresAt });
}
export interface ProofRecord { challenge: ProofChallenge; event: ProofEvidence; verifiedAt: number; status: 'pending' | 'accepted' | 'withdrawal-pending' | 'withdrawn' }
export interface ProofLedger { incoming: ProofChallenge[]; outgoing: ProofChallenge[]; local: ProofRecord[]; remote: ProofRecord[] }
export const emptyProofLedger = (): ProofLedger => ({ incoming: [], outgoing: [], local: [], remote: [] });
export interface ProofStorage {
  read(): ProofLedger;
  /** Atomic, durable read-transform-write, preserving other conversation fields. */
  update(change: (ledger: ProofLedger) => ProofLedger): Promise<void>;
}
export const PROOF_CAPABILITY = 'proof-nostr/1';
const WINDOW = 300;
const LIFETIME = 86400;
const hex = /^[a-f0-9]{64}$/;
const unhex = (value: string) => Uint8Array.from(value.match(/../g)!, x => parseInt(x, 16));
const key = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;
const nonce = /^[A-Za-z0-9_-]{43}$/;
const nowSeconds = () => Math.floor(Date.now() / 1000);
export async function proofHash(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(utf8Encode(text)))), b => b.toString(16).padStart(2, '0')).join('');
}
export function proofStatement(c: ProofChallenge): string {
  return JSON.stringify(['ghostly-peer-proof', 1, c.adapter === 'pubky-storage' ? 'authorized-storage-control' : c.adapter === 'pubky-ring' ? 'delegated-conversation-proof' : 'control-of-external-key', c.adapter, c.externalKey,
    c.subject, c.audience, c.context, c.session, c.nonce, c.issuedAt, c.expiresAt]);
}
export function nostrProofTemplate(c: ProofChallenge) {
  return { kind: 30078, created_at: c.issuedAt,
    tags: [['d', `ghostly-peer-proof/1:${c.context}`], ['expiration', String(c.expiresAt)]], content: proofStatement(c) };
}
function assertChallenge(c: ProofChallenge, scope: ProofScope, now: number) {
  if (!c || !isProofAdapter(c.adapter) || !validExternalKey(c.adapter, c.externalKey) || !key.test(c.subject) || !key.test(c.audience) ||
    !hex.test(c.context) || !hex.test(c.session) || !nonce.test(c.nonce) || c.subject === c.audience ||
    c.subject !== scope.subject || c.audience !== scope.audience || c.context !== scope.context || c.session !== scope.session ||
    !Number.isSafeInteger(c.issuedAt) || !Number.isSafeInteger(c.expiresAt) || c.expiresAt !== c.issuedAt + (c.adapter === 'pubky-storage' ? STORAGE_LIFETIME : c.adapter === 'pubky-ring' ? RING_LIFETIME : LIFETIME) ||
    c.issuedAt > now + 30 || c.issuedAt < now - WINDOW) throw new Error('Proof challenge expired or belongs to another connection');
}
export async function verifyNostrProof(event: NostrProofEvent, c: ProofChallenge): Promise<void> {
  const expected = nostrProofTemplate(c);
  if (!event || event.pubkey !== c.externalKey || event.kind !== expected.kind || event.created_at !== expected.created_at ||
    event.content !== expected.content || JSON.stringify(event.tags) !== JSON.stringify(expected.tags) ||
    typeof event.id !== 'string' || !hex.test(event.id) || typeof event.sig !== 'string' || !/^[a-f0-9]{128}$/.test(event.sig))
    throw new Error('Signer did not sign the exact Ghostly proof');
  const id = await proofHash(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]));
  if (event.id !== id || !schnorr.verify(unhex(event.sig), unhex(id), unhex(event.pubkey))) throw new Error('Invalid Nostr signature');
}
export function validExternalKey(adapter: ProofAdapter, value: string): boolean {
  if (typeof value !== 'string') return false;
  if (adapter !== 'pubky-import' && adapter !== 'pubky-ring' && adapter !== 'pubky-storage') return hex.test(value);
  try { return key.test(value) && toZ32(fromZ32(value)) === value; } catch { return false; }
}
export async function importedProof(c: ProofChallenge, signature: Uint8Array): Promise<ImportedProof> {
  if (c.adapter === 'nostr' || c.adapter === 'pubky-ring' || c.adapter === 'pubky-storage') throw new Error('Wrong proof adapter');
  const scheme = `${c.adapter}/1` as ImportedProof['scheme'];
  const encoded = toBase64Url(signature);
  return { scheme, signature: encoded, id: await proofHash(JSON.stringify([scheme, proofStatement(c), encoded])) };
}
export async function verifyPeerProof(event: ProofEvidence, c: ProofChallenge, readStorage?: StorageProofReader): Promise<void> {
  if (c.adapter === 'nostr') return verifyNostrProof(event as NostrProofEvent, c);
  if (c.adapter === 'pubky-ring') return verifyRingEvidence(event as RingEvidence, proofStatement(c), c.externalKey, c.issuedAt, c.expiresAt);
  if (c.adapter === 'pubky-storage') {
    const e = event as StorageProof;
    if (!e || e.scheme !== 'pubky-storage/1' || !hex.test(e.id) || typeof e.folder !== 'string' ||
        !hex.test(e.folder) || Object.keys(e).sort().join(',') !== 'folder,id,scheme' ||
        (await storageProof(c, e.folder)).id !== e.id || !readStorage) throw new Error('Invalid storage proof');
    if (await readStorage(c.externalKey, storageProofPath(e)) !== storageProofBody(c, e)) throw new Error('Homeserver proof does not match this challenge');
    return;
  }
  const e = event as ImportedProof;
  if (!e || e.scheme !== `${c.adapter}/1` || typeof e.signature !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(e.signature) ||
    typeof e.id !== 'string' || !hex.test(e.id) || !validExternalKey(c.adapter,c.externalKey)) throw new Error('Invalid imported-key proof');
  const sig = fromBase64Url(e.signature);
  if (toBase64Url(sig) !== e.signature || (await importedProof(c,sig)).id !== e.id) throw new Error('Invalid proof encoding or digest');
  const data = utf8Encode(proofStatement(c));
  if (c.adapter === 'pubky-import') {
    if (sig.length !== 64 || !verify(sig,data,fromZ32(c.externalKey))) throw new Error('Invalid Pubky signature');
  } else if (c.adapter === 'keet-import') {
    // Pinned SDK v1 root-only DataAttestation: uint version, uint64 epoch,
    // fixed32 identity, empty chain, data flag, fixed64 signature. Enforce this
    // bounded canonical shape before the SDK's generic array decoder runs.
    if (sig.length !== 107 || sig[0] !== 1 || sig[41] !== 0 || sig[42] !== 1) throw new Error('Unsupported Keet attestation');
    const { default: IdentityKey } = await import('keet-identity-key');
    if (!IdentityKey.verify(b4a.from(sig), b4a.from(data), { expectedIdentity: b4a.from(unhex(c.externalKey)) }))
      throw new Error('Invalid Keet attestation');
  } else throw new Error('Unsupported proof adapter');
}
function replace(records: ProofRecord[], record: ProofRecord): ProofRecord[] {
  return [...records.filter(r => r.challenge.adapter !== record.challenge.adapter), record];
}

/** Optional application protocol. All calls require an authenticated, pinned paired channel.
 * A bad external proof never replaces participation authentication or disconnects ordinary chat. */
export class PeerProofs {
  private waiting = new Map<string, { adapter: ProofAdapter; externalKey: string; resolve: (c: ProofChallenge) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private options: { scope(): ProofScope; send(frame: object): void; storage: ProofStorage; supports?(adapter: ProofAdapter): boolean; now?: () => number; readStorage?: StorageProofReader; onError?(error: string): void }) {}
  private now() { return (this.options.now ?? nowSeconds)(); }
  private scope(incoming = false): ProofScope {
    const s = this.options.scope();
    return incoming ? { ...s, subject: s.audience, audience: s.subject } : s;
  }
  async prepare(externalKey: string, adapter: ProofAdapter = 'nostr'): Promise<ProofChallenge> {
    this.scope();
    if (!isProofAdapter(adapter) || !validExternalKey(adapter, externalKey) || this.options.supports?.(adapter) === false) throw new Error('Proof adapter unavailable or invalid public key');
    if (this.waiting.size) throw new Error('A proof request is already pending');
    const id = toBase64Url(randomBytes(32));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error('Peer did not provide a challenge. Try again.')); }, 15_000);
      this.waiting.set(id, { adapter, externalKey, resolve, reject, timer });
      try { this.options.send({ t: 'proof-request', id, adapter, externalKey }); }
      catch (e) { clearTimeout(timer); this.waiting.delete(id); reject(e); }
    });
  }
  async submit(c: ProofChallenge, event: ProofEvidence): Promise<void> {
    assertChallenge(c, this.scope(), this.now());
    if (this.options.supports?.(c.adapter) === false) throw new Error('Peer does not support this proof');
    await verifyPeerProof(event, c, this.options.readStorage);
    await this.options.storage.update(l => {
      assertChallenge(c, this.scope(), this.now());
      if (!l.outgoing.some(x => proofStatement(x) === proofStatement(c))) throw new Error('Unknown or used proof challenge');
      return { ...l, outgoing: l.outgoing.filter(x => x.nonce !== c.nonce),
        local: replace(l.local, { challenge: c, event, verifiedAt: this.now(), status: 'pending' }) };
    });
    this.options.send({ t: 'proof-present', challenge: c, event });
  }
  async withdraw(adapter: ProofAdapter = 'nostr'): Promise<void> {
    this.scope();
    const record = this.options.storage.read().local.find(r => r.challenge.adapter === adapter);
    if (!record) return;
    await this.options.storage.update(l => ({ ...l, local: l.local.map(r => r.event.id === record.event.id ? { ...r, status: 'withdrawal-pending' } : r) }));
    this.resendWithdrawals();
  }
  resendWithdrawals(): void {
    const scope = this.scope();
    for (const record of this.options.storage.read().local) {
      if (record.status === 'withdrawal-pending' && record.challenge.subject === scope.subject && record.challenge.audience === scope.audience && record.challenge.context === scope.context)
        this.options.send({ t: 'proof-withdraw', id: record.event.id });
    }
  }
  async receive(frame: Record<string, unknown>): Promise<void> {
    try {
      if (JSON.stringify(frame).length > 8192) throw new Error('Proof too large');
      const scope = this.scope();
      const now = this.now();
      if (frame.t === 'proof-request') {
        if (!isProofAdapter(frame.adapter) || this.options.supports?.(frame.adapter) === false || typeof frame.id !== 'string' || !nonce.test(frame.id) || typeof frame.externalKey !== 'string' || !validExternalKey(frame.adapter, frame.externalKey)) return;
        const c: ProofChallenge = { ...this.scope(true), adapter: frame.adapter, externalKey: frame.externalKey,
          nonce: toBase64Url(randomBytes(32)), issuedAt: now, expiresAt: now + (frame.adapter === 'pubky-storage' ? STORAGE_LIFETIME : frame.adapter === 'pubky-ring' ? RING_LIFETIME : LIFETIME) };
        await this.options.storage.update(l => {
          const incoming = l.incoming.filter(x => x.issuedAt >= now - WINDOW);
          if (incoming.length >= 8) throw new Error('Too many proof challenges');
          return { ...l, incoming: [...incoming, c] };
        });
        this.options.send({ t: 'proof-challenge', id: frame.id, challenge: c });
      } else if (frame.t === 'proof-challenge') {
        const pending = typeof frame.id === 'string' ? this.waiting.get(frame.id) : undefined;
        if (!pending) return;
        const c = frame.challenge as ProofChallenge;
        assertChallenge(c, scope, now);
        if (c.adapter !== pending.adapter || c.externalKey !== pending.externalKey) throw new Error("Peer changed the requested external key");
        await this.options.storage.update(l => ({ ...l, outgoing: [c] }));
        clearTimeout(pending.timer); this.waiting.delete(frame.id as string); pending.resolve(c);
      } else if (frame.t === 'proof-present') {
        const c = frame.challenge as ProofChallenge, event = frame.event as ProofEvidence;
        assertChallenge(c, this.scope(true), now);
        if (this.options.supports?.(c.adapter) === false) throw new Error("Unsupported peer proof");
        if (!this.options.storage.read().incoming.some(x => proofStatement(x) === proofStatement(c))) throw new Error('Unknown or reused proof challenge');
        await verifyPeerProof(event, c, this.options.readStorage);
        await this.options.storage.update(l => {
          assertChallenge(c, this.scope(true), this.now());
          // Consuming and recording are one transaction. An unknown nonce is always rejected,
          // including after restart, reconnect, or expiry of the bounded pending ledger.
          if (!l.incoming.some(x => proofStatement(x) === proofStatement(c))) throw new Error('Unknown or reused proof challenge');
          return { ...l, incoming: l.incoming.filter(x => x.nonce !== c.nonce),
            remote: replace(l.remote, { challenge: c, event, verifiedAt: now, status: 'accepted' }) };
        });
        this.options.send({ t: 'proof-accepted', id: event.id });
      } else if (frame.t === 'proof-accepted') {
        await this.options.storage.update(l => ({ ...l, local: l.local.map(r => r.event.id === frame.id &&
          r.challenge.subject === scope.subject && r.challenge.audience === scope.audience && r.challenge.context === scope.context && r.status === 'pending'
          ? { ...r, status: 'accepted' } : r) }));
      } else if (frame.t === 'proof-withdrawn') {
        await this.options.storage.update(l => ({ ...l, local: l.local.map(r => r.event.id === frame.id && r.status === 'withdrawal-pending' ? { ...r, status: 'withdrawn' } : r) }));
      } else if (frame.t === 'proof-withdraw') {
        if (typeof frame.id !== 'string' || !hex.test(frame.id)) return;
        await this.options.storage.update(l => ({ ...l, remote: l.remote.map(r => r.event.id === frame.id ? { ...r, status: 'withdrawn' } : r) }));
        this.options.send({ t: 'proof-withdrawn', id: frame.id });
      }
    } catch (e) { this.options.onError?.(e instanceof Error ? e.message : 'Invalid peer proof'); }
  }
  stop(): void {
    for (const p of this.waiting.values()) { clearTimeout(p.timer); p.reject(new Error('Connection closed')); }
    this.waiting.clear();
  }
}
