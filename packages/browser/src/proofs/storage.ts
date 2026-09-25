import { validExternalKey } from '@ghostly/core';
import type { Pubky } from '@synonymdev/pubky';
import { boundedBytes } from '../profiles/public';

let publicClient: Promise<Pubky> | undefined;
/** The retired per-chat `pubky-storage` proof, read only (nothing writes one now: Pubky is an identity provider,
 * providers/pubky.ts). Resolve through Pubky's authenticated PKDNS records, never through a URL or
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
