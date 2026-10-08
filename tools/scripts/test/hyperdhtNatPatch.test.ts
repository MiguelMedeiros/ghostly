import { createRequire } from "node:module";
import { expect, it } from "vitest";
// covers: transport.hyperdht

/**
 * Our patch to hyperdht's lib/nat.js (tools/patches/hyperdht+6.34.0.patch, holepunchto/hyperdht#308), checked on the
 * installed copy with upstream's own test. Without it a fresh process's first dial could open and carry nothing for
 * ~13 s (docs/wisps/103-hyperdht.md). A dependency bump that drops the patch fails here. Remove this test with the
 * patch when Holepunch releases the fix (hyperdht > 6.34.1 containing #308).
 */
const require = createRequire(import.meta.url);
const Nat = require("hyperdht/lib/nat.js");
const { FIREWALL } = require("hyperdht/lib/constants.js");

it("an open NAT advertises its sampled addresses (tools/patches/hyperdht, upstream #308; remove with the patch)", () => {
  const nat = new Nat({ firewalled: false }, null, null);
  expect(nat.firewall).toBe(FIREWALL.OPEN);
  expect(nat.addresses).toBeNull();
  nat.add({ host: "127.0.0.1", port: 8080 }, { host: "127.0.0.1", port: 8080 });
  expect(nat.sampled).toBe(1);
  expect(nat.firewall).toBe(FIREWALL.OPEN);
  expect(nat.addresses).toEqual([{ host: "127.0.0.1", port: 8080, hits: 1 }]);
});
