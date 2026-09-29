import { describe, expect, it } from "vitest";
import { paymentUri, qrText, satsToBtc } from "../src";
// covers: payments.uri, payments.external

const INVOICE = "lnbc210n1p4tgljxdqqpp5cy0xj543cj0zcj5r2zhdmpgztxsxlzf7c6yw898qnpuznly8ss6q";

describe("payment URIs for another wallet", () => {
  it("writes sats as the decimal bitcoin BIP 21 wants, never in exponent form", () => {
    expect(satsToBtc(21)).toBe("0.00000021");
    expect(satsToBtc(100_000_000)).toBe("1");
    expect(satsToBtc(150_000_000)).toBe("1.5");
    expect(satsToBtc(0)).toBe("0");
    expect(satsToBtc(1)).toBe("0.00000001");
    expect(() => satsToBtc(1.5)).toThrow(/whole number/);
    expect(() => satsToBtc(-1)).toThrow(/whole number/);
  });

  it("makes a lightning: link from an invoice, whatever its case or prefix", () => {
    expect(paymentUri({ kind: "lightning", invoice: INVOICE })).toBe(`lightning:${INVOICE}`);
    expect(paymentUri({ kind: "lightning", invoice: `LIGHTNING:${INVOICE.toUpperCase()}` })).toBe(`lightning:${INVOICE}`);
    expect(() => paymentUri({ kind: "lightning", invoice: "not an invoice" })).toThrow(/not a Lightning invoice/);
  });

  it("makes a BIP 21 link with the amount, and the invoice as the unified lightning parameter", () => {
    const address = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
    expect(paymentUri({ kind: "bitcoin", address })).toBe(`bitcoin:${address}`);
    expect(paymentUri({ kind: "bitcoin", address, amountSat: 21 })).toBe(`bitcoin:${address}?amount=0.00000021`);
    expect(paymentUri({ kind: "bitcoin", address, amountSat: 21, lightning: `lightning:${INVOICE}` })).toBe(`bitcoin:${address}?amount=0.00000021&lightning=${INVOICE}`);
    expect(paymentUri({ kind: "bitcoin", address, label: "Ghostly request", message: "a & b" })).toBe(`bitcoin:${address}?label=Ghostly%20request&message=a%20%26%20b`);
    expect(() => paymentUri({ kind: "bitcoin", address: "bc1q?evil=1" })).toThrow(/not a Bitcoin address/);
  });

  it("makes the BIP 21 form Ark wallets read for an Ark address", () => {
    expect(paymentUri({ kind: "ark", address: "tark1qq", amountSat: 500 })).toBe("bitcoin:?ark=tark1qq&amount=0.000005");
    expect(paymentUri({ kind: "ark", address: "ark1qq" })).toBe("bitcoin:?ark=ark1qq");
    expect(() => paymentUri({ kind: "ark", address: "ark1qq&x=y" })).toThrow(/not an Ark address/);
  });

  it("upper-cases a lightning: URI for the QR code and leaves a BIP 21 one alone", () => {
    expect(qrText(`lightning:${INVOICE}`)).toBe(`LIGHTNING:${INVOICE.toUpperCase()}`);
    const bip21 = "bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq?amount=0.00000021";
    expect(qrText(bip21)).toBe(bip21);
  });
});
