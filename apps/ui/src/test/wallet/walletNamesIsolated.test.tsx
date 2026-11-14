import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { FederationInfo } from "@ghostly/browser/engine/paymentAdapters/fedimintSdk";
import { FedimintWalletPanel } from "../../components/FedimintWalletPanel";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { RemoveMintConfirm } from "../../components/wallet/RemoveMint";
import { WalletAway } from "../../components/wallet/WalletAway";
import type { WalletPlatform, WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { mint } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: app.i18n

/*
 * A wallet's, a device's, a mint's or a federation's name in a wallet's lines, in a language of the other direction:
 * each isolated, as the Apps lines' names are. Put in plainly, the punctuation at a name's end took the sentence's
 * direction and was drawn on the other side: "على !MacBook" in Arabic.
 */

const PHONE = "Phone!";
/** The <bdi>s holding exactly this name inside the element. */
const isolated = (el: HTMLElement, name: string) => [...el.querySelectorAll("bdi")].filter(bdi => bdi.textContent === name).length;

describe("names in a wallet's lines, in Arabic, each isolated", () => {
  it("a wallet at home on another device names the wallet and the device", () => {
    renderApp(<WalletAway wallet={{ type: "lightning", name: "Home!", home: { device: PHONE } }} />, { language: "ar" });
    const panel = screen.getByTestId("wallet-away");
    expect(isolated(panel, "Home!")).toBe(1);
    // The title's device is a <bdi>; the line naming both holds the device between FSI and PDI.
    expect(isolated(panel, PHONE)).toBe(1);
    expect(panel.textContent).toContain(`\u2068${PHONE}\u2069`);
  });

  it("an Ark wallet at home elsewhere names the device in its expiry and backup lines", () => {
    renderApp(<WalletAway wallet={{ type: "arkade", name: "Ark", home: { device: PHONE, expiresAt: Date.UTC(2026, 9, 12) } }} platform={{} as WalletPlatform} />, { language: "ar" });
    expect(isolated(screen.getByTestId("wallet-away-expires"), PHONE)).toBe(1);
    expect(isolated(screen.getByTestId("wallet-away-backup"), PHONE)).toBe(1);
  });

  it("Remove asks about the mint by its name", () => {
    const state = walletView({ mints: [mint("https://a.example", 0), { ...mint("https://b.example", 0), name: "Minibits!" }] }) as WalletState;
    renderApp(<RemoveMintConfirm mint={state.mints[1]!} wallet={{} as WalletPlatform} state={state} onClose={() => {}} />, { language: "ar" });
    expect(isolated(screen.getByTestId("mint-remove-confirm"), "Minibits!")).toBe(1);
  });

  it("Join names the federation", async () => {
    const facts = { federationId: "b".repeat(64), name: "Beta!", guardians: [{ id: 0, name: "g0" }], consensusVersion: "2.1", network: "regtest", modules: ["ln", "mint"] } as never as FederationInfo;
    const wallet = { fedimintPreview: async () => facts } as Partial<WalletPlatform> as WalletPlatform;
    const state = walletView({ mode: "testnet", fedimint: { federations: [], balance: 0, history: [] } as never }) as WalletState;
    const { user } = renderApp(<FedimintWalletPanel wallet={wallet} state={state} />, { language: "ar" });
    await user.type(screen.getByTestId("fedimint-invite"), "fed1beta");
    await user.click(screen.getByTestId("fedimint-preview"));
    await waitFor(() => expect(isolated(screen.getByTestId("fedimint-join"), "Beta!")).toBe(1));
  });

  it("a card spending another's balance names that card", () => {
    renderApp(<CashuWallet wallet={{} as WalletPlatform} state={walletView() as WalletState} rail="lightning" sharedWith="Home!" onOpenCashu={() => {}} />, { language: "ar" });
    expect(isolated(screen.getByTestId("wallet-shared-balance"), "Home!")).toBe(1);
  });
});
