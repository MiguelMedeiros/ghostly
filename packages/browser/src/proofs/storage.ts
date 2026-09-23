import { storageProof, storageProofBody, storageProofPath, STORAGE_ROOT, validExternalKey, type ProofChallenge, type StorageProof } from '@ghostly/core';
import type { Pubky, Session } from '@synonymdev/pubky';
import { boundedBytes } from '../profiles/public';

let publicClient: Promise<Pubky> | undefined;
/** Resolve through Pubky's authenticated PKDNS records, never through a URL or
 * homeserver supplied in a proof. A separate unauthenticated client reads it. */
export async function readPubkyProof(key: string, path: string): Promise<string> {
  if (!validExternalKey('pubky-storage', key) || !/^\/pub\/ghostly\.app\/proofs\/[a-f0-9]{64}\/[a-f0-9]{64}\.json$/.test(path)) throw new Error('Invalid Pubky proof address');
  const pubky = await (publicClient ??= import('@synonymdev/pubky').then(({ Pubky }) => new Pubky()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    const response = await pubky.publicStorage.get(`pubky://${key}${path as `/pub/${string}`}`);
    return new TextDecoder('utf-8', { fatal: true }).decode(await boundedBytes(response, 512));
  };
  try {
    return await Promise.race([read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Pubky homeserver check timed out')), 15_000);
    })]);
  } finally { clearTimeout(timer); }
}

export interface StorageConnectOptions {
  signal: AbortSignal;
  onLink(url: string): void;
  onProgress(message: string): void;
  prepare(key: string): Promise<ProofChallenge>;
  /** Must resolve only after the contact acknowledges independent verification. */
  submit(challenge: ProofChallenge, evidence: StorageProof): Promise<void>;
}

/** Uses the unmodified official Ring signin flow. Session secrets never leave
 * this renderer and are never persisted by Ghostly. Public evidence is a short
 * observation (10 min), not a claim that a grant remains valid. */
export async function withPubkyStorage(options: StorageConnectOptions): Promise<void> {
  const { Pubky, AuthFlowKind } = await import('@synonymdev/pubky');
  options.signal.throwIfAborted();
  const folder = Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
  const capability = `${STORAGE_ROOT}${folder}/:w` as const;
  const pubky = new Pubky();
  const flow = pubky.startCookieAuthFlow(capability, AuthFlowKind.signin());
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 180_000);
  let session: Session | undefined;
  let path: `/pub/${string}` | undefined;
  let waiting = true;
  const approval = flow.awaitApproval();
  // Late phone approvals after cancellation must not leave an authorized session.
  void approval.then(async approved => {
    if (!waiting) { try { await approved.signout(); } finally { approved.free(); } }
  }).catch(() => {});
  try {
    options.onLink(flow.authorizationUrl);
    session = await new Promise<Session>((resolve, reject) => {
      const cancelled = () => reject(new Error('Pubky approval cancelled or timed out. Start a new connection.'));
      controller.signal.addEventListener('abort', cancelled, { once: true });
      approval.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', cancelled)).catch(() => {});
      if (controller.signal.aborted) cancelled();
    });
    waiting = false;
    clearTimeout(timer); options.onLink('');
    options.signal.throwIfAborted();
    const info = session.info;
    const key = info.publicKey;
    let externalKey: string;
    try {
      externalKey = key.z32();
      if (info.capabilities.length !== 1 || info.capabilities[0] !== capability) throw new Error('Ring returned different folder permissions.');
    } finally { key.free(); info.free(); }
    options.onProgress('Writing a temporary verification file…');
    const challenge = await options.prepare(externalKey);
    options.signal.throwIfAborted();
    const evidence = await storageProof(challenge, folder);
    path = storageProofPath(evidence);
    await session.storage.putText(path, storageProofBody(challenge, evidence));
    options.signal.throwIfAborted();
    options.onProgress('Your contact is checking your Pubky homeserver…');
    await options.submit(challenge, evidence);
  } finally {
    waiting = false; clearTimeout(timer);
    options.signal.removeEventListener('abort', abort); options.onLink('');
    // Free the flow only after its pending WASM operation has settled.
    void approval.finally(() => { flow.free(); pubky.free(); }).catch(() => {});
    if (session) {
      let cleaned = true;
      try { if (path) await session.storage.delete(path); } catch { cleaned = false; }
      try { await session.signout(); } catch { cleaned = false; }
      session.free();
      if (!cleaned) options.onProgress('Verification finished, but cleanup could not be confirmed. The proof expires after 10 minutes; revoke the Ghostly folder session in Ring if needed.');
    }
  }
}
