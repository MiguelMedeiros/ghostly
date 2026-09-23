import "fake-indexeddb/auto";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { GhostLink, createIdentity, createLink, type PairingState, type NativeEndpoint } from "@ghostly/core";
import { db } from "../src/engine/db";
import { Outbox } from "../src/engine/outbox";
import { nativePeer } from "./helpers/nativePeer";

it.skipIf(process.env.TEST_NATIVE !== "1")("migrates real Iroh to real HyperDHT with stable participation, durable receipts and deduplication", async () => {
  // Local UDP discovery avoids making public relay uptime a test prerequisite.
  const { default: testnet } = await import("../../../native-transports/hyperdht/node_modules/hyperdht/testnet.js");
  const { createHyperEndpoint } = await import("../../../native-transports/hyperdht/endpoint.mjs");
  const net = await testnet(3);
  const hyper = await Promise.all([31,32].map(seed => createHyperEndpoint(Buffer.alloc(32,seed), { bootstrap: net.bootstrap, host: "127.0.0.1" }))) as NativeEndpoint[];
  const iroh = await Promise.all([31,32].map(seed => nativePeer(resolve("../../target/debug/examples/iroh-peer"), seed)));
  const invitation = createLink();
  const params = [invitation.mine, invitation.invite];
  const states: PairingState[] = [{ status: "connecting" }, { status: "connecting" }];
  const links: GhostLink[] = [];
  const boxes: Outbox[] = [];
  const publish = vi.fn();
  const discoveries = [vi.fn(), vi.fn()];
  const receivedFiles: Uint8Array[][] = [[], []];
  const fileDone = [vi.fn(), vi.fn()];
  const payments = [vi.fn(), vi.fn()];
  const requests = [vi.fn(), vi.fn()];
  const results = [vi.fn(), vi.fn()];
  for (let i=0; i<2; i++) {
    const id = `native-migration-${i}`, participationSeed = createIdentity().seedB64;
    await db.putLink({ ...params[i], id, profile:"paired-chat/1", participationSeed, createdAt:1 });
    boxes[i] = new Outbox({ read: () => db.getMessages(id), update:(key,state,error) => db.updateDelivery(id,key,state,error) },
      message => links[i].sendMessage(message.text,message.timestamp,message.wireId), 200);
    links[i] = new GhostLink({ params:{...params[i],profile:"paired-chat/1"},rtcAvailable:false,
      pairing:{credentials:{seedB64:participationSeed},pinPeer:(key,signed) => db.pinPeer(id,key,signed)},
      native:{preferred:"iroh/1",fallback:true,peerDescriptors:{"iroh/1":iroh[1-i].descriptor,"hyperdht/1":hyper[1-i].descriptor},peerTransports:["iroh/1","hyperdht/1"],peerFallback:true},
      transport:{publish,resolve:async()=>null,describe:()=>({protocol:"local transport integration test",relays:[]})},
      createPeerConnection:()=>{throw new Error("No WebRTC in native migration test");},localFetch:vi.fn(),getServices:()=>[],getHostedHttpService:()=>undefined,
      events:{
        onTransportDiscovery: async (...args) => { discoveries[i](...args); },
        onFileIncoming: () => ({ write: chunk => { receivedFiles[i].push(chunk); }, close: async () => {}, abort() {} }),
        onFileComplete: fileDone[i],
        onPayment: payments[i], onPaymentRequest: requests[i], onPaymentResult: results[i],
        onPairingState:state=>{states[i]=state;},
        onMessage:async message=>{await db.addMessage({linkId:id,id:`peer_${message.id}`,sender:"peer",timestamp:message.timestamp,text:message.text,via:"datalink"});},
        onMessageReceipt:wireId=>boxes[i].received(wireId)},
    });
    links[i].registerEndpoint(iroh[i]);links[i].registerEndpoint(hyper[i]);
  }
  try {
    // Preferences can be edited before either endpoint starts a handshake.
    for (const link of links) {
      await link.setTransportPreference("hyperdht/1", false);
      await link.setTransportPreference("iroh/1", true);
    }
    expect(states.map(state => state.status)).toEqual(["connecting", "connecting"]);
    const connected=links[0].connect(5000);
    await vi.waitFor(()=>expect(states.map(s=>s.status)).toEqual(["ready","ready"]));
    expect(states[0].code).toBe(states[1].code);
    expect(states.every(state => !state.verified)).toBe(true);
    await connected;
    const exercise = async (tag: string) => {
      await vi.waitFor(() => expect(links.every(link => link.supportsFiles && link.supportsPayments)).toBe(true));
      for (const link of links) expect(link.canReleaseEndpoint(states[0].transport!)).toBe(false);
      const bytes = new Uint8Array(128 * 1024 + 7).fill(73);
      const id = `file-${tag}-12345678`;
      await links[0].sendFile({ id, name: `${tag}.bin`, mime: "application/octet-stream", size: bytes.length, timestamp: 100 }, (async function* () { yield bytes; })());
      expect(fileDone[0]).toHaveBeenCalledWith(id, "out");
      expect(Buffer.concat(receivedFiles[1].map(chunk => Buffer.from(chunk)))).toEqual(Buffer.from(bytes));
      receivedFiles[1] = [];
      await links[0].sendPayment({ id: `pay-${tag}-12345678`, timestamp: 101, amount: { value: "1", asset: "sat" }, endpoint: ["cashu", "protocol-fixture-not-money"] });
      await vi.waitFor(() => expect(payments[1]).toHaveBeenCalledWith(expect.objectContaining({ id: `pay-${tag}-12345678` })));
      await links[1].sendPaymentRequest({ id: `req-${tag}-12345678`, timestamp: 102, amount: { value: "1", asset: "sat" }, endpoints: [["cashu", "{}"]] });
      await vi.waitFor(() => expect(requests[0]).toHaveBeenCalledWith(expect.objectContaining({ id: `req-${tag}-12345678` })));
      links[1].sendPaymentResult({ id: `pay-${tag}-12345678`, ok: true, credited: "1" });
      await vi.waitFor(() => expect(results[0]).toHaveBeenCalledWith(expect.objectContaining({ ok: true })));
    };
    await exercise("iroh");
    const pins=states.map(s=>s.peerKey);
    const wireId="abcdefghijklmnopqrstuv";
    await db.addMessage({linkId:"native-migration-0",id:`me_${wireId}`,wireId,text:"same message across QUIC and Noise",timestamp:1,sender:"me",via:"datalink",delivery:"sending"});
    iroh[0].dropReceipts=true;
    await boxes[0].transmit(`me_${wireId}`);
    await vi.waitFor(async()=>expect((await db.getMessages("native-migration-0"))[0].delivery).toBe("failed"));
    await links[0].setTransportPreference("hyperdht/1",false);
    await vi.waitFor(()=>expect(states.map(s=>s.transport)).toEqual(["hyperdht/1","hyperdht/1"]));
    expect(states.map(s=>s.peerKey)).toEqual(pins);
    await exercise("hyperdht");
    await boxes[0].recover();await boxes[0].transmit(`me_${wireId}`);
    await vi.waitFor(async()=>expect((await db.getMessages("native-migration-0"))[0].delivery).toBe("delivered"));
    expect(await db.getMessages("native-migration-1")).toHaveLength(1);
    links[0].disconnect();await vi.waitFor(()=>expect(links[1].isDataLinkOpen).toBe(false));
    await links[0].connect(5000);
    expect(states.map(s=>s.peerKey)).toEqual(pins);
    await links[0].setTransportPreference("iroh/1",false);
    await vi.waitFor(()=>expect(states.map(s=>s.transport)).toEqual(["iroh/1","iroh/1"]));
    expect(await db.getMessages("native-migration-1")).toHaveLength(1);
    // Either role proposes, with both fallback settings, on real SDK channels.
    iroh[0].dropReceipts = false;
    for (const initiator of [0, 1]) for (const fallback of [true, false]) {
      discoveries[initiator].mockClear();
      await links[1-initiator].setTransportPreference(states[1-initiator].transport!, true);
      await vi.waitFor(() => expect(discoveries[initiator]).toHaveBeenCalledWith(expect.anything(), expect.anything(), true));
      for (const target of ["hyperdht/1", "iroh/1"] as const) {
        await links[initiator].setTransportPreference(target, fallback);
        await vi.waitFor(() => expect(states.map(s => [s.status, s.transport])).toEqual([["ready", target], ["ready", target]]));
        expect(states.map(s => s.peerKey)).toEqual(pins);
        await exercise(`${initiator}-${fallback}-${target.replace("/", "-")}`);
        const wire = `${initiator}${fallback ? 1 : 0}${target === "iroh/1" ? 1 : 0}abcdefghijklmnopqrs`;
        await db.addMessage({linkId:`native-migration-${initiator}`,id:`me_${wire}`,wireId:wire,text:wire,timestamp:2,sender:"me",via:"datalink",delivery:"sending"});
        await boxes[initiator].transmit(`me_${wire}`);
        await vi.waitFor(async () => expect((await db.getMessages(`native-migration-${initiator}`)).find(m => m.id === `me_${wire}`)?.delivery).toBe("delivered"));
      }
    }
    await Promise.all([links[0].setTransportPreference("iroh/1", false), links[1].setTransportPreference("hyperdht/1", false)]);
    await vi.waitFor(() => expect(states.every(s => !!s.transitionError)).toBe(true));
    expect(links.every(l => !l.isDataLinkOpen && !l.supportsFiles && !l.supportsPayments)).toBe(true);
    expect(await links[0].sendMessage("strict mismatch must not send")).toBeTruthy();
    await expect(links[0].sendPayment({id:"blocked-payment",timestamp:4,amount:{value:"1",asset:"sat"},endpoint:["cashu","fixture"]})).rejects.toThrow();
    await links[0].setTransportPreference("hyperdht/1", false);
    await vi.waitFor(() => expect(states.map(s => [s.status, s.transport])).toEqual([["ready", "hyperdht/1"], ["ready", "hyperdht/1"]]));
    await exercise("conflict-recovered");
    // Rapid local updates and simultaneous proposals must settle without loops.
    await Promise.all([links[0].setTransportPreference("iroh/1", true), links[1].setTransportPreference("hyperdht/1", true)]);
    await links[1].setTransportPreference("iroh/1", true);
    await vi.waitFor(() => expect(states.every(s => s.status === "ready" && s.transport === "iroh/1" && !s.transitionTarget)).toBe(true));
    expect(states.map(s=>s.peerKey)).toEqual(pins);
    // A real endpoint's dial failure must keep the existing channel only when
    // both policies permit it, and must remain explicitly recoverable with OFF.
    await Promise.all(links.map(l => l.setTransportPreference("iroh/1", true)));
    await vi.waitFor(() => expect(states.every(s => s.status === "ready" && s.transport === "iroh/1" && !s.transitionTarget)).toBe(true));
    const coordinator = links[0].myPubKeyZ32 < links[1].myPubKeyZ32 ? 0 : 1;
    const failedDial = vi.spyOn(hyper[coordinator], "connect").mockRejectedValue(new Error("injected native dial failure"));
    await links[1-coordinator].setTransportPreference("hyperdht/1", true);
    await vi.waitFor(() => expect(failedDial).toHaveBeenCalled());
    await vi.waitFor(() => expect(states.every(s => s.status === "ready" && s.transport === "iroh/1" && !s.transitionTarget)).toBe(true));
    await exercise("mutual-fallback-after-failed-dial");
    await links[1-coordinator].setTransportPreference("hyperdht/1", false);
    await vi.waitFor(() => expect(states.every(s => !!s.transitionError)).toBe(true));
    expect(links.every(l => !l.isDataLinkOpen && !l.supportsFiles && !l.supportsPayments)).toBe(true);
    failedDial.mockRestore();
    // The same selected preference is a retry, not a no-op.
    await links[1-coordinator].setTransportPreference("hyperdht/1", false);
    await vi.waitFor(() => expect(states.every(s => s.status === "ready" && s.transport === "hyperdht/1")).toBe(true));
    await exercise("strict-dial-failure-recovered");
    for (const initiator of [0,1]) {
      links[initiator].disconnect();
      await vi.waitFor(() => expect(links.every(l => !l.isDataLinkOpen)).toBe(true));
      const target = initiator === 0 ? "hyperdht/1" : "iroh/1";
      await Promise.all(links.map(l => l.setTransportPreference(target, false)));
      await links[initiator].connect(5000);
      await vi.waitFor(() => expect(states.map(s => [s.status,s.transport])).toEqual([["ready",target],["ready",target]]));
      expect(states.map(s=>s.peerKey)).toEqual(pins);
      await exercise(`offline-${initiator}`);
    }
    await links[0].setTransportPreference("hyperdht/1", true);
    await vi.waitFor(() => expect(states.every(s => s.status === "ready" && s.transport === "iroh/1")).toBe(true));
    links[0].disconnect();
    await vi.waitFor(() => expect(links[1].isDataLinkOpen).toBe(false));
    await links[0].connect(5000);
    await vi.waitFor(() => expect(states.every(s => s.status === "ready" && s.transport === "iroh/1")).toBe(true));
    expect(publish).not.toHaveBeenCalled();
  } finally { await Promise.all(boxes.map(box=>box.stop()));await Promise.all(links.map(link=>link.stop(false)));await net.destroy(); }
},60000);
