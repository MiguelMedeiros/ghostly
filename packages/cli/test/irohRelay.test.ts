import { expect, it } from "vitest";
import { nodePublicRelay } from "../src/runtime/irohRelay";
import { publicOnly } from "../src/runtime/pushSend";

// covers: transport.iroh-web

/** A DNS that answers each name from a table: no lookup leaves this machine. */
const answers = (table: Record<string, string[]>) => publicOnly((host, _options, callback) =>
  table[host] ? callback(null, table[host].map(address => ({ address, family: address.includes(":") ? 6 : 4 }))) :
    callback(Object.assign(new Error(`${host} not found`), { code: "ENOTFOUND" }), []));

it("takes a contact's Iroh relay only at a name whose every address is public now, or at a public address", async () => {
  const publicRelay = nodePublicRelay(answers({
    "relay.contact.example": ["127.0.0.1"],
    "lan.contact.example": ["192.168.1.10"],
    "mixed.contact.example": ["8.8.8.8", "::1"],
    "public.contact.example": ["8.8.8.8", "2001:4860:4860::8888"],
  }));
  for (const relay of ["https://relay.contact.example:5881/", "https://lan.contact.example/", "https://relay.contact.example./",
    "https://mixed.contact.example/", "https://nowhere.contact.example/", "https://127.0.0.1/", "https://[::1]/", "not a relay"])
    expect(await publicRelay(relay), relay).toBe(false);
  for (const relay of ["https://public.contact.example/", "https://8.8.8.8/", "https://[2001:4860:4860::8888]/"])
    expect(await publicRelay(relay), relay).toBe(true);
});
