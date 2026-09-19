import { describe, expect, it } from "vitest";
import { decodeBolt11, findBolt11 } from "../src";

// Issued by the public test mint (worthless sats): 2100 sats, no description.
const TEST_MINT_INVOICE =
  "lnbc21u1p42mkf2dqqpp56q3d9mfahf0974jqwy0yyfrg7zxksgxk7ufcc084yydhfx43daqqsp59g4z52329g4z52329g4z52329g4z52329g4z52329g4z52329g4q9qrsgqcqzyskhkhqar4dqgqfmarvdttr8x2nrp4txtamfupfftrnn4hmrp7s8ayen7hp2ye58jq8zu65rch9eplpxkhf3pf2nvuynhqxvkw5f7a2vgq486x8x";
// BOLT11's own example: "1 cup coffee" for 2500 micro-bitcoin, expiring in a minute.
const SPEC_INVOICE =
  "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh";

describe("bolt11", () => {
  it("reads the amount, the payment hash and the expiry of a real invoice", () => {
    const invoice = decodeBolt11(TEST_MINT_INVOICE);
    expect(invoice).not.toBeNull();
    expect(invoice!.network).toBe("bitcoin");
    expect(invoice!.amountSat).toBe(2100);
    expect(invoice!.amountMsat).toBe(2_100_000n);
    expect(invoice!.paymentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(invoice!.expiresAt).toBeGreaterThan(invoice!.createdAt);
    expect(invoice!.description).toBeUndefined();
  });

  it("reads the description and a custom expiry", () => {
    const invoice = decodeBolt11(SPEC_INVOICE);
    expect(invoice).not.toBeNull();
    expect(invoice!.amountSat).toBe(250_000);
    expect(invoice!.description).toBe("1 cup coffee");
    expect(invoice!.createdAt).toBe(1496314658);
    expect(invoice!.expiresAt - invoice!.createdAt).toBe(60);
    expect(invoice!.paymentHash).toBe("0001020304050607080900010203040506070809000102030405060708090102");
  });

  it("accepts upper case and the lightning: scheme", () => {
    expect(decodeBolt11(`LIGHTNING:${TEST_MINT_INVOICE.toUpperCase()}`)?.amountSat).toBe(2100);
  });

  it("refuses anything whose checksum does not hold", () => {
    const broken = TEST_MINT_INVOICE.slice(0, 40) + (TEST_MINT_INVOICE[40] === "q" ? "p" : "q") + TEST_MINT_INVOICE.slice(41);
    expect(decodeBolt11(broken)).toBeNull();
    expect(decodeBolt11("lnbc1notaninvoice")).toBeNull();
    expect(decodeBolt11("hello")).toBeNull();
  });

  it("finds an invoice inside a message and keeps the rest of the text", () => {
    const found = findBolt11(`for the pizza ${TEST_MINT_INVOICE} thanks!`);
    expect(found?.invoice.amountSat).toBe(2100);
    expect(found?.rest).toBe("for the pizza  thanks!");
    expect(findBolt11("no invoice here, just lnbc in a sentence")).toBeNull();
  });
});
