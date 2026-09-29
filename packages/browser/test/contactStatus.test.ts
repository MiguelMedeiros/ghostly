import {expect,it} from "vitest";
import {contactStatus} from "../../../src/lib/contactStatus";
import type {PeerLinkState} from "../../../src/lib/platform";
// covers: chat.paired.status
const live={dataLink:"open",online:true,services:null,pairing:{status:"ready",transport:"webrtc/1"}} as PeerLinkState;
it("uses an authenticated open channel, never successful discovery alone, for Connected",()=>{
  expect(contactStatus(live,true,"online")).toBe("Connected");
  expect(contactStatus(live,true,"error")).toBe("Connected");
  expect(contactStatus({...live,dataLink:"idle"},true,"online")).toBe("Waiting for contact");
  expect(contactStatus({...live,dataLink:"connecting"},true,"online")).toBe("Connecting");
  expect(contactStatus({...live,deliveryMode:"dht"},true,"online")).toBe("DHT only · chosen by you");
  expect(contactStatus({...live,dataLink:"idle",textDelivery:"dht"},true,"online")).toBe("On DHT · retrying live");
  expect(contactStatus({...live,dataLink:"idle",textDelivery:"dht",dhtDelivery:{mode:"stream",peerMode:"dht",authenticated:true,maxTextBytes:256}},true,"online")).toBe("DHT only · chosen by your contact");
  expect(contactStatus(undefined,true,"online")).toBe("Waiting for contact");
  // A chosen transport not reached yet, nothing else allowed (WISP 100): waited for, not a connection issue.
  const wait={transport:"hyperdht/1",by:"you",reason:"unreachable",failures:1} as const;
  expect(contactStatus({...live,dataLink:"idle",textDelivery:"dht",pairing:{status:"negotiating",transport:"iroh/1"},transportWait:wait},true,"online")).toBe("On DHT · waiting for HyperDHT");
  expect(contactStatus({...live,dataLink:"idle",textDelivery:"unavailable",pairing:{status:"negotiating",transport:"iroh/1"},transportWait:wait},true,"online")).toBe("Waiting for HyperDHT");
  expect(contactStatus({...live,pairing:{status:"ready",transport:"iroh/1"},transportWait:{...wait,live:"iroh/1"}},true,"online")).toBe("Connected");
  expect(contactStatus(live,true,"offline")).toBe("Offline");
  expect(contactStatus({...live,pairing:{...live.pairing!,keyMismatch:true}},true,"online")).toBe("Identity mismatch");
});
