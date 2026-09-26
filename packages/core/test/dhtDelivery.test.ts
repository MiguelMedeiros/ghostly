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
it("ignores a replacement participation key without stopping, and exposes real publication errors",async()=>{
  vi.useFakeTimers();const h=setup(),a=h.make(0),b=h.make(1);await a.start();await b.start();await vi.advanceTimersByTimeAsync(4500);
  await a.stop();const pinned=h.credentials[1].peerKey;h.credentials[0].seedB64=createIdentity().seedB64;
  const replacement=h.make(0);await replacement.start();await vi.advanceTimersByTimeAsync(4500);
  // Its envelopes are sealed with the invite key or to a key it cannot know: nothing is taken, and nothing stops.
  expect(h.views[1].mock.lastCall?.[0].error).toBeUndefined();
  h.publish.mockRejectedValueOnce(new Error("relay unavailable"));
  expect(await replacement.send("private hello",Date.now(),"abcdefghijklmnopqrstuv")).toContain("publication failed");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(h.messages[1].size).toBe(0);
  expect(h.credentials[1].peerKey,"the pin is not replaced").toBe(pinned);
  await replacement.stop();await b.stop();
});

it("a copy of the invite, publishing in both invite mailboxes, neither stops the chat nor loses a text",async()=>{
  vi.useFakeTimers();const h=setup(),a=h.make(0),b=h.make(1);
  await a.start();await b.start();await vi.advanceTimersByTimeAsync(4500);
  const pins=h.credentials.map(c=>c.peerKey);
  expect(pins.every(Boolean)).toBe(true);
  // A text each way, and both sides are in the pinned mailboxes.
  expect(await a.send("one",Date.now(),"aaaaaaaaaaaaaaaaaaaaaa")).toBeNull();await vi.advanceTimersByTimeAsync(10_000);
  expect(await b.send("two",Date.now(),"bbbbbbbbbbbbbbbbbbbbbb")).toBeNull();await vi.advanceTimersByTimeAsync(10_000);
  // The last side to move publishes there with its next envelope (a control one at the latest): here, one more text each way.
  expect(await a.send("one again",Date.now(),"aaaaaaaaaaaaaaaaaaaaab")).toBeNull();await vi.advanceTimersByTimeAsync(10_000);
  expect(await b.send("two again",Date.now(),"bbbbbbbbbbbbbbbbbbbbbc")).toBeNull();await vi.advanceTimersByTimeAsync(10_000);
  expect([h.saved[0].peerPinned,h.saved[1].peerPinned]).toEqual(["seen","seen"]);
  // Someone holding the invite: either side's link keys and a participation key of its own, republishing all the time.
  const copies=[0,1].map(i=>new DhtDelivery({params:h.params[i],mode:"dht",credentials:{seedB64:createIdentity().seedB64},transport:{publish:h.publish,resolve:h.resolve,describe:()=>({protocol:"copy",relays:[]})},
    save:async()=>{},pin:async()=>{},message:async()=>{},receipt:async()=>{},changed:()=>{},pollMs:100}));
  for(const copy of copies)await copy.start();
  const flood=setInterval(()=>{for(const copy of copies)void copy.send("spam",Date.now(),"zzzzzzzzzzzzzzzzzzzzzz");},1_000);
  expect(await a.send("three",Date.now(),"cccccccccccccccccccccc")).toBeNull();await vi.advanceTimersByTimeAsync(10_000);
  expect(await b.send("four",Date.now(),"dddddddddddddddddddddd")).toBeNull();await vi.advanceTimersByTimeAsync(10_000);
  clearInterval(flood);
  expect(h.messages[1].get("cccccccccccccccccccccc")).toBe("three");
  expect(h.messages[0].get("dddddddddddddddddddddd")).toBe("four");
  expect([...h.messages[0].values(),...h.messages[1].values()]).not.toContain("spam");
  expect(h.receipts[0]).toHaveBeenCalledWith("cccccccccccccccccccccc");
  expect(h.receipts[1]).toHaveBeenCalledWith("dddddddddddddddddddddd");
  for(const i of [0,1]){
    expect(h.views[i].mock.lastCall?.[0].error).toBeUndefined();
    expect(h.credentials[i].peerKey).toBe(pins[i]);
    expect(h.saved[i]).not.toHaveProperty("peerRejected");
  }
  for(const copy of copies)await copy.stop();await a.stop();await b.stop();
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
