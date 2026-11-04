import { describe, expect, it } from "vitest";
import { bech32 } from "@scure/base";
import { fakeInvoice } from "@ghostly/browser/engine/paymentAdapters/providers/testing";
import { routeSend } from "../../lib/sendRoute";
import { REGTEST_INVOICE } from "../payments/fixtures";

// covers: wallet.cashu.pay-invoice, wallet.cashu.send-scan

/** An invoice that lets the payer choose the amount: the fake regtest one with no amount in its prefix. */
const anyAmount = () => {
  const { words } = bech32.decode(fakeInvoice(1, new Uint8Array(32).fill(7)) as `${string}1${string}`, false);
  return bech32.encode("lnbcrt", words, false);
};

describe("Send sorts what it was given", () => {
  it("an invoice, as typed, scanned in upper case or behind lightning:", () => {
    for (const text of [REGTEST_INVOICE, REGTEST_INVOICE.toUpperCase(), `lightning:${REGTEST_INVOICE}`, `LIGHTNING:${REGTEST_INVOICE.toUpperCase()}`, `  ${REGTEST_INVOICE}\n`]) {
      const route = routeSend(text);
      expect(route.kind).toBe("invoice");
      if (route.kind === "invoice") {
        expect(route.text).toBe(REGTEST_INVOICE);
        expect(route.invoice.amountSat).toBe(250_000);
      }
    }
  });

  it("a BIP 21 link pays by its lightning= leg, and without one it is not this card's", () => {
    const route = routeSend(`bitcoin:bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080?amount=0.0025&lightning=${REGTEST_INVOICE}`);
    expect(route).toMatchObject({ kind: "invoice", text: REGTEST_INVOICE });
    expect(routeSend(`BITCOIN:?LIGHTNING=${REGTEST_INVOICE.toUpperCase()}`)).toMatchObject({ kind: "invoice", text: REGTEST_INVOICE });
    expect(routeSend("bitcoin:bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080?amount=0.001").kind).toBe("unknown");
    expect(routeSend("bitcoin:bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080?lightning=nonsense").kind).toBe("unknown");
  });

  it("a BIP 21 link's lightning= leg only as the chat reads the same link: the same payment, and a link that may be paid", () => {
    const address = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";
    // The fallback asks 25 times the link's amount: not the same payment, so it is not paid from here.
    expect(routeSend(`bitcoin:${address}?amount=0.0001&lightning=${REGTEST_INVOICE}`).kind).toBe("unknown");
    // A req- parameter this app does not understand (BIP 21), or an amount it cannot read: the link is not paid at all.
    expect(routeSend(`bitcoin:${address}?amount=0.0025&req-pop=x&lightning=${REGTEST_INVOICE}`).kind).toBe("refused");
    expect(routeSend(`bitcoin:?req-pop=x&lightning=${REGTEST_INVOICE}`).kind).toBe("refused");
    expect(routeSend(`bitcoin:?amount=abc&lightning=${REGTEST_INVOICE}`).kind).toBe("refused");
    // A link with no address whose invoice asks another amount than the link: not the same payment.
    expect(routeSend(`bitcoin:?amount=0.00001&lightning=${REGTEST_INVOICE}`).kind).toBe("refused");
    expect(routeSend(`bitcoin:?amount=0.0025&lightning=${REGTEST_INVOICE}`).kind).toBe("invoice");
    // A req- parameter it does understand is no reason to refuse.
    expect(routeSend(`bitcoin:${address}?amount=0.0025&req-lightning=${REGTEST_INVOICE}&lightning=${REGTEST_INVOICE}`).kind).toBe("invoice");
  });

  it("an invoice with no amount is told apart", () => {
    const route = routeSend(anyAmount());
    expect(route.kind).toBe("no-amount");
  });

  it("a Lightning address and an LNURL-pay", () => {
    expect(routeSend("Satoshi@Example.com")).toEqual({ kind: "destination", text: "satoshi@example.com" });
    expect(routeSend("lightning:satoshi@example.com")).toEqual({ kind: "destination", text: "satoshi@example.com" });
    const lnurl = bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode("https://example.com/lnurlp/satoshi")), 2000);
    expect(routeSend(lnurl.toUpperCase())).toEqual({ kind: "destination", text: lnurl });
    expect(routeSend("lnurlp://example.com/pay")).toEqual({ kind: "destination", text: "lnurlp://example.com/pay" });
  });

  it("an LNURL that must not be asked says why", () => {
    const lnurl = bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode("http://example.com/pay")), 2000);
    const route = routeSend(lnurl);
    expect(route.kind).toBe("bad-destination");
    if (route.kind === "bad-destination") expect(String(route.error)).toMatch(/HTTPS/);
  });

  it("an ecash token, nothing, and anything else", () => {
    expect(routeSend("cashuBo2F0gaJhaUgA")).toEqual({ kind: "token", text: "cashuBo2F0gaJhaUgA" });
    expect(routeSend("   ").kind).toBe("empty");
    expect(routeSend("hello there").kind).toBe("unknown");
    expect(routeSend("lnbc-this-is-not-an-invoice").kind).toBe("unknown");
    expect(routeSend("https://example.com").kind).toBe("unknown");
  });

  it("a token behind the cashu: URI scheme (cashu:, cashu://, web+cashu://) is the token, given on bare", () => {
    for (const scheme of ["cashu:", "cashu://", "web+cashu://"]) {
      expect(routeSend(` ${scheme}cashuBo2F0gaJhaUgA\n`)).toEqual({ kind: "token", text: "cashuBo2F0gaJhaUgA" });
    }
    expect(routeSend("cashu:").kind).toBe("unknown");
    expect(routeSend("cashu:hello").kind).toBe("unknown");
  });
});
