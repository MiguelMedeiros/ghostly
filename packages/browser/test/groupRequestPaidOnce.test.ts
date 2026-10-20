import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Amount, getEncodedToken, type Proof } from "@cashu/cashu-ts";
import { ENDPOINT, type GhostLink } from "@ghostly/core";
import { CashuWallet } from "../src/engine/wallet";
import { PaymentDesk } from "../src/engine/payments";
import { TEST_MINT } from "../src/shared/mints";
import { mint, resetDb, rows } from "./fakes";
// covers: groups.payments.group-request

/**
 * A request of ours to a group, paid in ecash by member A while the mint does not answer A's redeem. Member B, whose
 * screen still shows it open, pays it too: refused before anything is redeemed, since A's redeem is still written
 * down. Once the mint answers, A's redeem settles the request, and the group was asked for its amount once.
 */
vi.mock("../src/shared/idb", async () => (await import("./fakes")).idbModule);
vi.mock("@cashu/cashu-ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Wallet: (await import("./fakes")).FakeWallet,
}));

const KEYSET = "009a1f293253e41e";
const C = `02${"ab".repeat(32)}`;
const proof = (secret: string, amount: number) => ({ id: KEYSET, amount: Amount.from(amount), secret, C }) as Proof;
const tokenOf = (proofs: Proof[]) => getEncodedToken({ mint: TEST_MINT, unit: "sat", proofs });

const tokenA = tokenOf([proof("member-a-coin", 1000)]);
const tokenB = tokenOf([proof("member-b-coin", 1000)]);
let mintDown = true;

function scriptMint() {
  mint.receive.mockImplementation(async (token: string) => {
    // A's redeem reaches a mint that does not answer: no word either way.
    if (token === tokenA && mintDown) throw new Error("Failed to fetch");
    return [proof(token === tokenA ? "ours-from-a" : "ours-from-b", 1000)];
  });
  mint.checkProofsStates.mockImplementation(async (proofs: { secret: string }[]) => {
    if (mintDown) throw new Error("Failed to fetch");
    return proofs.map(() => ({ state: "UNSPENT" }));
  });
  mint.restore.mockImplementation(async () => { if (mintDown) throw new Error("Failed to fetch"); return undefined; });
}

function world() {
  const events = { onChange: vi.fn(), onTestMintNeeded: vi.fn(), onQuotePaid: vi.fn(), onMeltResolved: vi.fn(), onSwapSettled: (swap: never, done: boolean) => desk.onSwapSettled(swap, done) };
  const wallet = new CashuWallet(() => [TEST_MINT], events, () => [TEST_MINT]);
  const results: Record<string, { id: string; ok: boolean; error?: string; credited?: string }[]> = { "edge-a": [], "edge-b": [] };
  const linkFor = (linkId: string) => ({ isDataLinkOpen: true, supportsPayments: true, allowsPayment: () => true, paymentEnabled: () => true, requirePaymentSupport: async () => {},
    sendPaymentResult: (r: never) => results[linkId]?.push(r), sendPayment: async () => {}, sendPaymentRequest: async () => {}, sendPaymentAsk: async () => {} });
  const host = {
    getLink: (linkId: string) => linkFor(linkId) as unknown as GhostLink,
    storeMessage: vi.fn(async () => {}),
    onChange: vi.fn(),
    groupOf: (linkId: string) => (linkId === "edge-a" || linkId === "edge-b" ? "g1" : undefined),
    groupLinks: () => ["edge-a", "edge-b"],
  };
  const desk: PaymentDesk = new PaymentDesk(wallet, host as never);
  return { wallet, desk, results };
}

beforeEach(() => {
  resetDb(); vi.clearAllMocks(); vi.spyOn(console, "warn").mockImplementation(() => {});
  mintDown = true; scriptMint();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => { vi.useRealTimers(); });

describe("a request of ours to a group, paid in ecash", () => {
  it("is paid once: a second member's ecash while the first one's redeem has no answer is refused unredeemed", async () => {
    const { desk, results, wallet } = world();
    const { paymentId } = await desk.requestFromGroup({ groupId: "g1", amount: 1000, timestamp: 1_000, rail: "cashu", network: "testnet" });
    await desk.onPayment("edge-a", { id: "pay-from-a-0001", timestamp: 2_000, requestId: paymentId, amount: { value: "1000", asset: "sat" }, endpoint: [ENDPOINT.cashu, tokenA] });
    expect(results["edge-a"]).toEqual([]);

    mintDown = false;
    await desk.onPayment("edge-b", { id: "pay-from-b-0001", timestamp: 3_000, requestId: paymentId, amount: { value: "1000", asset: "sat" }, endpoint: [ENDPOINT.cashu, tokenB] });
    expect(results["edge-b"]).toEqual([{ id: "pay-from-b-0001", ok: false, error: "Another member of the group is paying it" }]);
    expect(mint.receive).not.toHaveBeenCalledWith(tokenB, expect.anything());

    // The wallet's own poll then settles A's redeem: that one pays the request.
    await vi.advanceTimersByTimeAsync(31_000);
    await vi.advanceTimersByTimeAsync(31_000);
    expect((await wallet.view("testnet")).balance).toBe(1000);
    const credited = rows<{ id: string; direction: string; kind: string }>("payments").filter((p) => p.direction === "in" && p.kind === "payment").map((p) => p.id);
    expect(credited).toEqual(["pay-from-a-0001"]);
    expect(results["edge-a"]).toContainEqual({ id: "pay-from-a-0001", ok: true, credited: "1000" });
    expect(rows<{ id: string; state: string }>("payments").find((p) => p.id === paymentId)?.state).toBe("settled");

    // Paid now: B's token sent again is refused as paid, still unredeemed.
    await desk.onPayment("edge-b", { id: "pay-from-b-0002", timestamp: 4_000, requestId: paymentId, amount: { value: "1000", asset: "sat" }, endpoint: [ENDPOINT.cashu, tokenB] });
    expect(results["edge-b"].at(-1)).toEqual({ id: "pay-from-b-0002", ok: false, error: "Already paid by another member of the group" });
    expect((await wallet.view("testnet")).balance).toBe(1000);
  });

  it("opens again once the first member's redeem is past its watch hour with no way of knowing (spent, no NUT-09)", async () => {
    const { desk, results, wallet } = world();
    // A mint that cannot say what it signed (no NUT-09), and that took A's coins while its answer was lost.
    (await wallet["wallet"](TEST_MINT) as unknown as { getMintInfo: () => unknown }).getMintInfo = () => ({ isSupported: () => ({ supported: false, params: [] }) });
    mint.checkProofsStates.mockImplementation(async (proofs: { secret: string }[]) => proofs.map((p) => ({ state: p.secret === "member-a-coin" ? "SPENT" : "UNSPENT" })));
    const { paymentId } = await desk.requestFromGroup({ groupId: "g1", amount: 1000, timestamp: 1_000, rail: "cashu", network: "testnet" });
    await desk.onPayment("edge-a", { id: "pay-from-a-0001", timestamp: 2_000, requestId: paymentId, amount: { value: "1000", asset: "sat" }, endpoint: [ENDPOINT.cashu, tokenA] });
    expect(results["edge-a"]).toEqual([]);

    // Within its hour the mint may still be finishing it: B is refused, unredeemed.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await desk.onPayment("edge-b", { id: "pay-from-b-0001", timestamp: 3_000, requestId: paymentId, amount: { value: "1000", asset: "sat" }, endpoint: [ENDPOINT.cashu, tokenB] });
    expect(results["edge-b"]).toEqual([{ id: "pay-from-b-0001", ok: false, error: "Another member of the group is paying it" }]);

    // A day on, A's redeem is still written down (the wallet keeps asking, less and less often), and the request open:
    // B's payment is taken.
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(rows<{ id: string; state: string }>("payments").find((p) => p.id === paymentId)?.state).toBe("pending");
    await desk.onPayment("edge-b", { id: "pay-from-b-0002", timestamp: 4_000, requestId: paymentId, amount: { value: "1000", asset: "sat" }, endpoint: [ENDPOINT.cashu, tokenB] });
    expect(results["edge-b"].at(-1)).toEqual({ id: "pay-from-b-0002", ok: true, credited: "1000" });
    expect((await wallet.view("testnet")).balance).toBe(1000);
    expect(rows<{ id: string; state: string }>("payments").find((p) => p.id === paymentId)?.state).toBe("settled");
  });
});
