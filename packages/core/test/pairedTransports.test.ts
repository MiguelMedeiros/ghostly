import { afterEach, expect, it, vi } from "vitest";
import { createIdentity } from "../src/identity";
import { PairedSession } from "../src/pairedSession";
import { automaticTransport, rankTransports, transportOrder, type NativeBinding, type PairedTransport } from "../src/pairedTransports";
import { createChannelPair } from "./helpers";
// covers: transport.switch, transport.preference, transport.iroh

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
it("prefers Iroh when nobody chose, then WebRTC, then HyperDHT (WISP 100, revision 2026-11-08)", () => {
  // The web app and the PWA, whichever came up first.
  expect(automaticTransport(["webrtc/1", "iroh/1"])).toBe("iroh/1");
  expect(automaticTransport(["iroh/1", "webrtc/1"])).toBe("iroh/1");
  // The Desktop on macOS or Windows, and on Linux, whichever endpoint came up first.
  expect(automaticTransport(["webrtc/1", "hyperdht/1", "iroh/1"])).toBe("iroh/1");
  expect(automaticTransport(["hyperdht/1", "iroh/1"])).toBe("iroh/1");
  // Iroh not (yet) up: WebRTC where there is one.
  expect(automaticTransport(["webrtc/1", "hyperdht/1"])).toBe("webrtc/1");
  expect(automaticTransport(["hyperdht/1"])).toBe("hyperdht/1");
  expect(automaticTransport([])).toBe("webrtc/1");
  // Fallback off: the one transport the chat may use, WebRTC where there is one (Iroh's relay would be for good).
  expect(automaticTransport(["webrtc/1", "iroh/1"], false)).toBe("webrtc/1");
  expect(automaticTransport(["webrtc/1", "hyperdht/1", "iroh/1"], false)).toBe("webrtc/1");
  expect(automaticTransport(["hyperdht/1", "iroh/1"], false)).toBe("iroh/1");
  expect(automaticTransport(["hyperdht/1"], false)).toBe("hyperdht/1");
});
it("puts Iroh first on both sides when both apps run it and nobody chose", () => {
  const automatic = (available: PairedTransport[]) => transportOrder(available, automaticTransport(available), true);
  const web = automatic(["webrtc/1", "iroh/1"]), desktop = automatic(["webrtc/1", "iroh/1", "hyperdht/1"]);
  for (const [a, b] of [[web, web], [web, desktop], [desktop, desktop]]) {
    expect(rankTransports(a, b)[0]).toBe("iroh/1");
    expect(rankTransports(b, a)[0]).toBe("iroh/1");
  }
  // An app from before this rule puts WebRTC first: the sum ties, and the fixed order gives the new side Iroh.
  expect(rankTransports(web, transportOrder(["webrtc/1", "iroh/1"], "webrtc/1", true))[0]).toBe("iroh/1");
  // A contact with no Iroh: WebRTC, as before.
  expect(rankTransports(web, automatic(["webrtc/1"]))).toEqual(["webrtc/1"]);
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
