import { BunkerSigner, type BunkerPointer } from 'nostr-tools/nip46';
import { SimplePool } from 'nostr-tools/pool';
import { generateSecretKey } from 'nostr-tools/pure';
import type { NostrProofEvent } from '@ghostly/core';

export interface NostrSigner {
  getPublicKey(): Promise<string>;
  signEvent(event: { kind: number; created_at: number; tags: string[][]; content: string }): Promise<NostrProofEvent>;
}
export function extensionSigner(): NostrSigner | undefined {
  return (globalThis as typeof globalThis & { nostr?: NostrSigner }).nostr;
}
/** No NIP-05 lookup, arbitrary fetch, private key import or automatic relay switching. */
export function parseProofBunker(input: string): BunkerPointer {
  if (input.length > 4096) throw new Error('Bunker URL too long');
  let uri: URL;
  try { uri = new URL(input); } catch { throw new Error('Enter a bunker:// connection URL from your signer'); }
  const relays = uri.searchParams.getAll('relay');
  if (uri.protocol !== 'bunker:' || !/^[a-f0-9]{64}$/.test(uri.hostname) || uri.username || uri.password || uri.port || uri.hash || (uri.pathname && uri.pathname !== '/') ||
    relays.length < 1 || relays.length > 3) throw new Error('Invalid bunker connection URL');
  for (const address of relays) {
    const relay = new URL(address);
    if (relay.username || relay.password || relay.hash || !(relay.protocol === 'wss:' ||
      (relay.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(relay.hostname))))
      throw new Error('Use secure wss:// relays (ws:// is allowed only on loopback for local testing)');
  }
  return { pubkey: uri.hostname, relays, secret: uri.searchParams.get('secret') };
}
export async function withNostrSigner<T>(options: { bunker?: string; signal: AbortSignal; onAuth(url: string): void }, work: (signer: NostrSigner) => Promise<T>): Promise<T> {
  options.signal.throwIfAborted();
  let signer: BunkerSigner | undefined;
  let pool: SimplePool | undefined;
  let clientKey: Uint8Array | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  let closed = false;
  const guard: NostrSigner = {
    getPublicKey: async () => { if (closed) throw new Error('Signer request cancelled'); const key = await active!.getPublicKey(); if (closed) throw new Error('Signer request cancelled'); return key; },
    signEvent: async event => { if (closed) throw new Error('Signer request cancelled'); const signed = await active!.signEvent(event); if (closed) throw new Error('Signer request cancelled'); return signed; },
  };
  let active: NostrSigner | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      abort = () => { closed = true; reject(new Error('Signing cancelled')); };
      options.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { closed = true; reject(new Error('Signer timed out. Your Ghostly identity is unchanged.')); }, 120_000);
    });
    const action = async () => {
      if (options.bunker) {
        const bp = parseProofBunker(options.bunker);
        pool = new SimplePool(); clientKey = generateSecretKey();
        signer = BunkerSigner.fromBunker(clientKey, bp, { pool, skipSwitchRelays: true, onauth: url => {
          try { const u = new URL(url); if (!closed && u.protocol === 'https:' && !u.username && !u.password) options.onAuth(u.href); } catch { /* Invalid signer URL: never navigate. */ }
        } });
        await signer.sendRequest('connect', [bp.pubkey, bp.secret ?? '', 'sign_event:30078', JSON.stringify({ name: 'Ghostly — optional conversation proof' })]);
        active = signer;
      } else {
        active = extensionSigner();
        if (!active) throw new Error('No NIP-07 signer in this window. Use a bunker connection from your Nostr signer.');
      }
      if (closed) throw new Error('Signer request cancelled');
      return work(guard);
    };
    return await Promise.race([action(), timeout]);
  } finally {
    closed = true;
    if (timer) clearTimeout(timer);
    if (abort) options.signal.removeEventListener('abort', abort);
    await signer?.close(); pool?.destroy(); clientKey?.fill(0);
  }
}
