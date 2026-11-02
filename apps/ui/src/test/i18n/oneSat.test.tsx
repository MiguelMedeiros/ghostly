import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { engineText } from "@ghostly/core";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { satsIn } from "../../components/NetworkTag";
import { networkState } from "../../components/walletCardData";
import { formatAmount } from "../../lib/amount";
import { errorText } from "../../lib/errorText";
import { servicesPlatform, type WalletState } from "../../lib/platform";
import type { Language } from "../../lib/settings";
import { translateWith } from "../../locales/translate";
import { walletView } from "../fakeEngine";
import { mint, TEST_MINT } from "../payments/fixtures";
import { renderApp } from "../render";
import { LANGUAGES, LOCALES } from "./locales";

// covers: app.i18n, wallet.cashu.test-sats

/**
 * agents#2254: one sat read "1 test sats" / "1 sats" on the Cashu card, its history, Send's review, an invoice, a chat
 * request, "Redeemed" and the fee refusal, in every language, while the mint's fee line beside it said "1 test sat".
 * The unit (`satsIn`) takes the amount's form wherever a string says "{{amount}} {{unit}}", and Arabic's history
 * count its dual.
 */
const tIn = (language: Language) => translateWith(LOCALES[language], language);
const amountIn = (language: Language, amount: number, network: "testnet" | "mainnet") => {
  const t = tIn(language);
  return t("wallet.cards.amount", { amount: formatAmount(amount, language), unit: satsIn(t, network) });
};

const ONE: Record<Language, [test: string, real: string]> = {
  en: ["1 test sat", "1 sat"],
  pt: ["1 sat de teste", "1 sat"],
  es: ["1 sat de prueba", "1 sat"],
  fr: ["1 sat de test", "1 sat"],
  it: ["1 sat di prova", "1 sat"],
  ja: ["1 テスト sat", "1 sat"],
  zh: ["1 测试 sat", "1 sat"],
  ar: ["1 sat تجريبي", "1 sat"],
};

describe("one sat", () => {
  it("covers every language the app ships", () => {
    expect(Object.keys(ONE).sort()).toEqual([...LANGUAGES].sort());
  });

  it.each(LANGUAGES)("in %s reads singular, as the mint's fee line does, and two or more stay plural", (language) => {
    expect([amountIn(language, 1, "testnet"), amountIn(language, 1, "mainnet")]).toEqual(ONE[language]);
    expect(amountIn(language, 2, "testnet")).toBe(`2 ${tIn(language)("wallet.sats.testnet")}`);
    expect(amountIn(language, 10_000, "mainnet")).toBe(`${formatAmount(10_000, language)} ${tIn(language)("wallet.sats.mainnet")}`);
    // The fee line's own words for one sat: the unit now says it the same way.
    expect(tIn(language)("wallet.cashu.fee.perProofTest", { fee: 1 })).toContain(ONE[language][0].slice(2));
  });

  it("is said by the unit in any string that writes it after an amount, whatever else the string counts", () => {
    const en = tIn("en"), pt = tIn("pt"), ja = tIn("ja");
    expect(en("wallet.cashu.redeemed", { amount: "1", unit: satsIn(en, "testnet") })).toBe("Redeemed 1 test sat.");
    expect(pt("wallet.cashu.payAmount", { amount: "1", unit: satsIn(pt, "testnet") })).toBe("Pagar 1 sat de teste");
    expect(ja("wallet.cashu.payAmount", { amount: "1", unit: satsIn(ja, "testnet") })).toBe("1 テスト sat を支払う");
    // Two numbers: the unit agrees with the one written before it.
    expect(en("wallet.fedimint.across", { amount: "1", unit: satsIn(en, "mainnet"), count: 3 })).toMatch(/^1 sat across 3 federations/);
    expect(en("payments.bubble.through", { source: "Alby", fee: "1", unit: satsIn(en, "mainnet") })).toBe("Through Alby · fee up to 1 sat");
    // "1.000" is a thousand in Portuguese, not one: plural, in the unit and in a string that writes sats itself.
    expect(pt("wallet.cards.amount", { amount: formatAmount(1_000, "pt"), unit: satsIn(pt, "testnet") })).toBe("1.000 sats de teste");
    expect(pt("chat.preview.sats", { amount: formatAmount(1_000, "pt") })).toBe("1.000 sats");
    // A unit that is not a counted word (USDT, a mint's own) is left as it is.
    expect(en("wallet.cards.amount", { amount: "1", unit: "USDT" })).toBe("1 USDT");
  });

  it("is said in the strings that write sats themselves: a chat line, a balance, the fee refusal", () => {
    const en = tIn("en"), ja = tIn("ja");
    expect(en("chat.preview.testSats", { amount: "1" })).toBe("1 test sat");
    expect(en("wallet.cashu.testBalance", { amount: "1" })).toBe("1 test sat (worthless)");
    const refusal = new Error(engineText("ecashFeeTakesAll", { amount: "1" }));
    expect(errorText(refusal, en)).toMatch(/^The mint keeps this ecash's 1 sat as its fee/);
    expect(errorText(refusal, ja)).toMatch(/1 sat は/);
    expect(errorText(new Error(engineText("ecashFeeTakesAll", { amount: "2" })), en)).toMatch(/all 2 sats/);
  });

  it("in Arabic, the history counts two movements with the dual, and 11 with the singular", () => {
    const ar = tIn("ar");
    expect([2, 3, 11, 100].map((count) => ar("wallet.cashu.history.movements", { count }))).toEqual(["حركتان", "3 حركات", "11 حركة", "100 حركة"]);
  });

  it("on a Testnet Cashu card: its balance, its mint and its history", async () => {
    const state = networkState(walletView({ mints: [mint(TEST_MINT, 1)], balance: 1, history: [
      { id: "in", timestamp: 1, mint: TEST_MINT, kind: "ecash-in", amount: 1, fee: 0 },
    ] }) as WalletState, "testnet");
    const { user } = renderApp(<CashuWallet wallet={servicesPlatform!.wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
    expect(screen.getByTestId("wallet-balance")).toHaveTextContent(/^1\s*test sat$/);
    expect(screen.getByTestId("mint-row")).toHaveTextContent(/1 test sat(?!s)/);
    await user.click(screen.getByTestId("wallet-history"));
    expect(screen.getByTestId("wallet-tx")).toHaveTextContent(/\+1\s*test sat(?!s)/);
  });
});
