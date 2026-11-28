import { createPrivateKey } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import { createServer, type AddressInfo, type LookupFunction, type Socket } from "node:net";
import { expect, it, vi } from "vitest";
import { createIdentity, toBase64Url } from "@ghostly/core";
import { fetchGroupCallOccupancy, fetchGroupCallToken, sendGroupCallModeration } from "@ghostly/browser/engine/groupCall";
import { nodeGroupCallFetch } from "../src/runtime/groupCallFetch";
import { publicOnly } from "../src/runtime/pushSend";
import { pem, testCertificate } from "../../core/test/support/x509";

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

it("a node's answer a Response cannot carry (205 with a body, a status of 600, a 101) is said at once, not thrown out of the request", async () => {
  const leaf = testCertificate({ subject: "call.example", dns: ["call.example"] });
  const key = createPrivateKey({ key: { kty: "EC", crv: "P-256", d: toBase64Url(leaf.secret), x: toBase64Url(leaf.publicKey.slice(1, 33)), y: toBase64Url(leaf.publicKey.slice(33)) }, format: "jwk" });
  let status = 205;
  const node = createHttpsServer({ cert: pem(leaf), key: key.export({ type: "pkcs8", format: "pem" }) }, (request, response) => {
    request.resume();
    // A 101 is written by hand: Node's own response would not send one to a request that asked for no upgrade.
    if (status === 101) request.socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: x\r\n\r\n");
    else response.writeHead(status).end('{"count":1}');
  });
  await new Promise<void>(resolve => node.listen(0, "127.0.0.1", resolve));
  // The test's own certificate, at a name this lookup alone knows.
  vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
  const thrown: unknown[] = [];
  const caught = (error: unknown) => { thrown.push(error); };
  process.on("uncaughtException", caught);
  try {
    const fetch = nodeGroupCallFetch(((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) =>
      options.all ? callback(null, [{ address: "127.0.0.1", family: 4 }]) : callback(null, "127.0.0.1", 4)) as unknown as LookupFunction);
    const me = createIdentity(), sfu = `https://call.example:${(node.address() as AddressInfo).port}`, g = "oKGio6SlpqeoqaqrrK2urw";
    const started = Date.now();
    await expect(fetchGroupCallOccupancy({ sfu, g, seed: me.seed, fetch })).resolves.toEqual({ ok: false, code: "bad_reply" });
    status = 600;
    await expect(fetchGroupCallOccupancy({ sfu, g, seed: me.seed, fetch })).resolves.toEqual({ ok: false, code: "no_answer" });
    status = 101;
    await expect(fetchGroupCallOccupancy({ sfu, g, seed: me.seed, fetch })).resolves.toEqual({ ok: false, code: "no_answer" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(thrown).toEqual([]);
  } finally {
    process.off("uncaughtException", caught);
    vi.unstubAllEnvs();
    node.closeAllConnections();
    await new Promise(resolve => node.close(resolve));
  }
}, 30_000);

it("sends only a POST over HTTPS", async () => {
  const post = nodeGroupCallFetch(answers({}));
  await expect(post("http://8.8.8.8/sfu/group-token", { method: "POST", body: "{}" })).rejects.toThrow(/HTTPS/);
  await expect(post("https://8.8.8.8/sfu/group-token")).rejects.toThrow(/POST/);
});
