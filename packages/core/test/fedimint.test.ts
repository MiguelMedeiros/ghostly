import { describe, expect, it } from "vitest";
import { ENDPOINT, decodeControl, encodeControl, fedimintRequestPayload, isFederationId, parseFedimintRequestPayload, validatePaymentTarget, type PaymentTarget } from "../src";
// covers: payments.fedimint.chat, payments.targets, payments.chat.frames

const id = "8d84dfa9ca6fc93f5ebcede2c9c258899a4f1715b5599ffd1f069065fab272fc";
const target = (over: Partial<PaymentTarget> = {}): PaymentTarget => ({ method: "fedimint", network: "regtest", provider: id, asset: "BTC", unit: "sat", address: "request-id", expiresAt: Date.now() + 60_000, ...over });

describe("Fedimint in the payment protocol", () => {
  it("a target names a federation by its id, on a Bitcoin network, in sats", () => {
    expect(validatePaymentTarget(target())).toMatchObject({ method: "fedimint", provider: id, network: "regtest" });
    for (const network of ["bitcoin", "signet", "testnet", "mutinynet"] as const) expect(validatePaymentTarget(target({ network })).network).toBe(network);
    expect(() => validatePaymentTarget(target({ provider: "https://fed.example" })), "a URL is not a federation").toThrow("federation id");
    expect(() => validatePaymentTarget(target({ provider: id.toUpperCase() }))).toThrow("federation id");
    expect(() => validatePaymentTarget(target({ network: "cashu-test" }))).toThrow("Unsupported");
    expect(() => validatePaymentTarget(target({ asset: "USDT" }))).toThrow("Unsupported");
    expect(() => validatePaymentTarget(target({ expiresAt: Date.now() - 1 }))).toThrow("expired");
    expect(() => validatePaymentTarget(target({ address: "" }))).toThrow("destination");
  });

  it("a request names the federations the payee takes ecash of; anything else is dropped", () => {
    expect(ENDPOINT.fedimint).toBe("fedimint-ecash/1");
    expect(parseFedimintRequestPayload(fedimintRequestPayload([id]))).toEqual([id]);
    expect(parseFedimintRequestPayload(JSON.stringify({ federations: [id, id, "nope", 7, id.slice(1)] }))).toEqual([id]);
    expect(parseFedimintRequestPayload(JSON.stringify({ federations: Array.from({ length: 12 }, (_, i) => i.toString(16).padStart(64, "0")) }))).toHaveLength(8);
    expect(parseFedimintRequestPayload("not json")).toEqual([]);
    expect(parseFedimintRequestPayload(JSON.stringify({ federations: "x" }))).toEqual([]);
    expect(isFederationId(id)).toBe(true);
    expect(isFederationId(`${id}0`)).toBe(false);
  });

  it("an ask can be for Fedimint, and notes travel as a payment's payload", () => {
    const ask = { t: "pay-ask", id: "ask-00001", ts: 1, v: "500", u: "sat", m: "fedimint" } as const;
    expect(decodeControl(encodeControl(ask))).toEqual({ ...ask, memo: undefined });
    const notes = "A11".padEnd(3_000, "q");
    const pay = { t: "pay", id: "payment-1", ts: 1, v: "500", u: "sat", e: [ENDPOINT.fedimint, notes] } as const;
    expect(decodeControl(encodeControl(pay))).toMatchObject({ e: [ENDPOINT.fedimint, notes] });
  });
});
