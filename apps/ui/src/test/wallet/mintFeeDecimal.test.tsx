import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TEST_MINTS } from "@ghostly/browser/shared/mints";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type MintInfo, type WalletPlatform, type WalletState } from "../../lib/platform";
import type { Language } from "../../lib/settings";
import { walletView } from "../fakeEngine";
import { mint } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: wallet.cashu.mint.add
describe("a mint's fee per proof is written in the app's language", () => {
  /**
   * A mint's row says what it charges per proof, a fraction of a sat (`input_fee_ppk` / 1000). The number went into the
   * line as JavaScript writes it, "0.1", in every language, beside amounts written the language's way ("10.000 sats de
   * teste" next to "0.1 sat de teste por prova").
   */
  const FEES: Record<Language, [ppk: number, line: string][]> = {
    en: [[100, "0.1 test sat per proof"], [2_500, "2.5 test sat per proof"]],
    pt: [[100, "0,1 sat de teste por prova"], [2_500, "2,5 sat de teste por prova"]],
    es: [[100, "0,1 sat de prueba por prueba"]],
    fr: [[100, "0,1 sat de test par preuve"]],
    it: [[100, "0,1 sat di prova per prova"]],
    ar: [[100, "0.1"]],
    ja: [[100, "0.1"]],
    zh: [[100, "0.1"]],
  };
  const info = (inputFeePpk: number): MintInfo => ({ inputFeePpk, receive: null, send: null });

  for (const [language, cases] of Object.entries(FEES) as [Language, (typeof FEES)[Language]][]) {
    for (const [ppk, line] of cases) {
      it(`${language}: ${ppk} ppk reads "${line}"`, () => {
        const state = networkState(walletView({ mode: "testnet", mints: [{ ...mint(TEST_MINTS[0], 10_000), info: info(ppk) }], balance: 10_000 }) as WalletState, "testnet");
        const wallet: WalletPlatform = Object.create(servicesPlatform!.wallet);
        renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />, { language });
        expect(screen.getByTestId("mint-fees").textContent).toContain(line);
      });
    }
  }
});
