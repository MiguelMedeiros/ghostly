import {expect,it} from "vitest";
import {contactStatus} from "../../../src/lib/contactStatus";
import type {PeerLinkState} from "../../../src/lib/platform";
const live={dataLink:"open",online:true,services:null,pairing:{status:"ready",transport:"webrtc/1"}} as PeerLinkState;
it("uses an authenticated open channel, never successful discovery alone, for Connected",()=>{
  expect(contactStatus(live,true,"online")).toBe("Connected");
  expect(contactStatus(live,true,"error")).toBe("Connected");
  expect(contactStatus({...live,dataLink:"idle"},true,"online")).toBe("Waiting for contact");
  expect(contactStatus({...live,dataLink:"connecting"},true,"online")).toBe("Connecting");
  expect(contactStatus({...live,deliveryMode:"dht"},true,"online")).toBe("DHT text · presence unknown");
  expect(contactStatus(undefined,true,"online")).toBe("Waiting for contact");
  expect(contactStatus(live,true,"offline")).toBe("Offline");
  expect(contactStatus({...live,pairing:{...live.pairing!,keyMismatch:true}},true,"online")).toBe("Identity mismatch");
});
