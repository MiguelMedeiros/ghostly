import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { createIdentity, emptyProofLedger } from '@ghostly/core';
import { GhostlyNode } from '../src/engine/node';
import { db } from '../src/engine/db';
import type { StoredLink } from '../src/shared/types';
// covers: profiles.public, proofs.peer-proofs, chat.paired.storage

describe('Ghostly-only release', () => {
  it('hides preserved external data, rejects proof RPCs, and retains local names, pins and history', async () => {
    const row: StoredLink = {
      id: 'ghostly-only-release', profile: 'paired-chat/1', createdAt: Date.now(),
      seedB64: createIdentity().seedB64, encKeyB64: createIdentity().seedB64,
      participationSeed: createIdentity().seedB64, pairedPeerKey: createIdentity().pubKeyZ32,
      peerPubKeyZ32: createIdentity().pubKeyZ32, label: 'Local nickname',
      requireSignedSignals: true, preferredTransport: 'iroh/1', transportFallback: true,
      peerProofs: emptyProofLedger(), profileChoice: 'nostr',
      publicProfiles: [{ adapter: 'nostr', key: 'a'.repeat(64), name: 'External name', fetchedAt: Date.now(), source: 'nostr-signed' }],
    };
    await db.putSettings({ online: false, nick: '', relays: [], iceServers: [], mints: [], mintsInitialized: true });
    await db.putLink(row);
    const message = { linkId: row.id, id: 'existing', text: 'Saved chat', sender: 'peer' as const, timestamp: 1, via: 'datalink' as const };
    await db.addMessage(message);
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network expected'));
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false });
    try {
      await node.start();
      await node.refreshPublicProfiles({ linkId: row.id, force: true });
      await expect(node.preparePeerProof({ linkId: row.id, externalKey: 'a'.repeat(64) })).rejects.toThrow(/unavailable in this release/);
      await expect(node.withdrawPeerProof({ linkId: row.id, adapter: 'nostr' })).rejects.toThrow(/unavailable in this release/);
      await expect(node.choosePublicProfile({ linkId: row.id, choice: 'nostr' })).rejects.toThrow(/unavailable in this release/);
      const view = node.getState().links.find(l => l.id === row.id)!;
      expect(view.peerProofSupport).toBe(false);
      expect(view.peerProofAdapters).toEqual([]);
      expect(view.peerProofs).toBeUndefined();
      expect(view.publicProfiles).toBeUndefined();
      expect(view.profileChoice).toBeUndefined();
      expect(view.label).toBe('Local nickname');
      expect(view.peerParticipationKey).toBe(row.pairedPeerKey);
      expect(view.preferredTransport).toBe('iroh/1');
      expect(await db.getMessages(row.id)).toEqual([message]);
      expect((await db.getLinks()).find(l => l.id === row.id)).toEqual(row);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await node.shutdown(); fetcher.mockRestore(); }
  });
});
