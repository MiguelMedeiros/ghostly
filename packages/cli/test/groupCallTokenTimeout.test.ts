import { createPrivateKey } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import { createServer, type AddressInfo, type LookupFunction, type Server, type Socket } from "node:net";
import { expect, it, vi } from "vitest";
import { createIdentity, toBase64Url } from "@ghostly/core";
import { GROUP_CALL_TIMEOUT_MS, fetchGroupCallToken } from "@ghostly/browser/engine/groupCall";
import { EXIT, asCliError } from "../src/errors";
import { nodeGroupCallFetch } from "../src/runtime/groupCallFetch";
import { pem, testCertificate } from "../../core/test/support/x509";

// covers: groups.protocol.call-token

/** A listener on this machine that keeps every connection it takes and never answers it. */
async function silent(server: Server) {
  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => { sockets.add(socket); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, sockets, close: () => new Promise(resolve => { for (const s of sockets) s.destroy(); server.close(resolve); }) };
}

// Node's `https.request` rejects a request its signal timed out with an AbortError whose cause is the TimeoutError (a
// browser's fetch with the TimeoutError itself). The engine read only the error's own name, so the CLI said a node
// that took the request and never answered as "Could not reach", `unavailable` (exit 1), like a node that is not there.
it("a call node that takes the request (or only the connection) and never answers did not answer in time: `timeout`, exit 4", async () => {
  const leaf = testCertificate({ subject: "call.example", dns: ["call.example"] });
  const key = createPrivateKey({ key: { kty: "EC", crv: "P-256", d: toBase64Url(leaf.secret), x: toBase64Url(leaf.publicKey.slice(1, 33)), y: toBase64Url(leaf.publicKey.slice(33)) }, format: "jwk" });
  const requests: string[] = [];
  // Past TLS, it reads the whole request, then says nothing.
  const quiet = await silent(createHttpsServer({ cert: pem(leaf), key: key.export({ type: "pkcs8", format: "pem" }) }, (request) => {
    request.on("data", () => {}).on("end", () => { requests.push(request.url ?? ""); });
  }));
  // It takes the connection and never starts TLS.
  const mute = await silent(createServer());
  // The test's own certificate, at a name this lookup alone knows.
  vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
  const lookup = ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) =>
    options.all ? callback(null, [{ address: "127.0.0.1", family: 4 }]) : callback(null, "127.0.0.1", 4)) as unknown as LookupFunction;
  const me = createIdentity(), g = "oKGio6SlpqeoqaqrrK2urw";
  try {
    const started = Date.now();
    const ask = (port: number) => fetchGroupCallToken({ sfu: `https://call.example:${port}`, g, k: me.pubKeyZ32, seed: me.seed, fetch: nodeGroupCallFetch(lookup), sleep: async () => {} }).catch((e: unknown) => e);
    const errors = await Promise.all([ask(quiet.port), ask(mute.port)]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(GROUP_CALL_TIMEOUT_MS - 50);
    expect(requests).toEqual(["/sfu/group-token"]);
    expect(mute.sockets.size).toBe(1);
    for (const [i, port] of [quiet.port, mute.port].entries()) {
      const late = `call.example:${port} did not answer in time`;
      expect(errors[i], late).toMatchObject({ engineCode: "hostTimedOut", message: late });
      // What `ghostly engine groupCallToken --json` prints, and the exit status it leaves with.
      const said = asCliError(errors[i]);
      expect(said.toJSON()).toEqual({ code: "timeout", message: late });
      expect(EXIT[said.code]).toBe(4);
    }
  } finally {
    vi.unstubAllEnvs();
    await Promise.all([quiet.close(), mute.close()]);
  }
}, GROUP_CALL_TIMEOUT_MS + 15_000);
