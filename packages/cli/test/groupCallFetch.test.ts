import { createServer, type AddressInfo, type Socket } from "node:net";
import { expect, it } from "vitest";
import { createIdentity } from "@ghostly/core";
import { fetchGroupCallToken, sendGroupCallModeration } from "@ghostly/browser/engine/groupCall";
import { nodeGroupCallFetch } from "../src/runtime/groupCallFetch";
import { publicOnly } from "../src/runtime/pushSend";

// covers: groups.protocol.call-token

/** A DNS that answers each name from a table: no lookup leaves this machine. */
const answers = (table: Record<string, string[]>) => publicOnly((host, _options, callback) =>
  table[host] ? callback(null, table[host].map(address => ({ address, family: address.includes(":") ? 6 : 4 }))) :
    callback(Object.assign(new Error(`${host} not found`), { code: "ENOTFOUND" }), []));

/** A TCP listener on this machine (a local service a group's admin would like reached), counting the connections it gets. */
async function listener() {
  const seen = { connections: 0 };
  const sockets = new Set<Socket>();
  const server = createServer(socket => { seen.connections++; sockets.add(socket); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, seen, close: () => new Promise(resolve => { for (const s of sockets) s.destroy(); server.close(resolve); }) };
}

it("asks a group's call node only at a public address, or at a name whose every address is public when it connects", async () => {
  const local = await listener();
  const me = createIdentity(), g = "oKGio6SlpqeoqaqrrK2urw";
  try {
    const fetch = nodeGroupCallFetch(answers({
      "rebind.call.example": ["127.0.0.1"],
      "lan.call.example": ["192.168.1.10"],
      "mixed.call.example": ["8.8.8.8", "127.0.0.1"],
    }));
    const sfus = [`https://127.0.0.1:${local.port}`, `https://localhost:${local.port}`, `https://[::1]:${local.port}`, "https://10.0.0.1",
      "https://192.168.1.1", "https://169.254.169.254", `https://rebind.call.example:${local.port}`, `https://lan.call.example:${local.port}`,
      `https://mixed.call.example:${local.port}`];
    for (const sfu of sfus) {
      const host = new URL(sfu).host;
      await expect(fetchGroupCallToken({ sfu, g, k: me.pubKeyZ32, seed: me.seed, fetch, sleep: async () => {} }), sfu).rejects.toThrow(`Could not reach ${host}`);
      await expect(sendGroupCallModeration({ sfu, g, seed: me.seed, act: "state", fetch }), sfu).resolves.toEqual({ ok: false, code: "unreachable" });
    }
    expect(local.seen.connections).toBe(0);
  } finally { await local.close(); }
});

it("sends only a POST over HTTPS", async () => {
  const post = nodeGroupCallFetch(answers({}));
  await expect(post("http://8.8.8.8/sfu/group-token", { method: "POST", body: "{}" })).rejects.toThrow(/HTTPS/);
  await expect(post("https://8.8.8.8/sfu/group-token")).rejects.toThrow(/POST/);
});
