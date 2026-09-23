import { afterEach, expect, it, vi } from "vitest";
import { createIdentity } from "../src/identity";
import { PairedSession } from "../src/pairedSession";
import { rankTransports, transportOrder, type NativeBinding, type PairedTransport } from "../src/pairedTransports";
import { createChannelPair } from "./helpers";

const sessions: PairedSession[] = [];
afterEach(() => sessions.splice(0).forEach(session => session.stop()));
const binding: NativeBinding = { transport: "iroh/1", context: "a".repeat(64), identities: ["b".repeat(64), "c".repeat(64)] };
function pair(rightBinding = binding, offers: [PairedTransport[], PairedTransport[]] = [["iroh/1"], ["iroh/1"]], fallback = false) {
  const channels = createChannelPair();
  const ids = [createIdentity(), createIdentity()];
  const keys: [string, string] = [createIdentity().pubKeyZ32, createIdentity().pubKeyZ32];
  return channels.map((channel, i) => {
    const session = new PairedSession(channel, {
      credentials: { seedB64: ids[i].seedB64, peerKey: ids[1-i].pubKeyZ32 },
      binding: i ? rightBinding : binding, rendezvousKeys: keys, transports: offers[i], allowFallback: fallback,
      pinPeer: async () => {}, onState: () => {}, onReady: () => {}, onApplication: () => {}, onFailure: () => {},
    });
    sessions.push(session); session.start(); return session;
  });
}
it("uses a symmetric preference ranking and never invents available adapters", () => {
  expect(rankTransports(["webrtc/1", "iroh/1"], ["iroh/1", "webrtc/1"])).toEqual(["iroh/1", "webrtc/1"]);
  expect(rankTransports(["iroh/1", "webrtc/1"], ["webrtc/1", "iroh/1"])).toEqual(["iroh/1", "webrtc/1"]);
  expect(transportOrder(["webrtc/1"], "iroh/1", false)).toEqual([]);
  expect(transportOrder(["webrtc/1"], "iroh/1", true)).toEqual(["webrtc/1"]);
});
it("authenticates an Iroh TLS binding with existing participation pins", async () => {
  const [a,b] = pair();
  await vi.waitFor(() => expect([a.state.status,b.state.status]).toEqual(["ready","ready"]));
  expect(a.state.transport).toBe("iroh/1");
});
it.each(["exporter", "identity", "transport"])("rejects a relayed proof with a different %s", async field => {
  const other = { ...binding, identities: [...binding.identities] as [string,string] };
  if (field === "exporter") other.context = "d".repeat(64);
  if (field === "identity") other.identities[0] = "d".repeat(64);
  if (field === "transport") other.transport = "hyperdht/1";
  const [a,b] = pair(other, [["iroh/1", "hyperdht/1"], ["iroh/1", "hyperdht/1"]], true);
  await vi.waitFor(() => expect([a.state.status,b.state.status]).toContain("error"));
  expect(a.state.status).not.toBe("ready");
});
it("rejects a lower ranked transport without mutually authorized fallback", async () => {
  const [a,b] = pair(binding, [["webrtc/1", "iroh/1"], ["webrtc/1", "iroh/1"]]);
  await vi.waitFor(() => expect([a.state.status,b.state.status]).toContain("error"));
});
it("permits and identifies a mutually authorized fallback", async () => {
  const [a,b] = pair(binding, [["webrtc/1", "iroh/1"], ["webrtc/1", "iroh/1"]], true);
  await vi.waitFor(() => expect([a.state.status,b.state.status]).toEqual(["ready","ready"]));
  expect(a.state.preferred).toBe("webrtc/1"); expect(a.state.transport).toBe("iroh/1");
});
