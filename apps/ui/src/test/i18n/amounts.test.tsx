import { screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Wallet } from "../../pages/Wallet";
import { networkState, walletCard } from "../../components/walletCardData";
import type { WalletState } from "../../lib/platform";
import { amountText, formatAmount, formatTokenAmount, readAmount } from "../../lib/amount";
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

  it("the Cashu history dates a movement in Portuguese, and says what the test coins were in it", async () => {
    const at = Date.UTC(2026, 8, 30, 15, 15);
    const { engine, user } = renderApp(<Wallet />, { language: "pt" });
    engine.update({ wallet: walletView({ mints: [mint(TEST_MINT, 10_000)], balance: 10_000, history: [
      { id: "coins", timestamp: at, mint: TEST_MINT, kind: "lightning-in", amount: 10_000, fee: 0, note: "Test coins from the test mint" },
    ] }) });
    await user.click(await screen.findByTestId("wallet-network-testnet"));
    await user.click(await screen.findByTestId("wallet-history"));
    const row = await screen.findByTestId("wallet-tx");
    const written = new Intl.DateTimeFormat("pt-BR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(at);
    expect(row).toHaveTextContent(written);
    expect(row).not.toHaveTextContent(new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(at));
    expect(row).toHaveTextContent("Moedas de teste do mint de teste");
    expect(row).not.toHaveTextContent("Test coins from the test mint");
  });

  it("a wallet's decimal amount field takes the comma a phone's decimal key types, and shows it as typed", async () => {
    let meant = "";
    const Field = () => { const [value, setValue] = useState(""); meant = value; return <Amount value={value} onChange={setValue} unit="USDT" decimals={6} testId="amount" />; };
    const { user } = renderApp(<Field />, { language: "pt" });
    await user.type(screen.getByTestId("amount"), "2,75");
    expect(screen.getByTestId("amount")).toHaveValue("2,75");
    expect(meant).toBe("2.75");
  });

  it("a dot groups thousands in Portuguese: \"1.000\" is a thousand, never one", async () => {
    let meant = "";
    const Field = () => { const [value, setValue] = useState(""); meant = value; return <Amount value={value} onChange={setValue} unit="USDT" decimals={6} testId="amount" />; };
    const { user } = renderApp(<Field />, { language: "pt" });
    await user.type(screen.getByTestId("amount"), "1.000");
    expect(meant).toBe("1000");
    expect(screen.queryByTestId("amount-unclear")).not.toBeInTheDocument();
    // A dot that cannot be grouping could be a decimal point: refused, said why, nothing meant.
    await user.clear(screen.getByTestId("amount"));
    await user.type(screen.getByTestId("amount"), "1.5");
    expect(meant).toBe("");
    expect(screen.getByTestId("amount-unclear")).toHaveTextContent("Valor ambíguo: escreva como 1.234,5");
  });

  it("a sats field refuses a decimal point instead of reading \"1.5\" as 15", async () => {
    let meant = "";
    const Field = () => { const [value, setValue] = useState(""); meant = value; return <Amount value={value} onChange={setValue} unit="sats" testId="amount" />; };
    const { user } = renderApp(<Field />);
    await user.type(screen.getByTestId("amount"), "1.5");
    expect(meant).toBe("");
    expect(screen.getByTestId("amount-unclear")).toHaveTextContent("Whole numbers only, like 1,234");
    await user.clear(screen.getByTestId("amount"));
    await user.type(screen.getByTestId("amount"), "21,000");
    expect(meant).toBe("21000");
  });
});

describe("an amount typed", () => {
  const meaning = (text: string, language: Language, decimals = 6) => { const read = readAmount(text, language, decimals); return read.ok ? read.value : read.why; };
  it.each(LANGUAGES)("in %s reads the language's decimal point, its grouping only in groups of three, and refuses what could be either", (language) => {
    const comma = formatTokenAmount("15", 1, language) === "1,5";
    const [point, group] = comma ? [",", "."] : [".", ","];
    expect(meaning(`1${point}5`, language)).toBe("1.5");
    expect(meaning(`1${group}000`, language), "a thousand, grouped").toBe("1000");
    expect(meaning(`1${group}000${point}5`, language)).toBe("1000.5");
    expect(meaning(`12${group}345${group}678`, language)).toBe("12345678");
    expect(meaning("1 000", language), "a space groups too").toBe("1000");
    expect(meaning(`1${group}5`, language), "a decimal point in another language's way").toBe("unclear");
    expect(meaning(`0${group}001`, language)).toBe("unclear");
    expect(meaning(`1${point}5${point}0`, language)).toBe("unclear");
    expect(meaning(`1${point}5`, language, 0), "whole sats").toBe("whole");
    expect(meaning(`21${group}000`, language, 0)).toBe("21000");
    expect(meaning("", language)).toBe("");
    expect(amountText("1000.5", language)).toBe(`1000${point}5`);
  });
});
