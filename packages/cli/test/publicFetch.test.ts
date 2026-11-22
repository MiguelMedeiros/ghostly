import { createServer, type AddressInfo, type Socket } from "node:net";
import { expect, it, vi } from "vitest";
import { fetchLnurlJson } from "@ghostly/core";
import { boundedIdentityFetch } from "@ghostly/browser/proofs/verify";
import { nodeLnurlFetch, nodePublicFetch } from "../src/runtime/publicFetch";
import { publicOnly } from "../src/runtime/pushSend";

// covers: proofs.share, profiles.public, wallet.lnurl.protocol

/** A DNS that answers each name from a table: no lookup leaves this machine. */
const answers = (table: Record<string, string[]>) => publicOnly((host, _options, callback) =>
  table[host] ? callback(null, table[host].map(address => ({ address, family: address.includes(":") ? 6 : 4 }))) :
    callback(Object.assign(new Error(`${host} not found`), { code: "ENOTFOUND" }), []));

/** A TCP listener on this machine (a local service a contact would like reached), counting the connections it gets. */
async function listener() {
  const seen = { connections: 0 };
  const sockets = new Set<Socket>();
  const server = createServer(socket => { seen.connections++; sockets.add(socket); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, seen, close: () => new Promise(resolve => { for (const s of sockets) s.destroy(); server.close(resolve); }) };
}

it("reads an address a contact's identity names only at a name whose every address is public when it connects, or at a public address", async () => {
  const local = await listener();
  try {
    // The engine's own check (a public DoH resolver) was told a public address; the machine's resolver now says otherwise.
    const read = boundedIdentityFetch({ online: () => true, timeoutMs: 3_000, fetcher: nodePublicFetch(answers({
      "rebind.contact.example": ["127.0.0.1"],
      "lan.contact.example": ["192.168.1.10"],
      "mixed.contact.example": ["8.8.8.8", "127.0.0.1"],
    })) });
    for (const url of [`https://rebind.contact.example:${local.port}/.well-known/did.json`, `https://lan.contact.example:${local.port}/`,
      `https://mixed.contact.example:${local.port}/`, `https://127.0.0.1:${local.port}/`, `https://[::1]:${local.port}/`, `https://10.0.0.5:${local.port}/`])
      await expect(read(url), url).rejects.toThrow(/not a public address/);
    expect(local.seen.connections).toBe(0);
  } finally { await local.close(); }
});

it("asks a Lightning address's service, its redirects and its callback only at a name whose every address is public when it connects", async () => {
  const local = await listener();
  try {
    // The engine checks these names by what they say only: each passes, and resolves to this machine or its network.
    const lnurl = nodeLnurlFetch(answers({ "pay.example": ["127.0.0.1"], "lan.pay.example": ["192.168.1.10"], "mixed.pay.example": ["8.8.8.8", "10.0.0.5"] }));
    for (const url of [`https://pay.example:${local.port}/.well-known/lnurlp/alice`, `https://lan.pay.example:${local.port}/cb?amount=1000`,
      `https://mixed.pay.example:${local.port}/.well-known/lnurlp/alice`])
      await expect(fetchLnurlJson(url, { fetch: lnurl, timeoutMs: 3_000 }), url).rejects.toThrow();
    expect(local.seen.connections).toBe(0);
  } finally { await local.close(); }
});

it("asks a service the person named on this machine as named", async () => {
  const local = vi.fn(async () => Response.json({ tag: "payRequest" }));
  const lnurl = nodeLnurlFetch(answers({}), local);
  for (const url of ["http://127.0.0.1:4100/.well-known/lnurlp/alice", "http://localhost:4100/.well-known/lnurlp/alice", "http://[::1]:4100/x"])
    expect(await fetchLnurlJson(url, { fetch: lnurl }), url).toEqual({ tag: "payRequest" });
  expect(local).toHaveBeenCalledTimes(3);
});

it("sends only a GET over HTTPS", async () => {
  const get = nodePublicFetch(answers({}));
  await expect(get("http://8.8.8.8/")).rejects.toThrow(/HTTPS/);
  await expect(get("https://8.8.8.8/", { method: "POST" })).rejects.toThrow(/GET/);
});
