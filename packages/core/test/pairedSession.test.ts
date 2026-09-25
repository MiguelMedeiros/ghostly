import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentity } from "../src/identity";
import { PairedSession, type PairingCredentials, type PairedSessionOptions } from "../src/pairedSession";
import { createChannelPair } from "./helpers";
// covers: chat.paired.session, core.capabilities, core.version, core.peer-keys, chat.paired.verify, chat.paired.reconnect, payments.chat.methods, payments.bark.offer

const active: PairedSession[] = [];
afterEach(() => { active.splice(0).forEach(s => s.stop()); });
const aKey = createIdentity().pubKeyZ32;
const bKey = createIdentity().pubKeyZ32;
/** `overrides` reach B only; `both` reaches A too, and B applies it under `overrides`. */
function pair(credentials?: [PairingCredentials, PairingCredentials], overrides: Partial<PairedSessionOptions> = {}, both: Partial<PairedSessionOptions> = {}) {
  const [ac, bc] = createChannelPair();
  const creds = credentials ?? [{ seedB64: createIdentity().seedB64 }, { seedB64: createIdentity().seedB64 }];
  const received = [vi.fn(), vi.fn()];
  const ready = [vi.fn(), vi.fn()];
  const pinned = [vi.fn(async (_key: string) => {}), vi.fn(async (_key: string) => {})];
  const config = (i: number): PairedSessionOptions => ({
    credentials: creds[i], rendezvousKeys: [aKey,bKey], fingerprints: ["a".repeat(64),"b".repeat(64)],
    pinPeer: pinned[i], onState: vi.fn(), onReady: ready[i], onApplication: received[i], onFailure: vi.fn(),
  });
  const a = new PairedSession(ac, { ...config(0), ...both });
  const b = new PairedSession(bc, { ...config(1), ...both, ...overrides });
  active.push(a,b); a.start(); b.start();
  return {a,b,ac,bc,creds,received,ready,pinned};
}
async function confirming(p: ReturnType<typeof pair>) {
  await vi.waitFor(() => { expect(p.a.state.status).toBe("confirm"); expect(p.b.state.status).toBe("confirm"); });
}

describe("paired chat admission and session binding", () => {
  it.each([false,true])("negotiates Ark only when both peers advertise it (%s)",async peerSupports=>{
    const p=pair(undefined,{arkPaymentsSupport:peerSupports},{paymentsSupport:true,arkPaymentsSupport:true});
    await confirming(p);await p.a.confirm(p.a.state.code!);await p.b.confirm(p.b.state.code!);
    await vi.waitFor(()=>expect(p.a.state.status).toBe("ready"));
    expect(p.a.supports("payments/1")).toBe(true);
    expect(p.a.supports("payments-arkade/1")).toBe(peerSupports);
    expect(p.b.supports("payments-arkade/1")).toBe(peerSupports);
  });
  it.each([false,true])("negotiates USDT only when both peers advertise it (%s)",async peerSupports=>{
    const p=pair(undefined,{usdtPaymentsSupport:peerSupports},{paymentsSupport:true,usdtPaymentsSupport:true,arkPaymentsSupport:true,filesSupport:true,proofSupport:true,transportSwitchSupport:true,allowFallback:true});
    await confirming(p);await p.a.confirm(p.a.state.code!);await p.b.confirm(p.b.state.code!);
    await vi.waitFor(()=>expect(p.a.state.status).toBe("ready"));
    expect(p.a.supports("payments-usdt/1")).toBe(peerSupports);
    expect(p.b.supports("payments-usdt/1")).toBe(peerSupports);
  });
  it.each([false,true])("negotiates identity proofs only when both peers offer them; an older peer just goes without (%s)",async peerSupports=>{
    const all={paymentsSupport:true,usdtPaymentsSupport:true,arkPaymentsSupport:true,barkPaymentsSupport:true,filesSupport:true,proofSupport:true,transportSwitchSupport:true,allowFallback:true};
    const p=pair(undefined,{...all,identitySupport:peerSupports},{...all,identitySupport:true});
    await confirming(p);await p.a.confirm(p.a.state.code!);await p.b.confirm(p.b.state.code!);
    await vi.waitFor(()=>expect(p.a.state.status).toBe("ready"));
    expect(p.a.identitySupport).toBe(peerSupports);
    expect(p.b.identitySupport).toBe(peerSupports);
    expect(p.a.supports("payments-bark/1")).toBe(true);
  });
  it.each([false,true])("negotiates Bark only when both peers advertise it, beside every other capability (%s)",async peerSupports=>{
    const all={paymentsSupport:true,usdtPaymentsSupport:true,arkPaymentsSupport:true,filesSupport:true,proofSupport:true,transportSwitchSupport:true,allowFallback:true};
    const p=pair(undefined,{...all,barkPaymentsSupport:peerSupports},{...all,barkPaymentsSupport:true});
    await confirming(p);await p.a.confirm(p.a.state.code!);await p.b.confirm(p.b.state.code!);
    await vi.waitFor(()=>expect(p.a.state.status).toBe("ready"));
    expect(p.a.supports("payments-bark/1")).toBe(peerSupports);
    expect(p.b.supports("payments-bark/1")).toBe(peerSupports);
    // Bark and Arkade are different Ark servers: one never stands in for the other.
    expect(p.a.allowsPayment("bark")).toBe(peerSupports);
    expect(p.a.allowsPayment("arkade")).toBe(true);
  });
  it("never offers on-chain Bitcoin in the handshake: a full offer stays within the 16 older apps accept", async () => {
    const all={paymentsSupport:true,usdtPaymentsSupport:true,arkPaymentsSupport:true,barkPaymentsSupport:true,filesSupport:true,proofSupport:true,transportSwitchSupport:true,allowFallback:true,trustOnFirstUse:true};
    const p=pair(undefined,all,all);
    // Trust on first use: no code to confirm.
    await vi.waitFor(()=>expect(p.a.state.status).toBe("ready"));
    const offered=(p.a as unknown as {offer:{capabilities:string[]}}).offer.capabilities;
    expect(offered.length).toBeLessThanOrEqual(16);
    expect(offered.some(c=>c.includes("bitcoin") || c.includes("fedimint"))).toBe(false);
    // Only the open session's paired-payments list (GhostLink) can allow them.
    expect(p.a.allowsPayment("bitcoin")).toBe(false);
    expect(p.a.allowsPayment("fedimint")).toBe(false);
  });
  const ready = async (p: ReturnType<typeof pair>) => {
    await confirming(p); await p.a.confirm(p.a.state.code!); await p.b.confirm(p.b.state.code!);
    await vi.waitFor(() => { expect(p.a.state.status).toBe("ready"); expect(p.b.state.status).toBe("ready"); });
  };
  const allowed = (s: PairedSession) => (["cashu", "lightning", "arkade", "usdt"] as const).filter(m => s.allowsPayment(m));
  it("allows a way of paying only when both chats allow it", async () => {
    const p = pair(undefined, { cashuPaymentsSupport: false, usdtPaymentsSupport: false }, { paymentsSupport: true, arkPaymentsSupport: true, usdtPaymentsSupport: true });
    await ready(p);
    expect(allowed(p.a)).toEqual(["lightning", "arkade"]);
    expect(allowed(p.b)).toEqual(["lightning", "arkade"]);
  });
  it("offers no Cashu or Lightning at all when a chat allows only tokens", async () => {
    const p = pair(undefined, { cashuPaymentsSupport: false, lightningPaymentsSupport: false }, { paymentsSupport: true, usdtPaymentsSupport: true });
    await ready(p);
    expect(allowed(p.a)).toEqual(["usdt"]);
    expect(allowed(p.b)).toEqual(["usdt"]);
    expect(p.a.supports("payments/1")).toBe(false);
  });
  it("treats a peer that offers only payments/1 as an older app allowing Cashu and Lightning", async () => {
    const [ac, bc] = createChannelPair();
    const options = (seedB64: string): PairedSessionOptions => ({ credentials: { seedB64 }, rendezvousKeys: [aKey, bKey], fingerprints: ["a".repeat(64), "b".repeat(64)],
      pinPeer: vi.fn(async () => {}), onState: vi.fn(), onReady: vi.fn(), onApplication: vi.fn(), onFailure: vi.fn(), paymentsSupport: true, lightningPaymentsSupport: false });
    const a = new PairedSession(ac, options(createIdentity().seedB64));
    const b = new PairedSession(bc, { ...options(createIdentity().seedB64), lightningPaymentsSupport: true });
    (b as unknown as { offer: { capabilities: string[] } }).offer.capabilities = ["chat/1", "signed-signal/1", "payments/1"];
    active.push(a, b); a.start(); b.start();
    await vi.waitFor(() => { expect(a.state.status).toBe("confirm"); expect(b.state.status).toBe("confirm"); });
    await a.confirm(a.state.code!); await b.confirm(b.state.code!);
    await vi.waitFor(() => expect(a.state.status).toBe("ready"));
    expect(allowed(a)).toEqual(["cashu"]);
  });
  it("blocks application data until both confirmations, with identical comparison codes", async () => {
    const p = pair(); await confirming(p);
    expect(p.a.state.code).toBe(p.b.state.code);
    p.ac.send("early"); await new Promise(r => setTimeout(r, 0));
    expect(p.received[1]).not.toHaveBeenCalled();
    await p.a.confirm(p.a.state.code!);
    expect(p.a.state.status).toBe("waiting");
    await p.b.confirm(p.b.state.code!);
    await vi.waitFor(() => expect(p.a.state.status).toBe("ready"));
    p.ac.send("real message");
    await vi.waitFor(() => expect(p.received[1]).toHaveBeenCalledWith("real message"));
    expect(p.pinned[0]).toHaveBeenCalledOnce();
    expect(p.pinned[0]).toHaveBeenCalledWith(p.a.state.peerKey, true);
    expect(p.ready[0]).toHaveBeenCalledOnce();
  });
  it("keeps an older text-only peer compatible without enabling new features", async () => {
    const p = pair(undefined, { filesSupport: true, paymentsSupport: true }); await confirming(p);
    await p.a.confirm(p.a.state.code!); await p.b.confirm(p.b.state.code!);
    await vi.waitFor(() => expect(p.a.state.status).toBe("ready"));
    expect(p.a.supports("files/2")).toBe(false); expect(p.b.supports("payments/1")).toBe(false);
    p.bc.send("compatible chat"); await vi.waitFor(() => expect(p.received[0]).toHaveBeenCalledWith("compatible chat"));
  });
  it("keeps Ghostly authentication and chat when an older peer advertises external proofs", async () => {
    const p = pair(undefined, { proofSupport: true });
    await confirming(p);
    expect(p.a.peerProofSupport).toBe(false);
    expect(p.b.peerProofSupport).toBe(false);
    await p.a.confirm(p.a.state.code!);
    await p.b.confirm(p.b.state.code!);
    await vi.waitFor(() => expect(p.a.state.status).toBe("ready"));
    p.ac.send("Ghostly only");
    await vi.waitFor(() => expect(p.received[1]).toHaveBeenCalledWith("Ghostly only"));
    expect(p.pinned[0]).toHaveBeenCalledWith(p.a.state.peerKey, true);
  });
  it("reconnects with persisted participation keys and fresh session context without another invite", async () => {
    const p = pair(); await confirming(p);
    await p.a.confirm(p.a.state.code!); await p.b.confirm(p.b.state.code!);
    p.a.stop(); p.b.stop();
    expect(p.creds.every(c => c.requireSignedSignals)).toBe(true);
    const q = pair(structuredClone(p.creds));
    await vi.waitFor(() => expect(q.a.state.status).toBe("ready"));
    expect(q.b.state.status).toBe("ready");
  });
  it("rejects a different participant reusing the consumed bootstrap invite", async () => {
    const p = pair(); await confirming(p);
    await p.a.confirm(p.a.state.code!); await p.b.confirm(p.b.state.code!);
    p.a.stop(); p.b.stop();
    const q = pair([structuredClone(p.creds[0]), {seedB64:createIdentity().seedB64}]);
    await vi.waitFor(() => expect(q.a.state.status).toBe("error"));
    expect(q.a.state.error).toMatch(/already paired/);
    expect(q.ready[0]).not.toHaveBeenCalled();
  });
  it("rejects proof relayed onto a different DTLS connection", async () => {
    const p = pair(undefined, {fingerprints:["c".repeat(64),"d".repeat(64)]});
    await vi.waitFor(() => expect(p.a.state.status).toBe("error"));
    expect(p.ready[0]).not.toHaveBeenCalled();
  });
  it("rejects a transcript from another rendezvous context", async () => {
    const p = pair(undefined, {rendezvousKeys:[aKey,createIdentity().pubKeyZ32]});
    await vi.waitFor(() => expect(p.a.state.status).toBe("error"));
  });
  it("fails closed on storage failure and does not emit readiness", async () => {
    const p = pair(undefined, {pinPeer:async () => {throw new Error("disk full");}}); await confirming(p);
    await p.b.confirm(p.b.state.code!);
    expect(p.b.state.status).toBe("error");
    expect(p.ready[1]).not.toHaveBeenCalled();
    expect(p.creds[1].peerKey).toBeUndefined();
  });
  it("requires confirmation of the current code and ignores duplicate confirm clicks", async () => {
    const p = pair(); await confirming(p);
    await expect(p.a.confirm("old code")).rejects.toThrow(/changed/);
    await Promise.all([p.a.confirm(p.a.state.code!),p.a.confirm(p.a.state.code!)]);
    expect(p.pinned[0]).toHaveBeenCalledOnce();
  });
  it("survives a crash after only one side durably confirmed", async () => {
    const p = pair(); await confirming(p); await p.a.confirm(p.a.state.code!);
    p.a.stop(); p.b.stop();
    const q = pair(structuredClone(p.creds));
    await vi.waitFor(() => expect(q.b.state.status).toBe("confirm"));
    expect(q.a.state.status).toBe("waiting");
    await q.b.confirm(q.b.state.code!);
    await vi.waitFor(() => expect(q.a.state.status).toBe("ready"));
  });
  it("does not enable a stopped connection when an in-flight durable pin completes", async () => {
    let release!: () => void;
    const p = pair(undefined, {pinPeer:() => new Promise<void>(r => {release=r;})}); await confirming(p);
    const waiting = p.b.confirm(p.b.state.code!);
    p.b.stop(); release(); await waiting;
    expect(p.ready[1]).not.toHaveBeenCalled();
  });
  describe("automatic first use", () => {
    const tofu = { trustOnFirstUse: true };
    it("opens with no comparison at all, pinned and not verified", async () => {
      const p = pair(undefined, tofu, tofu);
      await vi.waitFor(() => expect(p.a.state.status).toBe("ready"));
      expect(p.b.state.status).toBe("ready");
      expect(p.pinned[0]).toHaveBeenCalledOnce();
      expect(p.pinned[0]).toHaveBeenCalledWith(p.a.state.peerKey, true);
      // Pinned is not verified: nobody compared anything.
      expect(p.a.state.verified).toBeFalsy();
      expect(p.creds[0].verifiedPeerKey).toBeUndefined();
      p.ac.send("no clicks"); await vi.waitFor(() => expect(p.received[1]).toHaveBeenCalledWith("no clicks"));
    });
    it("records a later comparison without pinning a second time", async () => {
      const verifyPeer = vi.fn(async (_key: string) => {});
      const p = pair(undefined, tofu, { ...tofu, verifyPeer });
      await vi.waitFor(() => expect(p.a.state.status).toBe("ready"));
      await p.a.confirm(p.a.state.code!);
      expect(verifyPeer).toHaveBeenCalledWith(p.a.state.peerKey);
      expect(p.creds[0].verifiedPeerKey).toBe(p.a.state.peerKey);
      expect(p.a.state.verified).toBe(true);
      expect(p.pinned[0]).toHaveBeenCalledOnce();
    });
    it("refuses a stale code on an open connection and records nothing", async () => {
      const verifyPeer = vi.fn(async (_key: string) => {});
      const p = pair(undefined, tofu, { ...tofu, verifyPeer });
      await vi.waitFor(() => expect(p.a.state.status).toBe("ready"));
      await expect(p.a.confirm("0000 0000 0000 0000 0000 0000")).rejects.toThrow(/changed/);
      expect(verifyPeer).not.toHaveBeenCalled();
      expect(p.creds[0].verifiedPeerKey).toBeUndefined();
      expect(p.a.state.verified).toBeFalsy();
    });
    it("says an older peer has not confirmed until it actually does", async () => {
      const p = pair(undefined, { trustOnFirstUse: false }, tofu);
      await vi.waitFor(() => expect(p.a.state.status).toBe("waiting"));
      expect(p.a.state.peerNeedsConfirmation).toBe(true);
      expect(p.b.state.status).toBe("confirm");
      expect(p.ready[0]).not.toHaveBeenCalled();
      await p.b.confirm(p.b.state.code!);
      await vi.waitFor(() => expect(p.a.state.status).toBe("ready"));
      expect(p.a.state.peerNeedsConfirmation).toBeFalsy();
    });
    it("blocks a first answer from any key but the one the invite named", async () => {
      // covers: invite.pin
      const p = pair([{ seedB64: createIdentity().seedB64, expectedPeerKey: createIdentity().pubKeyZ32 },
        { seedB64: createIdentity().seedB64 }], tofu, tofu);
      await vi.waitFor(() => expect(p.a.state.status).toBe("error"));
      expect(p.a.state.keyMismatch).toBe(true);
      expect(p.pinned[0]).not.toHaveBeenCalled();
      expect(p.ready[0]).not.toHaveBeenCalled();
    });
    it("pins the key the invite named when that key answers", async () => {
      const inviter = createIdentity();
      const p = pair([{ seedB64: createIdentity().seedB64, expectedPeerKey: inviter.pubKeyZ32 }, { seedB64: inviter.seedB64 }], tofu, tofu);
      await vi.waitFor(() => expect(p.pinned[0]).toHaveBeenCalledWith(inviter.pubKeyZ32, true));
    });
    it("still blocks a key that changed under a pinned contact", async () => {
      const p = pair([{ seedB64: createIdentity().seedB64, peerKey: createIdentity().pubKeyZ32 },
        { seedB64: createIdentity().seedB64 }], tofu, { ...tofu, filesSupport: true, paymentsSupport: true });
      await vi.waitFor(() => expect(p.a.state.status).toBe("error"));
      expect(p.a.state.keyMismatch).toBe(true);
      expect(p.ready[0]).not.toHaveBeenCalled();
      expect(p.pinned[0]).not.toHaveBeenCalled();
      expect(p.a.supports("files/2")).toBe(false);
      expect(p.a.supports("payments/1")).toBe(false);
      p.bc.send("message from replacement");
      p.bc.send(JSON.stringify({ t: "file-offer", id: "replacement" }));
      p.bc.send(JSON.stringify({ t: "payment", id: "replacement" }));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(p.received[0]).not.toHaveBeenCalled();
    });
  });

  it("rejects incompatible versions before asking the user to confirm", async () => {
    const [ac,bc] = createChannelPair();
    const s = new PairedSession(ac, {credentials:{seedB64:createIdentity().seedB64},rendezvousKeys:[aKey,bKey],
      fingerprints:["a".repeat(64),"b".repeat(64)],pinPeer:vi.fn(),onState:vi.fn(),onReady:vi.fn(),onApplication:vi.fn(),onFailure:vi.fn()});
    active.push(s); s.start();
    bc.send(JSON.stringify({t:"pair-offer",versions:[99],transports:["webrtc/1"],capabilities:["chat/1"],key:createIdentity().pubKeyZ32,nonce:"a".repeat(43)}));
    await vi.waitFor(() => expect(s.state.status).toBe("error"));
    expect(s.state.error).toMatch(/compatible/);
  });
  it("rejects a proof recorded from an earlier session with the same participation keys", async () => {
    const p = pair();
    let oldProof = "";
    const original = p.bc.send.bind(p.bc);
    p.bc.send = data => {
      if (typeof data === "string" && data.startsWith('{"t":"pair-proof"')) oldProof = data;
      original(data);
    };
    await confirming(p);
    expect(oldProof).not.toBe("");
    p.a.stop(); p.b.stop();
    const q = pair(structuredClone(p.creds));
    const next = q.bc.send.bind(q.bc);
    q.bc.send = data => next(typeof data === "string" && data.startsWith('{"t":"pair-proof"') ? oldProof : data);
    await vi.waitFor(() => expect(q.a.state.status).toBe("error"));
    expect(q.ready[0]).not.toHaveBeenCalled();
  });

});
