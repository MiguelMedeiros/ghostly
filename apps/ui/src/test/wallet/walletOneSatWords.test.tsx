// covers: app.i18n, wallet.cashu.test-sats
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { satsIn } from "../../components/NetworkTag";
import { networkState } from "../../components/walletCardData";
import { formatAmount } from "../../lib/amount";
import { servicesPlatform, type WalletState } from "../../lib/platform";
import type { Language } from "../../lib/settings";
import { translateWith } from "../../locales/translate";
import { walletView } from "../fakeEngine";
import { lightningSource, mint, TEST_MINT } from "../payments/fixtures";
import { renderApp } from "../render";
import { LANGUAGES, LOCALES } from "../i18n/locales";

/**
 * One sat received, paid to an address, unconfirmed or not spendable yet: the words after the unit take its number,
 * as Redeemed and Set aside do ("1 sat de teste recebido", not "recebidos"). Arabic's adjective takes the unit's
 * singular at one; its dual is the unit's own form. A Lightning card's balance unit is counted by its balance.
 */
const tIn = (language: Language) => translateWith(LOCALES[language], language);
const TO = "alice@example.com";
const KEYS = ["wallet.cashu.received", "wallet.lightning.paidTo", "wallet.cashu.unconfirmed", "wallet.bitcoin.unconfirmed", "wallet.total.waiting"] as const;
const sayIn = (language: Language, amount: number) => {
  const t = tIn(language);
  return KEYS.map((key) => t(key, { amount: formatAmount(amount, language), unit: satsIn(t, "testnet"), to: TO }));
};

const ONE: Record<Language, string[]> = {
  en: ["⚡ 1 test sat received", `Paid 1 test sat to ${TO} ✓`, "1 test sat not confirmed", "1 test sat unconfirmed", "1 test sat not spendable yet"],
  pt: ["⚡ 1 sat de teste recebido", `1 sat de teste pago a ${TO} ✓`, "1 sat de teste não confirmado", "1 sat de teste não confirmado", "1 sat de teste ainda não disponível"],
  es: ["⚡ 1 sat de prueba recibido", `1 sat de prueba pagado a ${TO} ✓`, "1 sat de prueba sin confirmar", "1 sat de prueba sin confirmar", "1 sat de prueba aún no disponible"],
  fr: ["⚡ 1 sat de test reçu", `1 sat de test payé à ${TO} ✓`, "1 sat de test non confirmé", "1 sat de test non confirmé", "1 sat de test pas encore disponible"],
  it: ["⚡ 1 sat di prova ricevuto", `1 sat di prova pagato a ${TO} ✓`, "1 sat di prova non confermato", "1 sat di prova non confermato", "1 sat di prova non ancora spendibile"],
  ja: ["⚡ 1 テスト sat を受け取りました", `${TO} に 1 テスト sat を支払いました ✓`, "1 テスト sat は未確認", "1 テスト sat 未承認", "1 テスト sat はまだ使えません"],
  zh: ["⚡ 已收到 1 测试 sat", `已向 ${TO} 支付 1 测试 sat ✓`, "1 测试 sat 未确认", "1 测试 sat 未确认", "1 测试 sat 暂不可用"],
  ar: ["⚡ استُلم 1 sat تجريبي", `دُفع 1 sat تجريبي إلى ${TO} ✓`, "1 sat تجريبي غير مؤكد", "1 sat تجريبي غير مؤكد", "1 sat تجريبي غير قابل للإنفاق بعد"],
};

const TWO: Partial<Record<Language, string[]>> = {
  pt: ["⚡ 2 sats de teste recebidos", `2 sats de teste pagos a ${TO} ✓`, "2 sats de teste não confirmados", "2 sats de teste não confirmados", "2 sats de teste ainda não disponíveis"],
  fr: ["⚡ 2 sats de test reçus", `2 sats de test payés à ${TO} ✓`, "2 sats de test non confirmés", "2 sats de test non confirmés", "2 sats de test pas encore disponibles"],
  ar: ["⚡ استُلم 2 sats تجريبية", `دُفع 2 sats تجريبية إلى ${TO} ✓`, "2 sats تجريبية غير مؤكدة", "2 sats تجريبية غير مؤكدة", "2 sats تجريبية غير قابلة للإنفاق بعد"],
};

describe("one sat received, paid, unconfirmed or waiting", () => {
  it("covers every language the app ships", () => {
    expect(Object.keys(ONE).sort()).toEqual([...LANGUAGES].sort());
  });

  it.each(LANGUAGES)("in %s, the words after one sat read singular", (language) => {
    expect(sayIn(language, 1)).toEqual(ONE[language]);
  });

  it.each(Object.keys(TWO) as Language[])("in %s, two sats stay plural", (language) => {
    expect(sayIn(language, 2)).toEqual(TWO[language]);
  });

  it("pt: a thousand (\"1.000\") is not one", () => {
    expect(sayIn("pt", 1_000)[0]).toBe("⚡ 1.000 sats de teste recebidos");
  });

  it("on a Cashu card, one unconfirmed sat reads singular", () => {
    const state = networkState(walletView({ mode: "testnet", mints: [mint(TEST_MINT, 5)], balance: 5, unconfirmed: 1 }) as WalletState, "testnet");
    renderApp(<CashuWallet wallet={servicesPlatform!.wallet} state={state} rail="cashu" onOpenCashu={() => {}} />, { language: "pt" });
    expect(screen.getByTestId("wallet-unconfirmed").textContent).toBe("1 sat de teste não confirmado");
  });

  it.each([[1, /^1\s*test sat · Breez$/], [2, /^2\s*test sats · Breez$/]] as const)("a Lightning card holding %i says its unit for its balance", (balance, line) => {
    const state = networkState(walletView({ mode: "testnet", lightning: lightningSource({ mode: "testnet", network: "regtest", providerId: "breez", label: "Breez", read: true, balance }) }) as WalletState, "testnet");
    renderApp(<CashuWallet wallet={servicesPlatform!.wallet} state={state} rail="lightning" onOpenCashu={() => {}} />, { language: "en" });
    expect(screen.getByTestId("wallet-balance")).toHaveTextContent(line);
  });
});
