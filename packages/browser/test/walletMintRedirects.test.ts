import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveKeysetId } from "@cashu/cashu-ts";
import { CashuWallet } from "../src/engine/wallet";
import { fakeInvoice } from "../src/engine/paymentAdapters/providers/testing";
import { resetDb, seed } from "./fakes";

vi.mock("../src/shared/idb", async () => (await import("./fakes")).idbModule);

const KEYS = { 1: `02${"ab".repeat(32)}`, 2: `03${"cd".repeat(32)}` };
const KEYSET = deriveKeysetId(KEYS);
const answer = (body: object) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const wallet = (mint: string) =>
  new CashuWallet(() => [mint], { onChange: vi.fn(), onTestMintNeeded: vi.fn(async () => {}), onQuotePaid: vi.fn(), onMeltResolved: vi.fn() }, () => [mint]);

beforeEach(() => resetDb());
afterEach(() => { vi.unstubAllGlobals(); });

// The mint address check is the only say on where the wallet's requests go: a mint's redirect never takes them elsewhere.
describe("a mint's redirects", () => {
  it("are refused on every request to the mint, the questions without a body included", async () => {
    const MINT = "https://mint.example";
    seed("proofs", [{ mint: MINT, id: KEYSET, amount: 128, secret: "a", C: KEYS[1] }]);
    const asked: { method: string; path: string; redirect?: RequestRedirect }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      asked.push({ method: init?.method ?? "GET", path, redirect: init?.redirect });
      const method = { method: "bolt11", unit: "sat", min_amount: 1, max_amount: 1_000_000 };
      if (path === "/v1/info") return answer({ name: "Test", nuts: { 4: { methods: [method], disabled: false }, 5: { methods: [method], disabled: false } } });
      if (path === "/v1/keysets") return answer({ keysets: [{ id: KEYSET, unit: "sat", active: true, input_fee_ppk: 0 }] });
      if (path === "/v1/keys" || path === `/v1/keys/${KEYSET}`) return answer({ keysets: [{ id: KEYSET, unit: "sat", keys: KEYS }] });
      if (path === "/v1/mint/quote/bolt11/q0") return answer({ quote: "q0", request: fakeInvoice(10, new Uint8Array(32).fill(1)), amount: 10, unit: "sat", state: "UNPAID", expiry: 4_000_000_000 });
      if (path === "/v1/melt/quote/bolt11/m0") return answer({ quote: "m0", request: fakeInvoice(10, new Uint8Array(32).fill(2)), amount: 10, unit: "sat", fee_reserve: 1, state: "UNPAID", expiry: 4_000_000_000 });
      if (path === "/v1/melt/quote/bolt11") return answer({ quote: "m1", request: fakeInvoice(10, new Uint8Array(32).fill(3)), amount: 10, unit: "sat", fee_reserve: 1, state: "UNPAID", expiry: 4_000_000_000 });
      return new Response("not found", { status: 404 });
    }));

    const cashu = wallet(MINT);
    await cashu.checkMint(MINT);
    await cashu.mintQuoteState(MINT, "q0");
    await cashu.meltQuoteState(MINT, "m0");
    await cashu.quoteInvoice(fakeInvoice(10, new Uint8Array(32).fill(3)), MINT);

    const paths = asked.map((a) => `${a.method} ${a.path}`);
    for (const path of ["GET /v1/info", "GET /v1/keysets", "GET /v1/mint/quote/bolt11/q0", "GET /v1/melt/quote/bolt11/m0", "POST /v1/melt/quote/bolt11"]) expect(paths).toContain(path);
    expect(paths.some((p) => p.startsWith("GET /v1/keys"))).toBe(true);
    expect(asked.filter((a) => a.redirect !== "error")).toEqual([]);
  });

  describe("over the network", () => {
    const servers: Server[] = [];
    const listen = async (handle: (request: IncomingMessage, respond: (status: number, headers: Record<string, string>) => void) => void) => {
      const server = createServer((request, response) => handle(request, (status, headers) => { response.writeHead(status, headers); response.end(); }));
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };
    afterEach(async () => {
      await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
    });

    it("never reach the other address, and the mint is not added", async () => {
      const elsewhere: string[] = [];
      const other = await listen((request, respond) => { elsewhere.push(String(request.url)); respond(404, {}); });
      const mint = await listen((request, respond) => respond(302, { location: `${other}/private${request.url}` }));

      await expect(wallet(mint).checkMint(mint)).rejects.toMatchObject({ engineCode: "mintUnreachable" });
      expect(elsewhere).toEqual([]);
    });
  });
});
