import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createIdentity } from "@ghostly/core";
import { db } from "../src/engine/db";
import type { StoredLink } from "../src/shared/types";

function link(id:string):StoredLink {
  return {id,seedB64:createIdentity().seedB64,peerPubKeyZ32:createIdentity().pubKeyZ32,encKeyB64:createIdentity().seedB64,
    profile:"paired-chat/1",participationSeed:createIdentity().seedB64,createdAt:Date.now(),inviteCode:"test-bootstrap"};
}
describe("durable one-participation admission", () => {
  it("keeps automatic admission unverified, then persists a comparison across repinning", async () => {
    const row = link("optional-verification"); await db.putLink(row);
    const key = createIdentity().pubKeyZ32;
    await db.pinPeer(row.id, key, true);
    expect((await db.getLinks()).find(l => l.id === row.id)?.peerTrust?.verifiedKey).toBeUndefined();
    await db.verifyPeer(row.id, key);
    const verified = (await db.getLinks()).find(l => l.id === row.id)!;
    expect(verified.peerTrust?.verifiedKey).toBe(key);
    expect(verified.peerTrust?.verifiedAt).toBeGreaterThan(0);
    await db.pinPeer(row.id, key);
    expect((await db.getLinks()).find(l => l.id === row.id)?.peerTrust).toEqual(verified.peerTrust);
    await expect(db.verifyPeer(row.id, createIdentity().pubKeyZ32)).rejects.toThrow();
    expect((await db.getLinks()).find(l => l.id === row.id)?.peerTrust).toEqual(verified.peerTrust);
  });
  it("cannot verify an unpinned or deleted conversation", async () => {
    const row = link("unpinned-verification"); await db.putLink(row);
    await expect(db.verifyPeer(row.id, createIdentity().pubKeyZ32)).rejects.toThrow();
    await expect(db.verifyPeer("deleted-verification", createIdentity().pubKeyZ32)).rejects.toThrow();
  });
  it("serializes racing confirmations and never overwrites the winning peer", async () => {
    const row=link("race"); await db.putLink(row);
    const keys=[createIdentity().pubKeyZ32,createIdentity().pubKeyZ32];
    const results=await Promise.allSettled(keys.map(k=>db.pinPeer(row.id,k)));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const persisted=(await db.getLinks()).find(l=>l.id===row.id)!;
    expect(persisted.pairedPeerKey).toBe(keys[0]);
    expect(persisted.inviteCode).toBeUndefined();
    await expect(db.pinPeer(row.id,keys[0])).resolves.toBeUndefined();
    await expect(db.pinPeer(row.id,keys[1])).rejects.toThrow();
  });
  it("keeps signed signaling mandatory after migration, even when an older callback omits it", async () => {
    const row = link("signed-migration"); await db.putLink(row);
    const key = createIdentity().pubKeyZ32;
    await db.pinPeer(row.id, key, true);
    await db.pinPeer(row.id, key);
    const restored = (await db.getLinks()).find(l => l.id === row.id)!;
    expect(restored.requireSignedSignals).toBe(true);
    expect(restored.participationSeed).toBe(row.participationSeed);
    expect(restored.seedB64).toBe(row.seedB64);
  });
  it("does not recreate a removed link through a delayed confirmation", async () => {
    await expect(db.pinPeer("missing",createIdentity().pubKeyZ32)).rejects.toThrow();
  });
  it("deduplicates concurrent delivery of a stable message id after commit", async () => {
    const message={linkId:"messages",id:"peer_unique",text:"hello",sender:"peer" as const,timestamp:1,via:"datalink" as const};
    expect(await Promise.all([db.addMessage(message),db.addMessage(message)])).toEqual([true,false]);
    expect(await db.getMessages("messages")).toEqual([message]);
  });
});

describe('atomic proof ledger', () => {
  it('serializes proof consumption with unrelated link patches and preserves pins/history', async () => {
    const row=link('proof-ledger'); row.pairedPeerKey=createIdentity().pubKeyZ32; await db.putLink(row);
    const challenge={adapter:'nostr' as const,externalKey:'a'.repeat(64),subject:row.pairedPeerKey,audience:createIdentity().pubKeyZ32,
      context:'b'.repeat(64),session:'c'.repeat(64),nonce:'Z'.repeat(43),issuedAt:1800000000,expiresAt:1800086400};
    await db.updatePeerProofs(row.id,l=>({...l,incoming:[challenge]}));
    const results=await Promise.allSettled([0,1].map(()=>db.updatePeerProofs(row.id,l=>{
      if(!l.incoming.length) throw new Error('used'); return {...l,incoming:[]};
    })));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    await db.patchLink(row.id,{label:'renamed'});
    const saved=(await db.getLinks()).find(l=>l.id===row.id)!;
    expect(saved.peerProofs?.incoming).toEqual([]); expect(saved.pairedPeerKey).toBe(row.pairedPeerKey);
    expect(saved.participationSeed).toBe(row.participationSeed); expect(saved.label).toBe('renamed');
  });
  it('cannot recreate a deleted conversation through a delayed proof', async () => {
    await expect(db.updatePeerProofs('missing-proof',l=>l)).rejects.toThrow();
  });
});
