import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { paymentUri, qrText, satsToBtc } from "../src/paymentUri";

// covers: payments.uri, payments.external

const ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
/** BIP 21 query values, decoded the strict way: `+` is a plus sign, not a space. */
const query = (uri: string) => Object.fromEntries(uri.slice(uri.indexOf("?") + 1).split("&").map(p => p.split("=").map(decodeURIComponent)));

describe("BIP 21 amounts", () => {
  it("writes every whole-sat amount exactly, never in exponent form", () => {
    fc.assert(fc.property(fc.nat({ max: Number.MAX_SAFE_INTEGER }), sats => {
      const btc = satsToBtc(sats);
      expect(btc).toMatch(/^\d+(\.\d{1,8})?$/);
      const [whole, fraction = ""] = btc.split(".");
      expect(BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, "0"))).toBe(BigInt(sats));
    }), { numRuns: 300 });
    expect(satsToBtc(2_100_000_000_000_000)).toBe("21000000");
    expect(satsToBtc(Number.MAX_SAFE_INTEGER)).toBe("90071992.54740991");
  });

  it("refuses what is not a whole number of sats", () => {
    for (const sats of [Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity, -0.5]) expect(() => satsToBtc(sats), String(sats)).toThrow("Amount must be a whole number of sats");
  });

  it("leaves a zero amount out of the link", () => {
    expect(paymentUri({ kind: "bitcoin", address: ADDRESS, amountSat: 0 })).toBe(`bitcoin:${ADDRESS}`);
    expect(paymentUri({ kind: "ark", address: "ark1qq", amountSat: 0 })).toBe("bitcoin:?ark=ark1qq");
  });
});

describe("what a label or message can do to the link", () => {
  it("round-trips any text as one parameter, bounded to 140 characters, spaces as %20", () => {
    fc.assert(fc.property(fc.string({ maxLength: 200 }), fc.string({ maxLength: 200 }), (label, message) => {
      const uri = paymentUri({ kind: "bitcoin", address: ADDRESS, amountSat: 21, label, message });
      expect(uri.startsWith(`bitcoin:${ADDRESS}?amount=0.00000021`)).toBe(true);
      expect(uri).not.toMatch(/[ +#]/);
      const params = query(uri);
      expect(params.amount).toBe("0.00000021");
      if (label) expect(params.label).toBe(label.slice(0, 140)); else expect(params).not.toHaveProperty("label");
      if (message) expect(params.message).toBe(message.slice(0, 140)); else expect(params).not.toHaveProperty("message");
    }), { numRuns: 300 });
  });

  it("keeps a plus sign a plus sign", () => {
    expect(query(paymentUri({ kind: "bitcoin", address: ADDRESS, label: "1+1 = 2" })).label).toBe("1+1 = 2");
  });

  it("refuses addresses that could carry their own parameters", () => {
    for (const address of [`${ADDRESS}?amount=1`, `${ADDRESS}&label=x`, `${ADDRESS}#x`, "", `${ADDRESS} `])
      expect(() => paymentUri({ kind: "bitcoin", address }), address).toThrow("That is not a Bitcoin address");
    for (const address of ["", "ark1 qq", "ark1/qq"]) expect(() => paymentUri({ kind: "ark", address }), address).toThrow("That is not an Ark address");
    for (const invoice of ["", "lightning:", "lnbc1 2", "bitcoin:lnbc1", "lnbc1?x=1"]) expect(() => paymentUri({ kind: "lightning", invoice }), invoice).toThrow("That is not a Lightning invoice");
  });
});

describe("QR text", () => {
  it("upper-cases only what fits the alphanumeric mode, whatever the scheme", () => {
    expect(qrText("lightning:lnbc1abc")).toBe("LIGHTNING:LNBC1ABC");
    expect(qrText("bitcoin:bc1qxyz")).toBe("BITCOIN:BC1QXYZ");
    expect(qrText("bitcoin:bc1q?label=a%20b")).toBe("bitcoin:bc1q?label=a%20b");
    expect(qrText("bitcoin:bc1q?amount=1&x=y")).toBe("bitcoin:bc1q?amount=1&x=y");
    expect(qrText("")).toBe("");
  });
});
