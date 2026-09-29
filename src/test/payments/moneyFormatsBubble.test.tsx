import { screen, within } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import type { PaymentReview } from "@ghostly/core";
import { ETHEREUM_USDT, SEPOLIA_TEST_USDT } from "@ghostly/core";
import { MessageBubble } from "../../components/MessageBubble";
import type { ChatMessage } from "../../lib/types";
import type { NetworkWalletsView, WalletView } from "@ghostly/browser/shared/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { BARK_TESTNET, BC1Q, EVM, arkadeAddress, bcrt1q, bolt12Offer, TB1Q } from "./moneyFormatFixtures";

// covers: payments.money.onchain-card, payments.money.bolt12-card, payments.money.ark-card, payments.money.usdt-card, payments.money.network

const message = (text: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({ id: "m1", text, sender: "peer", timestamp: 1_700_000_000_000, ...patch });

function Where() {
  const location = useLocation();
  return <p data-testid="where" data-state={JSON.stringify(location.state ?? null)}>{location.pathname}</p>;
}

function bubble(text: string, patch: Partial<ChatMessage> = {}) {
  return renderApp(<><MessageBubble message={message(text, patch)} peerPubKey="peer" /><Where /></>);
}

const empty = (): NetworkWalletsView => ({ mints: [], balance: 0, history: [], feesPaid: 0 });
const regtestBitcoin = { status: "ready", providerId: "bdk", label: "BDK wallet", network: "regtest", balance: 100_000, history: [] } as unknown as NonNullable<NetworkWalletsView["bitcoin"]>;

/** The profile's wallets on each network, as the engine sends them since wallets have their own network. */
function wallets(networks: Partial<Record<"mainnet" | "testnet", Partial<NetworkWalletsView>>>) {
  const view: Partial<WalletView> = { networks: { mainnet: { ...empty(), ...networks.mainnet }, testnet: { ...empty(), ...networks.testnet } } };
  fakeEngine.setState({ wallet: view as WalletView });
}

const review = (patch: Partial<PaymentReview>): PaymentReview => ({
  id: "review-1", method: "bitcoin", network: "regtest", provider: "onchain", asset: "BTC", unit: "sat", address: "", expiresAt: Date.now() + 60_000,
  payee: "", amount: 0, fee: 180, feeCap: 2_000, createdAt: Date.now(), state: "pending", ...patch,
});

beforeEach(() => fakeEngine.reset());

describe("a pasted Bitcoin address or bitcoin: link", () => {
  it("says Test money in words for a regtest address, and pays it from the regtest wallet through the review", async () => {
    wallets({ testnet: { bitcoin: regtestBitcoin } });
    const address = bcrt1q();
    fakeEngine.on("preparePayment", (params) => review({ address: params.target.address, amount: params.amount, feeCap: params.feeCap, payee: params.payee }));
    const { user } = bubble(`bitcoin:${address}?amount=0.0002&message=Lunch`);
    const card = screen.getByTestId("onchain-bubble");
    expect(card).toHaveAttribute("data-network", "testnet");
    expect(within(card).getByTestId("money-network")).toHaveTextContent("Test money· regtest");
    expect(within(card).getByTestId("money-amount")).toHaveTextContent("20,000");
    expect(card).toHaveTextContent("test sats");
    expect(card).toHaveTextContent("Lunch");
    expect(within(card).getByTestId("money-detail")).toHaveTextContent(address);

    await user.click(within(card).getByTestId("onchain-pay"));
    // The amount is the link's: not asked again. Nothing is sent before the review.
    expect(within(card).queryByTestId("money-pay-amount")).toBeNull();
    expect(fakeEngine.callsTo("preparePayment")).toHaveLength(0);
    await user.click(within(card).getByTestId("money-review"));
    expect(await within(card).findByTestId("payment-review")).toHaveTextContent("Review payment");
    expect(fakeEngine.callsTo("preparePayment")).toEqual([expect.objectContaining({
      target: expect.objectContaining({ method: "bitcoin", network: "regtest", provider: "onchain", address }),
      amount: 20_000, feeCap: 2_000, payee: address, memo: "Lunch",
    })]);
    expect(fakeEngine.callsTo("approvePayment")).toHaveLength(0);
  });

  it("says Real money for a mainnet address, and asks for the amount when the address carries none", async () => {
    wallets({ mainnet: { bitcoin: { ...regtestBitcoin, network: "bitcoin" } } });
    const { user } = bubble(`my address ${BC1Q}`);
    const card = screen.getByTestId("onchain-bubble");
    expect(within(card).getByTestId("money-network")).toHaveTextContent("Real money");
    expect(within(card).getByTestId("money-network")).toHaveAttribute("data-network", "mainnet");
    expect(card).toHaveTextContent("Any amount");
    await user.click(within(card).getByTestId("onchain-pay"));
    const review = within(card).getByTestId("money-review");
    expect(review).toBeDisabled();
    await user.type(within(card).getByTestId("money-pay-amount"), "1500");
    expect(review).toBeEnabled();
  });

  it("with no wallet on the address's network, says so, never offers the other network's, and offers to create one", async () => {
    // A Mainnet Bitcoin wallet only: a regtest address is test money it never pays.
    wallets({ mainnet: { bitcoin: { ...regtestBitcoin, network: "bitcoin" } } });
    const { user } = bubble(bcrt1q());
    const card = screen.getByTestId("onchain-bubble");
    expect(within(card).queryByTestId("onchain-pay")).toBeNull();
    const none = within(card).getByTestId("money-no-wallet");
    expect(none).toHaveTextContent("You have no Testnet Bitcoin wallet to pay this test money.");
    expect(none).toHaveTextContent("Your Mainnet Bitcoin wallet never pays it.");
    await user.click(within(card).getByTestId("money-create-wallet"));
    expect(screen.getByTestId("where")).toHaveTextContent("/wallet");
    expect(JSON.parse(screen.getByTestId("where").dataset.state!)).toMatchObject({ newWallet: { type: "bitcoin", network: "testnet" } });
  });

  it("refuses an address of another test chain than the wallet's", () => {
    wallets({ testnet: { bitcoin: regtestBitcoin } });
    bubble(TB1Q);
    expect(screen.getByTestId("money-wrong-chain")).toHaveTextContent("Your Testnet Bitcoin wallet is on regtest; this address is for testnet / signet.");
    expect(screen.queryByTestId("onchain-pay")).toBeNull();
  });

  it("offers the link's Lightning invoice as the other way to pay", () => {
    const invoice = "lnbc21u1p42mkf2dqqpp56q3d9mfahf0974jqwy0yyfrg7zxksgxk7ufcc084yydhfx43daqqsp59g4z52329g4z52329g4z52329g4z52329g4z52329g4z52329g4q9qrsgqcqzyskhkhqar4dqgqfmarvdttr8x2nrp4txtamfupfftrnn4hmrp7s8ayen7hp2ye58jq8zu65rch9eplpxkhf3pf2nvuynhqxvkw5f7a2vgq486x8x";
    bubble(`bitcoin:${BC1Q}?amount=0.000021&lightning=${invoice}`);
    expect(within(screen.getByTestId("onchain-lightning")).getByTestId("invoice-bubble")).toBeInTheDocument();
  });

  it("is not paid from my own message", () => {
    wallets({ testnet: { bitcoin: regtestBitcoin } });
    bubble(bcrt1q(), { sender: "me" });
    expect(screen.getByTestId("onchain-bubble")).toBeInTheDocument();
    expect(screen.queryByTestId("onchain-pay")).toBeNull();
  });

  it("is not paid when on-chain Bitcoin is off in this chat, and says so", () => {
    wallets({ testnet: { bitcoin: regtestBitcoin } });
    fakeEngine.update({ links: [linkView({ paymentMethods: { cashu: true, lightning: true, arkade: true, usdt: true, bark: true, bitcoin: false, fedimint: true, spark: true } })] });
    bubble(bcrt1q());
    expect(screen.queryByTestId("onchain-pay")).toBeNull();
    expect(screen.getByTestId("money-off")).toHaveTextContent("On-chain Bitcoin is off in this chat.");
  });
});

describe("a BOLT 12 offer", () => {
  it("shows its network, amount and description, and says which wallets pay it", () => {
    bubble(bolt12Offer({ chains: ["regtest"], amountMsat: 21_000_000, description: "Coffee", issuer: "Ghost Café" }));
    const card = screen.getByTestId("bolt12-bubble");
    expect(within(card).getByTestId("money-network")).toHaveTextContent("Test money· regtest");
    expect(within(card).getByTestId("money-amount")).toHaveTextContent("21,000");
    expect(card).toHaveTextContent("Coffee");
    expect(card).toHaveTextContent("From Ghost Café");
    expect(card).toHaveTextContent("Pay it with a wallet that supports BOLT 12 offers");
    expect(within(card).getByRole("link", { name: "Open wallet" })).toHaveAttribute("href", expect.stringMatching(/^lightning:lno1/));
  });

  it("an offer naming no chain is Bitcoin: Real money", () => {
    bubble(bolt12Offer({ description: "tips" }));
    expect(screen.getByTestId("money-network")).toHaveTextContent("Real money");
  });
});

describe("an Ark address", () => {
  it("a Bark address is paid from the Testnet Bark wallet, never Arkade's", async () => {
    wallets({ testnet: { ark: { configured: true, locked: false, network: "mutinynet", provider: "https://arkade.test", balance: 1 }, bark: { configured: true, locked: false, network: "regtest", provider: "http://127.0.0.1:47020", balance: 50_000 } as never } });
    fakeEngine.on("preparePayment", (params) => review({ method: params.target.method, address: params.target.address, amount: params.amount }));
    const { user } = bubble(BARK_TESTNET);
    const card = screen.getByTestId("ark-bubble");
    expect(card).toHaveTextContent("Ark address (Bark)");
    expect(within(card).getByTestId("money-network")).toHaveTextContent("Test money");
    await user.click(within(card).getByTestId("ark-pay"));
    await user.type(within(card).getByTestId("money-pay-amount"), "1000");
    await user.click(within(card).getByTestId("money-review"));
    await within(card).findByTestId("payment-review");
    expect(fakeEngine.callsTo("preparePayment")[0]).toMatchObject({ target: { method: "bark", network: "regtest", provider: "http://127.0.0.1:47020", address: BARK_TESTNET }, amount: 1000 });
  });

  it("an Arkade address with no Testnet Ark wallet offers to create one", () => {
    wallets({});
    bubble(`pay me: ${arkadeAddress("tark")}`);
    expect(screen.getByTestId("ark-bubble")).toHaveTextContent("Ark address (Arkade)");
    expect(screen.getByTestId("money-no-wallet")).toHaveTextContent("You have no Testnet Ark wallet");
  });
});

describe("a USDT address", () => {
  it("an EIP-681 transfer on Sepolia is test money, paid from the Sepolia wallet with the link's amount", async () => {
    wallets({ testnet: { usdt: { configured: true, locked: false, network: "sepolia", provider: "https://sepolia.test", chainId: 11155111, token: SEPOLIA_TEST_USDT, decimals: 6, balance: "5000000", gasBalance: "1" } } });
    fakeEngine.on("preparePayment", (params) => review({ method: "usdt", amount: params.amount }));
    const { user } = bubble(`ethereum:${SEPOLIA_TEST_USDT}@11155111/transfer?address=${EVM}&uint256=2.5e6`);
    const card = screen.getByTestId("usdt-bubble");
    expect(card).toHaveTextContent("USDT address · Sepolia");
    expect(within(card).getByTestId("money-network")).toHaveTextContent("Test money");
    expect(within(card).getByTestId("money-amount")).toHaveTextContent("2.5");
    await user.click(within(card).getByTestId("usdt-pay"));
    await user.click(within(card).getByTestId("money-review"));
    await within(card).findByTestId("payment-review");
    expect(fakeEngine.callsTo("preparePayment")[0]).toMatchObject({ target: { method: "usdt", chainId: 11155111, address: EVM, token: SEPOLIA_TEST_USDT, asset: "TEST-USDT" }, amount: 2_500_000 });
  });

  it("a bare 0x address with USDT named says the network is not stated, and is never paid", () => {
    wallets({ mainnet: { usdt: { configured: true, locked: false, network: "ethereum", provider: "https://eth.test", chainId: 1, token: ETHEREUM_USDT, decimals: 6, balance: "0", gasBalance: "0" } } });
    bubble(`my USDT: ${EVM}`);
    const card = screen.getByTestId("usdt-bubble");
    expect(within(card).getByTestId("money-network")).toHaveTextContent("Network not stated");
    expect(within(card).getByTestId("money-network-unknown")).toHaveTextContent("ask for a link that names the chain");
    expect(within(card).queryByTestId("usdt-pay")).toBeNull();
  });
});
