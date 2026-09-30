import { screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Wallet } from "../../pages/Wallet";
import { networkState, walletCard } from "../../components/walletCardData";
import type { WalletState } from "../../lib/platform";
import { decimalInput, formatAmount, formatTokenAmount } from "../../lib/amount";
import { Amount } from "../../components/wallet/ui";
import { previewText } from "../../lib/chatList";
import type { Language } from "../../lib/settings";
import { englishT, translateWith } from "../../locales/translate";
import { walletView } from "../fakeEngine";
import { mint, TEST_MINT } from "../payments/fixtures";
import { bcrt1q, bolt12Offer } from "../payments/moneyFormatFixtures";
import { renderApp } from "../render";
import { LANGUAGES, LOCALES } from "./locales";

// covers: app.i18n, wallet.deck

/**
 * Amounts are written in the app's language, never the device's: a Portuguese interface on an English Linux showed
 * "10,000 sats de teste". Latin digits in every language (Arabic too), as the voice speed pill writes them.
 */
const NNBSP = " ";
const WRITTEN: Record<Language, [string, string]> = {
  en: ["10,000", "1,234,567"],
  pt: ["10.000", "1.234.567"],
  es: ["10.000", "1.234.567"],
  fr: [`10${NNBSP}000`, `1${NNBSP}234${NNBSP}567`],
  it: ["10.000", "1.234.567"],
  zh: ["10,000", "1,234,567"],
  ja: ["10,000", "1,234,567"],
  ar: ["10,000", "1,234,567"],
};

const tIn = (language: Language) => translateWith(LOCALES[language], language);

afterEach(() => localStorage.clear());

describe("an amount", () => {
  it("covers every language the app ships", () => {
    expect(Object.keys(WRITTEN).sort()).toEqual([...LANGUAGES].sort());
  });

  it.each(LANGUAGES)("in %s is grouped the way that language writes it, in Latin digits", (language) => {
    const [small, large] = WRITTEN[language];
    expect(formatAmount(10_000, language)).toBe(small);
    expect(formatAmount(1_234_567, language)).toBe(large);
    expect(formatAmount(1_234_567, language)).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/);
  });

  it("is English when no language is given, whatever the device's", () => {
    expect(formatAmount(10_000)).toBe("10,000");
    expect(formatAmount(10_000, englishT.language)).toBe("10,000");
  });

  it("a token's is exact, with the language's decimal mark", () => {
    expect(formatTokenAmount("1234500000", 6, "en")).toBe("1,234.5");
    expect(formatTokenAmount("1234500000", 6, "pt")).toBe("1.234,5");
    expect(formatTokenAmount("1234500000", 6, "fr")).toBe(`1${NNBSP}234,5`);
    expect(formatTokenAmount("1000000", 6, "pt")).toBe("1");
    expect(formatTokenAmount("123456789012345678901234", 18, "en")).toBe("123,456.789012345678901234");
  });

  it("a translator knows its language, so a helper handed only t() writes amounts in it", () => {
    for (const language of LANGUAGES) expect(tIn(language).language).toBe(language);
    expect(englishT.language).toBe("en");
  });
});

describe("in Portuguese", () => {
  const pt = tIn("pt");

  it("a wallet card's balance reads 10.000", () => {
    const state = networkState(walletView({ mints: [mint(TEST_MINT, 10_000)], balance: 10_000 }) as WalletState, "testnet");
    expect(walletCard("cashu", "testnet", state, undefined, pt).balance).toBe("10.000 sats de teste");
    expect(walletCard("cashu", "testnet", state).balance).toBe("10,000 test sats");
  });

  it("the chat list's preview of an address or offer with an amount reads 10.000", () => {
    expect(previewText(`bitcoin:${bcrt1q()}?amount=0.0001`, pt)).toMatch(/ · 10\.000 sats de teste$/);
    expect(previewText(bolt12Offer({ chains: ["regtest"], amountMsat: 12_345_000 }), pt)).toMatch(/ · 12\.345 sats de teste$/);
  });

  it("the Wallets page shows the balance and its card in Portuguese", async () => {
    const { engine, user } = renderApp(<Wallet />, { language: "pt" });
    engine.update({ wallet: walletView({ mints: [mint(TEST_MINT, 10_000)], balance: 10_000 }) });
    await user.click(await screen.findByTestId("wallet-network-testnet"));
    expect(await screen.findByTestId("wallet-card-cashu-testnet")).toHaveTextContent("10.000 sats de teste");
    expect(screen.getByTestId("wallet-card-cashu-testnet")).not.toHaveTextContent("10,000");
  });

  it("a wallet's decimal amount field takes the comma a phone's decimal key types", async () => {
    const Field = () => { const [value, setValue] = useState(""); return <Amount value={value} onChange={setValue} unit="USDT" decimals={6} testId="amount" />; };
    const { user } = renderApp(<Field />, { language: "pt" });
    await user.type(screen.getByTestId("amount"), "2,75");
    expect(screen.getByTestId("amount")).toHaveValue("2.75");
  });
});

describe("a decimal amount typed", () => {
  it.each(LANGUAGES)("in %s keeps the decimal point, and a comma only where the language writes it so", (language) => {
    const comma = formatTokenAmount("15", 1, language) === "1,5";
    expect(decimalInput("1.5", language)).toBe("1.5");
    expect(decimalInput("1,5", language)).toBe(comma ? "1.5" : "15");
    expect(decimalInput("1.000,5", language)).toBe(comma ? "1000.5" : "1.0005");
    expect(decimalInput("12a", language)).toBe("12");
  });
});
