import { expect, it, vi } from "vitest";
import { GhostLink } from "../src/ghostlink";
import { createLink } from "../src/invite";
import { createIdentity } from "../src/identity";
import { irohDescriptor, irohRelayUrl, type TransportDescriptors } from "../src/pairedTransports";

// covers: transport.iroh, transport.relayed

/**
 * Iroh compares relay URLs as text and names n0's relays with the trailing dot of a full domain name. The web app
 * wrote them without it, so a browser and a Desktop on the same server each took the other's relay for another one.
 */
it("spells a relay the way Iroh's own peers do: a domain name with its trailing dot", () => {
  expect(irohRelayUrl("https://use1-1.relay.n0.iroh.link/")).toBe("https://use1-1.relay.n0.iroh.link./");
  expect(irohRelayUrl("https://use1-1.relay.n0.iroh.link./")).toBe("https://use1-1.relay.n0.iroh.link./");
  // As a person types it in Settings: no path, capitals, a port.
  expect(irohRelayUrl("https://Relay.Example.com")).toBe("https://relay.example.com./");
  expect(irohRelayUrl("https://relay.example.com:8443/")).toBe("https://relay.example.com.:8443/");
  expect(irohRelayUrl("https://relay.example.com.:8443")).toBe("https://relay.example.com.:8443");
  // Once is enough.
  for (const url of ["https://relay.example.com/", "http://localhost.:3340/", "http://127.0.0.1:3340"]) expect(irohRelayUrl(irohRelayUrl(url))).toBe(irohRelayUrl(url));
});

it("has a spelling without the dot for a browser's Iroh: WebKit opens no host name that ends in one", () => {
  expect(irohRelayUrl("https://use1-1.relay.n0.iroh.link./", "plain")).toBe("https://use1-1.relay.n0.iroh.link/");
  expect(irohRelayUrl("https://use1-1.relay.n0.iroh.link/", "plain")).toBe("https://use1-1.relay.n0.iroh.link/");
  expect(irohRelayUrl("https://relay.example.com.:8443", "plain")).toBe("https://relay.example.com:8443/");
  // The two spellings name one relay: each turns into the other, and compares equal once put in either.
  for (const url of ["https://relay.example.com/", "https://relay.example.com./", "http://localhost.:3340/", "http://127.0.0.1:3340", "https://relay/"]) {
    expect(irohRelayUrl(irohRelayUrl(url, "plain"), "dotted")).toBe(irohRelayUrl(url, "dotted"));
    expect(irohRelayUrl(irohRelayUrl(url, "dotted"), "plain")).toBe(irohRelayUrl(url, "plain"));
    expect(new URL(irohRelayUrl(url, "plain")).hostname.endsWith(".")).toBe(false);
  }
  const desktop = { id: "a".repeat(64), relay: "https://euc1-1.relay.n0.iroh.link./", addresses: ["192.168.0.2:4000"] };
  expect(irohDescriptor(desktop, "plain")).toEqual({ ...desktop, relay: "https://euc1-1.relay.n0.iroh.link/" });
});

it("leaves addresses and single-label names as written, and loopback without a dot", () => {
  for (const url of ["http://127.0.0.1:47085", "http://127.0.0.1:47085/", "http://[::1]:3340/", "https://192.0.2.7/", "http://localhost:3340/", "https://relay/"])
    for (const spelling of ["dotted", "plain"] as const) expect(irohRelayUrl(url, spelling)).toBe(url);
  for (const spelling of ["dotted", "plain"] as const) expect(irohRelayUrl("http://localhost.:3340/", spelling)).toBe("http://localhost:3340/");
  // Not a URL: the caller's own check refuses it.
  for (const junk of ["", "not a url", "relay.example.com"]) expect(irohRelayUrl(junk)).toBe(junk);
});

it("puts a descriptor's relay in that spelling and keeps everything else", () => {
  const browser = { id: "b".repeat(64), relay: "https://euc1-1.relay.n0.iroh.link/", addresses: [], relayed: true };
  expect(irohDescriptor(browser)).toEqual({ ...browser, relay: "https://euc1-1.relay.n0.iroh.link./" });
  const desktop = { id: "a".repeat(64), relay: "https://euc1-1.relay.n0.iroh.link./", addresses: ["192.168.0.2:4000"] };
  expect(irohDescriptor(desktop)).toBe(desktop);
  for (const other of [null, undefined, "iroh", { id: "c" }, { id: "c", relay: null }, { id: "c", relay: 7 }]) expect(irohDescriptor(other)).toBe(other);
});

it("takes a contact's record naming the same relay in the other spelling as no change", async () => {
  const { mine } = createLink();
  const link = new GhostLink({
    params: { ...mine, profile: "paired-chat/1" }, rtcAvailable: false,
    pairing: { credentials: { seedB64: createIdentity().seedB64, peerKey: createIdentity().pubKeyZ32 }, pinPeer: async () => {} },
    native: { preferred: "iroh/1", fallback: true },
    transport: { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "none", relays: [] }) },
    createPeerConnection: () => { throw new Error("no WebRTC here"); },
    localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
  });
  const known = () => (link as unknown as { peerDescriptors: TransportDescriptors }).peerDescriptors["iroh/1"];
  const first = { id: "a", relay: "https://use1-1.relay.n0.iroh.link./", addresses: ["192.0.2.1:4433"] };
  link.learnPeerTransports(["iroh/1"], { "iroh/1": first }, true);
  expect(known()).toEqual(first);
  const before = known();
  // The same server without the dot (an older web app's record): the descriptor known stays, object and all.
  link.learnPeerTransports(["iroh/1"], { "iroh/1": { id: "a", relay: "https://use1-1.relay.n0.iroh.link/" } }, true);
  expect(known()).toBe(before);
  // Another server is a change: the relay is taken, the addresses kept.
  link.learnPeerTransports(["iroh/1"], { "iroh/1": { id: "a", relay: "https://euc1-1.relay.n0.iroh.link/" } }, true);
  expect(known()).toEqual({ ...first, relay: "https://euc1-1.relay.n0.iroh.link/" });
  await link.stop(false);
});
