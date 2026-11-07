import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, encodeGroupEntryLink } from "@ghostly/core";
import { TEST_MINTS } from "@ghostly/browser/shared/mints";
import { GroupLinkPanel } from "../../components/GroupLinkPanel";
import { QRCodeDisplay } from "../../components/QRCode";
import { LinkActions } from "../../components/chat/LinkQrDialog";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type WalletPlatform, type WalletState } from "../../lib/platform";
import { copyText } from "../../lib/shareLink";
import { Wallet } from "../../pages/Wallet";
import { fakeEngine, groupView, walletView } from "../fakeEngine";
import { mint, REAL_MINT } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: invite.copy, devices.enroll.invite, groups.link.share, wallet.cashu.export, wallet.instances.remove

const INVITE = "https://ghostly.tools/#ghostly1secretinvite";

/**
 * A secret copied (an invite, a device's link, a group's link, ecash) goes through the host's sensitive copy where it
 * has one (the Android app: the system's copy preview shows dots, keyboards keep no history of it). Everything else is
 * copied by the page, as before; and where the host has no such copy (desktop, web) a secret is too.
 */
describe("a secret is copied as one where the platform marks it", () => {
  let secret: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
  let page: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    secret = vi.fn(async (_text: string) => {});
    fakeEngine.copySecret = secret;
  });
  afterEach(() => { fakeEngine.copySecret = undefined; });
  /** Spied after the render: user-event puts its own clipboard in place when it starts. */
  const watchPage = () => { page = vi.spyOn(navigator.clipboard, "writeText") as unknown as ReturnType<typeof vi.fn>; };

  it("the invite card's and Add device's Copy", async () => {
    const { user } = renderApp(<QRCodeDisplay value={INVITE} />);
    watchPage();
    await user.click(screen.getByRole("button", { name: /copy/i }));
    await waitFor(() => expect(secret).toHaveBeenCalledWith(INVITE));
    expect(page).not.toHaveBeenCalled();
  });

  it("a card's link and its QR dialog's Copy", async () => {
    const { user } = renderApp(<LinkActions name="card" title="Invite" url={INVITE} />);
    watchPage();
    await user.click(screen.getByTestId("card-copy"));
    await waitFor(() => expect(secret).toHaveBeenCalledTimes(1));
    await user.click(screen.getByTestId("card-qr"));
    await user.click(screen.getByTestId("link-qr-copy"));
    await waitFor(() => expect(secret).toHaveBeenCalledTimes(2));
    expect(secret).toHaveBeenLastCalledWith(INVITE);
    expect(page).not.toHaveBeenCalled();
  });

  it("a group's link", async () => {
    const id = "AbCdEfGhIjKlMnOpQrStUv";
    const group = groupView({ id, status: "active", epoch: 1, isAdmin: true, entryLink: encodeGroupEntryLink({ g: id, host: createIdentity().pubKeyZ32 }) });
    const { user } = renderApp(<GroupLinkPanel group={group} large />);
    watchPage();
    await user.click(screen.getByTestId("group-link-copy"));
    await waitFor(() => expect(secret).toHaveBeenCalledWith(expect.stringContaining("/#/join/")));
    expect(page).not.toHaveBeenCalled();
  });

  it("Cashu's Copy backup", async () => {
    const state = networkState(walletView({ mode: "testnet", mints: [mint(TEST_MINTS[0], 5_000)], balance: 5_000 }) as WalletState, "testnet");
    const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet), { exportTokens: async () => [{ token: "cashuBone", mint: TEST_MINTS[0], amount: 1 }, { token: "cashuBtwo", mint: TEST_MINTS[0], amount: 2 }] });
    const { user } = renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
    watchPage();
    await user.click(screen.getByRole("button", { name: "Copy backup" }));
    await waitFor(() => expect(secret).toHaveBeenCalledWith("cashuBone\ncashuBtwo"));
    expect(page).not.toHaveBeenCalled();
  });

  it("Remove wallet's copy of the ecash", async () => {
    const app = renderApp(<Wallet />);
    app.engine.update({ wallet: walletView({ mints: [mint(REAL_MINT, 21_000)], balance: 21_000 }) });
    await app.user.click(await screen.findByTestId("wallet-card-cashu-mainnet"));
    await app.user.click(await screen.findByTestId("wallet-remove"));
    app.engine.on("walletExport", () => [{ mint: REAL_MINT, token: "cashuBfixture", amount: 21_000 }]);
    watchPage();
    await app.user.click(screen.getByTestId("wallet-remove-copy-tokens"));
    expect(await screen.findByTestId("wallet-remove-notice")).toHaveTextContent("Ecash copied");
    expect(secret).toHaveBeenCalledWith("cashuBfixture");
    expect(page).not.toHaveBeenCalled();
  });

  it("anything else is copied by the page, unmarked", async () => {
    const { user } = renderApp(<button onClick={() => void copyText("hello there")}>Copy text</button>);
    watchPage();
    await user.click(screen.getByRole("button", { name: "Copy text" }));
    await waitFor(() => expect(page).toHaveBeenCalledWith("hello there"));
    expect(secret).not.toHaveBeenCalled();
  });

  it("where the host has no sensitive copy (desktop, web), a secret is copied by the page as before", async () => {
    fakeEngine.copySecret = undefined;
    const { user } = renderApp(<QRCodeDisplay value={INVITE} />);
    watchPage();
    await user.click(screen.getByRole("button", { name: /copy/i }));
    await waitFor(() => expect(page).toHaveBeenCalledWith(INVITE));
  });
});
