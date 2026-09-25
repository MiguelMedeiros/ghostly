import { afterEach, expect, it, vi } from "vitest";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromBase64Url, utf8Encode } from "../src/bytes";
import { tryDecrypt } from "../src/crypto";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { createLink } from "../src/invite";
import { DhtDelivery, DHT_MESSAGE_TTL, emptyDhtDeliveryState, type DhtDeliveryState } from "../src/dhtDelivery";
import { createRelayPayload, parseRelayPayload, type SignedPacket } from "../src/pkarr";
import type { PairingCredentials } from "../src/pairedSession";
// covers: chat.dht.delivery, chat.dht.send, chat.dht.offline, chat.dht.fallback, chat.dht.errors, chat.dht.key-change

function setup() {
  const link = createLink(), params = [link.mine,link.invite];
  const packets = new Map<string,SignedPacket>();
  const saved: DhtDeliveryState[] = [emptyDhtDeliveryState(),emptyDhtDeliveryState()];
  const credentials: PairingCredentials[] = [0,1].map(()=>({seedB64:createIdentity().seedB64}));
  const failMessage = [false, false];
  const messages = [new Map<string,string>(),new Map<string,string>()], receipts = [vi.fn(),vi.fn()], views = [vi.fn(),vi.fn()];
  const publish = vi.fn(async (identity,records) => {
    const wire = createRelayPayload(identity,records);
    expect(wire.length).toBeLessThanOrEqual(1072);
    expect(new TextDecoder().decode(wire)).not.toContain("private hello");
    packets.set(identity.pubKeyZ32,parseRelayPayload(identity.pubKeyZ32,wire));
  });
  const resolve = vi.fn(async key=>packets.get(key)??null);
  const make = (i:number, mode: "stream" | "dht" = "dht") => new DhtDelivery({ params:params[i],mode,state:saved[i],credentials:credentials[i],transport:{publish,resolve,describe:()=>({protocol:"signed-packet fixture",relays:[]})},
    save:async state=>{saved[i]=structuredClone(state);},pin:async key=>{if(credentials[i].peerKey && credentials[i].peerKey!==key) throw new Error("pin mismatch");credentials[i].peerKey=key;},
    message:async m=>{if (failMessage[i]) throw new Error("Message storage unavailable"); messages[i].set(m.id,m.text);},receipt:async id=>{receipts[i](id);},changed:views[i],pollMs:100 });
  return {failMessage,params,packets,saved,credentials,messages,receipts,views,publish,resolve,make};
}
afterEach(()=>vi.useRealTimers());
it("bootstraps a new invite, delivers exact text to a late receiver, receipts and durable replay protection without streams", async()=>{
  vi.useFakeTimers(); const h=setup(); let a=h.make(0), b=h.make(1);
  await a.start(); await vi.advanceTimersByTimeAsync(200);
  expect(await a.send("private hello 🌙",Date.now(),"abcdefghijklmnopqrstuv")).toBeNull();
  const replay = new Map(h.packets);
  await a.stop(); // sender absent when receiver first joins
  await b.start(); await vi.advanceTimersByTimeAsync(4500);
  expect(h.messages[1].get("abcdefghijklmnopqrstuv")).toBe("private hello 🌙");
  expect(h.credentials[1].peerKey).toBeTruthy();
  await b.stop(); a=h.make(0); await a.start(); await vi.advanceTimersByTimeAsync(4500);
  expect(h.receipts[0]).toHaveBeenCalledWith("abcdefghijklmnopqrstuv");
  expect(h.saved[0].pending).toBeUndefined();
  b=h.make(1); await b.start(); await vi.advanceTimersByTimeAsync(200);
  for(const [key,packet]of replay)h.packets.set(key,packet);
  await vi.advanceTimersByTimeAsync(4500); expect(h.messages[1].size).toBe(1);
  expect(a.comparisonCode).toBe(b.comparisonCode);
  await a.stop();await b.stop();
});
it("rejects oversized UTF8 instead of truncating and stops retransmission at expiry",async()=>{
  vi.useFakeTimers();const h=setup(),a=h.make(0);await a.start();await vi.advanceTimersByTimeAsync(200);
  expect(await a.send("🌙".repeat(65),Date.now(),"abcdefghijklmnopqrstuv")).toContain("256");
  expect(await a.send("x".repeat(256),Date.now(),"abcdefghijklmnopqrstuv")).toBeNull();
  await vi.advanceTimersByTimeAsync(DHT_MESSAGE_TTL+1000);
  expect(h.saved[0].pending?.attempts).toBeLessThanOrEqual(8);
  const b=h.make(1);await b.start();await vi.advanceTimersByTimeAsync(1000);expect(h.messages[1].size).toBe(0);
  await a.stop();await b.stop();
});
it("fails closed on a replacement participation key and exposes real publication errors",async()=>{
  vi.useFakeTimers();const h=setup(),a=h.make(0),b=h.make(1);await a.start();await b.start();await vi.advanceTimersByTimeAsync(4500);
  await a.stop();h.credentials[0].seedB64=createIdentity().seedB64;
  const replacement=h.make(0);await replacement.start();await vi.advanceTimersByTimeAsync(4500);
  expect(h.views[1].mock.lastCall?.[0].error).toContain("does not match");
  h.publish.mockRejectedValueOnce(new Error("relay unavailable"));
  expect(await replacement.send("private hello",Date.now(),"abcdefghijklmnopqrstuv")).toContain("publication failed");
  expect(h.messages[1].size).toBe(0);await replacement.stop();await b.stop();
});

it("accepts offline text for stream-preferring authenticated peers and preserves pending intent across mode changes", async () => {
  vi.useFakeTimers(); const h = setup(), a = h.make(0, "stream"), b = h.make(1, "stream");
  // Every chat's first contact may carry text (WISP 403): no refusal before the pin any more.
  expect(a.validate("first", Date.now(), "abcdefghijklmnopqrstuv")).toBeNull();
  await a.start(); await b.start(); await vi.advanceTimersByTimeAsync(4500);
  expect(await a.send("offline text", Date.now(), "abcdefghijklmnopqrstuv")).toBeNull();
  const deadline = h.saved[0].pending!.expires;
  await a.setMode("dht");
  expect(h.saved[0].pending!.expires).toBe(deadline);
  await vi.advanceTimersByTimeAsync(4500);
  expect(h.messages[1].get("abcdefghijklmnopqrstuv")).toBe("offline text");
  expect(h.receipts[0]).toHaveBeenCalledWith("abcdefghijklmnopqrstuv");
  await a.stop(); await b.stop();
});
it("preflights escaped packet size and tokens without creating pending intent", async () => {
  vi.useFakeTimers(); const h = setup(), a = h.make(0), b = h.make(1);
  await a.start(); await b.start(); await vi.advanceTimersByTimeAsync(4500);
  expect(a.validate("\u0001".repeat(256), Date.now(), "abcdefghijklmnopqrstuv")).toContain("packet budget");
  expect(a.validate("cashuAabcdef", Date.now(), "abcdefghijklmnopqrstuv")).toContain("Payment tokens");
  expect(h.saved[0].pending).toBeUndefined();
  expect(await a.send("x".repeat(256), Date.now(), "abcdefghijklmnopqrstuv")).toBeNull();
  expect(a.validate("second", Date.now(), "bcdefghijklmnopqrstuvw")).toContain("One DHT text");
  await vi.advanceTimersByTimeAsync(4500);
  expect(h.messages[1].get("abcdefghijklmnopqrstuv")).toBe("x".repeat(256));
  await a.stop(); await b.stop();
});

it("post-pin text cannot be decrypted using only the invitation secret", async () => {
  vi.useFakeTimers(); const h = setup(), a = h.make(0), b = h.make(1);
  await a.start(); await b.start(); await vi.advanceTimersByTimeAsync(4500);
  const pair = [identityFromSeedB64(h.params[0].seedB64).pubKeyZ32, h.params[0].peerPubKeyZ32].sort();
  const key = hkdf(sha256, fromBase64Url(h.params[0].encKeyB64), utf8Encode(JSON.stringify(["ghostly-dht-delivery/1", pair])), utf8Encode("envelope"), 32);
  expect(await a.send("private after pin", Date.now(), "abcdefghijklmnopqrstuv")).toBeNull();
  const packet = h.packets.get(h.publish.mock.lastCall![0].pubKeyZ32)!;
  expect(packet.records.some(r => r.label === "_dmk")).toBe(true);
  expect(tryDecrypt(packet.records.find(r => r.label === "_dm")!.value, key)).toBeNull();
  await vi.advanceTimersByTimeAsync(4500);
  expect(h.messages[1].get("abcdefghijklmnopqrstuv")).toBe("private after pin");
  await a.stop(); await b.stop();
});

it("never receipts content that failed durable storage, then safely retries the same packet", async () => {
  vi.useFakeTimers(); const h = setup(), a = h.make(0), b = h.make(1);
  await a.start(); await vi.advanceTimersByTimeAsync(200);
  expect(await a.send("store before receipt", Date.now(), "abcdefghijklmnopqrstuv")).toBeNull();
  h.failMessage[1] = true; await b.start(); await vi.advanceTimersByTimeAsync(4500);
  expect(h.messages[1].size).toBe(0); expect(h.saved[1].peerSequence).toBe(0);
  expect(h.receipts[0]).not.toHaveBeenCalled();
  h.failMessage[1] = false; await vi.advanceTimersByTimeAsync(4500);
  expect(h.messages[1].get("abcdefghijklmnopqrstuv")).toBe("store before receipt");
  expect(h.receipts[0]).toHaveBeenCalledWith("abcdefghijklmnopqrstuv");
  await a.stop(); await b.stop();
});
