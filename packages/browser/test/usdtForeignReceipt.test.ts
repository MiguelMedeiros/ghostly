// Every USDT request carries the wallet's one address. A contact who paid nothing can name another payer's transfer
// to it (public on chain): it pays only the request whose amount it carries. Real PaymentDesk + real UsdtAdapter; the
// chain is a fake JSON-RPC behind fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENDPOINT, type GhostLink } from "@ghostly/core";
import { Interface, keccak256 } from "ethers";
import { PaymentDesk } from "../src/engine/payments";
import { UsdtAdapter, type UsdtConfig } from "../src/engine/paymentAdapters/usdt";
import type { CashuWallet } from "../src/engine/wallet";
import { resetDb } from "./fakes";
// covers: payments.usdt.send
vi.mock("../src/shared/idb", async () => (await import("./fakes")).idbModule);

const RPC = "http://127.0.0.1:4601";
const TOKEN = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const CAROL = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const CODE = "0x6080604052";
const AMOUNT = 10_000_000; // 10 TEST-USDT at 6 decimals
const CAROL_TX = "0x" + "c".repeat(64);
const erc20 = new Interface(["function transfer(address,uint256) returns(bool)", "event Transfer(address indexed from,address indexed to,uint256 value)"]);
const hex = (n: number | bigint) => "0x" + BigInt(n).toString(16);

/** A local chain at height 100 holding one transfer, Carol → Alice of `paid.amount`, mined at 90. */
function chain(paid: { amount: number }) {
  const mined = Math.floor(Date.now() / 1000) + 60;
  const answer = (method: string, params: unknown[]): unknown => {
    const log = erc20.encodeEventLog("Transfer", [CAROL, ALICE, paid.amount]);
    switch (method) {
      case "eth_chainId": return hex(31337);
      case "eth_getCode": return CODE;
      case "eth_blockNumber": return hex(100);
      case "eth_getTransactionByHash": return params[0] === CAROL_TX ? { from: CAROL, to: TOKEN, value: "0x0", nonce: "0x1", input: erc20.encodeFunctionData("transfer", [ALICE, paid.amount]) } : null;
      case "eth_getTransactionReceipt": return params[0] === CAROL_TX ? { status: "0x1", blockNumber: hex(90), blockHash: "0x" + "b".repeat(64), logs: [{ address: TOKEN, topics: log.topics, data: log.data }] } : null;
      case "eth_getBlockByNumber": return { hash: "0x" + "b".repeat(64), timestamp: hex(mined) };
      default: throw new Error(`unexpected ${method}`);
    }
  };
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    const { id, method, params } = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: answer(method, params) }), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}

function link() {
  return {
    isDataLinkOpen: true, supportsPayments: true, supportsUsdtPayments: true,
    requirePaymentSupport: vi.fn(async () => {}), allowsPayment: vi.fn(() => true), paymentEnabled: vi.fn(() => true),
    sendPaymentRequest: vi.fn(async (_request: { amount: { value: string } }) => {}), sendPaymentAsk: vi.fn(async () => {}), sendPayment: vi.fn(async () => {}), sendPaymentResult: vi.fn(),
  };
}

function alice() {
  const config: UsdtConfig = { network: "evm-local", provider: RPC, chainId: 31337, token: TOKEN, decimals: 6, codeHash: keccak256(CODE) };
  const adapter = new (UsdtAdapter as unknown as new (c: UsdtConfig) => UsdtAdapter)(config);
  const now = Date.now();
  const usdtWallet = { configured: true, adapter, target: async () => ({ method: "usdt" as const, network: "evm-local" as const, provider: RPC, asset: "TEST-USDT" as const, unit: "token-base" as const, address: ALICE, chainId: 31337, token: TOKEN, decimals: 6, issuedAt: now, expiresAt: now + 15 * 60_000 }) };
  const links: Record<string, ReturnType<typeof link>> = { bob: link(), carol: link(), dave: link() };
  const host = { getLink: (id: string) => links[id] as unknown as GhostLink, storeMessage: vi.fn(async (_m: { linkId: string; text: string }) => {}), onChange: vi.fn() };
  const desk = new PaymentDesk({ view: vi.fn(async () => ({ mints: [] })) } as unknown as CashuWallet, host, undefined, usdtWallet as never);
  const asked = (id: string) => Number(links[id].sendPaymentRequest.mock.calls[0][0].amount.value);
  const receipt = (linkId: string, id: string, requestId: string, timestamp: number) => desk.onPayment(linkId, { id, timestamp, requestId, amount: { value: String(asked(linkId)), asset: "testusdt" }, endpoint: [ENDPOINT.usdt, JSON.stringify({ txid: CAROL_TX })] });
  const said = (linkId: string) => host.storeMessage.mock.calls.map((c) => c[0]).filter((m) => m.linkId === linkId).map((m) => m.text);
  return { desk, now, asked, receipt, said };
}

beforeEach(() => resetDb());
afterEach(() => vi.unstubAllGlobals());

describe("a USDT receipt naming another payer's transfer to the wallet's one address", () => {
  it("each request asks for its own amount; a transfer pays only the request whose amount it carries", async () => {
    const paid = { amount: 0 };
    chain(paid);
    const { desk, now, asked, receipt } = alice();
    const toBob = await desk.request({ linkId: "bob", amount: AMOUNT, method: "usdt", timestamp: now, network: "testnet" });
    const toCarol = await desk.request({ linkId: "carol", amount: AMOUNT, method: "usdt", timestamp: now + 1, network: "testnet" });
    expect(asked("bob"), "a request asks a little more than typed, under a thousandth").toBeGreaterThan(AMOUNT);
    expect(asked("bob")).toBeLessThan(AMOUNT + 1000);
    expect(asked("carol")).not.toBe(asked("bob"));
    expect(desk.payment(toCarol.paymentId)?.amount, "what is stored is what was asked").toBe(asked("carol"));
    paid.amount = asked("carol"); // Carol pays the amount her request asked for

    // Bob paid nothing: he names Carol's transaction before Carol's own receipt arrives.
    await receipt("bob", "bob-receipt", toBob.paymentId, now + 5);
    await receipt("carol", "carol-receipt", toCarol.paymentId, now + 6);

    expect(desk.payment(toBob.paymentId)?.state).toBe("pending");
    expect(desk.payment("bob-receipt")?.state).not.toBe("settled");
    expect(desk.payment(toCarol.paymentId)?.state).toBe("settled");
    expect(desk.payment("carol-receipt")?.state).toBe("settled");
  });

  it("a receipt for a transaction that already paid another request is said in its chat, never settles it", async () => {
    const paid = { amount: 0 };
    chain(paid);
    const { desk, now, asked, receipt, said } = alice();
    const toCarol = await desk.request({ linkId: "carol", amount: AMOUNT, method: "usdt", timestamp: now, network: "testnet" });
    paid.amount = asked("carol");
    await receipt("carol", "carol-receipt", toCarol.paymentId, now + 5);
    expect(desk.payment(toCarol.paymentId)?.state).toBe("settled");

    // An older request of the same amount (made before requests asked for their own): Dave names Carol's transfer.
    const toDave = await desk.request({ linkId: "dave", amount: AMOUNT, method: "usdt", timestamp: now + 1, network: "testnet" });
    await desk["save"]({ ...desk.payment(toDave.paymentId)!, amount: asked("carol") });
    await desk.onPayment("dave", { id: "dave-receipt", timestamp: now + 6, requestId: toDave.paymentId, amount: { value: String(asked("carol")), asset: "testusdt" }, endpoint: [ENDPOINT.usdt, JSON.stringify({ txid: CAROL_TX })] });
    expect(desk.payment(toDave.paymentId)?.state).toBe("pending");
    expect(desk.payment("dave-receipt")).toMatchObject({ state: "failed", error: "This transaction already paid another request" });
    expect(said("dave").at(-1)).toMatch(/already paid another request/);
  });
});
