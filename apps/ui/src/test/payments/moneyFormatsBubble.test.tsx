import { fireEvent, screen, within } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentReview } from "@ghostly/core";
import { ETHEREUM_USDT, SEPOLIA_TEST_USDT } from "@ghostly/core";
import { MessageBubble } from "../../components/MessageBubble";
import type { ChatMessage } from "../../lib/types";
import type { NetworkWalletsView, WalletView } from "@ghostly/browser/shared/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { BARK_TESTNET, BC1Q, EVM, arkadeAddress, bcrt1q, bolt12Offer, corrupt, TB1Q, XMR_MAINNET, XMR_STAGENET, XMR_STAGENET_SUBADDRESS } from "./moneyFormatFixtures";
import { MAINNET_INVOICE, REGTEST_INVOICE } from "./fixtures";

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

  it("does not offer a Lightning invoice for another amount than the link's as the same payment", () => {
    wallets({ testnet: { bitcoin: regtestBitcoin } });
    bubble(`bitcoin:${bcrt1q()}?amount=0.00001&lightning=${REGTEST_INVOICE}`);
    expect(within(screen.getByTestId("onchain-bubble")).getByTestId("money-amount")).toHaveTextContent("1,000");
    expect(screen.getByTestId("onchain-pay")).toBeInTheDocument();
    expect(screen.queryByTestId("onchain-lightning")).toBeNull();
    expect(screen.queryByTestId("invoice-bubble")).toBeNull();
  });

  it("offers no way to pay a link it must not pay, its Lightning invoice included", () => {
    wallets({ testnet: { bitcoin: regtestBitcoin } });
    bubble(`bitcoin:${bcrt1q()}?amount=0.0025&req-somethingnew=1&lightning=${REGTEST_INVOICE}`);
    expect(screen.getByTestId("onchain-bubble")).toHaveTextContent("This link asks for something this app does not understand");
    expect(screen.queryByTestId("onchain-pay")).toBeNull();
    expect(screen.queryByTestId("onchain-lightning")).toBeNull();
    expect(screen.queryByTestId("invoice-bubble")).toBeNull();
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

  it.each([false, true])("a transfer of another token with USDT in the message is no USDT card (a USDT wallet: %s)", (hasUsdt) => {
    if (hasUsdt) wallets({ testnet: { usdt: { configured: true, locked: false, network: "sepolia", provider: "https://sepolia.test", chainId: 11155111, token: SEPOLIA_TEST_USDT, decimals: 6, balance: "5000000", gasBalance: "1" } } });
    bubble(`USDT please ethereum:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238@11155111/transfer?address=${EVM}&uint256=2500000`);
    expect(screen.queryByTestId("usdt-bubble")).toBeNull();
    expect(screen.queryByTestId("money-amount")).toBeNull();
  });
});

// covers: payments.money.onchain-card, payments.money.bolt12-card, payments.money.usdt-card, payments.money.monero-card, app.i18n
describe("in Arabic, a pasted money card keeps its amount whole and its words in their own direction", () => {
  /**
   * In Arabic the pasted money cards read as the Lightning invoice's card does (InvoiceBubble): only the number is
   * isolated, so the unit stays in the line's direction, and what someone else wrote keeps its own direction. A bare
   * number glued to "sats تجريبية" was one left-to-right run with "sats", read "sats 12,345 تجريبية" from the right, and a
   * label "1 cup coffee" read "cup coffee 1".
   */
  const MEMO = "1 cup coffee";

  function bubble(text: string) {
    return renderApp(<MessageBubble message={{ id: "m1", text, sender: "peer", timestamp: 1_700_000_000_000 }} peerPubKey="peer" />, { language: "ar" });
  }

  beforeEach(() => fakeEngine.reset());

  it("a bitcoin: link", () => {
    bubble(`bitcoin:${bcrt1q()}?amount=0.00012345&label=${encodeURIComponent(MEMO)}`);
    const card = screen.getByTestId("onchain-bubble");
    expect(within(card).getByTestId("money-amount").tagName).toBe("BDI");
    expect(within(card).getByText(MEMO)).toHaveAttribute("dir", "auto");
  });

  it("a BOLT 12 offer", () => {
    bubble(bolt12Offer({ chains: ["regtest"], amountMsat: 21_000_000, description: MEMO }));
    const card = screen.getByTestId("bolt12-bubble");
    expect(within(card).getByTestId("money-amount").tagName).toBe("BDI");
    expect(within(card).getByText(MEMO)).toHaveAttribute("dir", "auto");
  });

  it("a USDT link", () => {
    bubble(`ethereum:${SEPOLIA_TEST_USDT}@11155111/transfer?address=${EVM}&uint256=2.5e6`);
    expect(within(screen.getByTestId("usdt-bubble")).getByTestId("money-amount").tagName).toBe("BDI");
  });

  it("a monero: link", () => {
    bubble(`monero:${XMR_STAGENET}?tx_amount=0.25&tx_description=${encodeURIComponent(MEMO)}`);
    const card = screen.getByTestId("monero-bubble");
    expect(within(card).getByTestId("money-amount").tagName).toBe("BDI");
    expect(within(card).getByText(MEMO)).toHaveAttribute("dir", "auto");
  });
});

// covers: payments.money.onchain-card, payments.money.bolt12-card
describe("Copy on money in a message", () => {
  /**
   * Copy on money in a message. What is copied is pasted into another wallet, so "Copied" is only said once it is: when
   * the copy is refused the clipboard still holds what was there before (maybe another address), and the card says so
   * and shows the text to select.
   */
  const message = (text: string): ChatMessage => ({ id: "m1", text, sender: "peer", timestamp: 1_700_000_000_000 });
  const bubble = (text: string) => renderApp(<MessageBubble message={message(text)} peerPubKey="peer" />);
  const TOKEN = "cashuB" + "o".repeat(40);
  const ADDRESS = "satoshi@example.com";

  /** The browser refuses the copy: no permission, or the page lost the focus. The older route is refused too. */
  const refuse = () => {
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new DOMException("Write permission denied.", "NotAllowedError"));
    document.execCommand = vi.fn(() => false);
  };

  beforeEach(() => {
    fakeEngine.reset();
    fakeEngine.on("walletInspectCashu", () => ({ inspection: { kind: "token", amount: 100, unit: "sat", mint: "https://mint.example.com", accepted: true } }));
  });
  afterEach(() => vi.restoreAllMocks());

  const CARDS: [string, () => string, string, string, () => string][] = [
    ["a Lightning invoice", () => MAINNET_INVOICE, "invoice-bubble", "Copy", () => MAINNET_INVOICE],
    ["a Lightning address", () => ADDRESS, "lnurl-bubble", "Copy", () => ADDRESS],
    ["an ecash token", () => TOKEN, "cashu-token-bubble", "Copy", () => TOKEN],
    ["a Bitcoin address", () => TB1Q, "onchain-bubble", "Copy address", () => TB1Q],
    ["a BOLT12 offer", () => bolt12Offer({ description: "tips" }), "bolt12-bubble", "Copy offer", () => bolt12Offer({ description: "tips" })],
    ["an Ark address", () => arkadeAddress(), "ark-bubble", "Copy address", () => arkadeAddress()],
  ];

  it.each(CARDS)("%s: a refused copy says so, never Copied, and shows the text to select", async (_, text, testId, name, value) => {
    const { user } = bubble(text());
    const card = await screen.findByTestId(testId);
    refuse();
    await user.click(within(card).getByRole("button", { name }));
    expect(await within(card).findByTestId("money-copy-error")).toHaveTextContent("Could not copy. Select the text and copy it yourself.");
    expect(within(card).queryByRole("button", { name: "Copied" })).not.toBeInTheDocument();
    expect(within(card).getByTestId("money-copy-text")).toHaveTextContent(value());
  });

  it.each(CARDS)("%s: a copy that worked says Copied, with no error", async (_, text, testId, name, value) => {
    const { user } = bubble(text());
    const card = await screen.findByTestId(testId);
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(within(card).getByRole("button", { name }));
    expect(await within(card).findByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(value());
    expect(within(card).queryByTestId("money-copy-error")).not.toBeInTheDocument();
    expect(within(card).queryByTestId("money-copy-text")).not.toBeInTheDocument();
  });

  it("a copy that works after a refused one takes the error away", async () => {
    const { user } = bubble(TB1Q);
    const card = await screen.findByTestId("onchain-bubble");
    refuse();
    await user.click(within(card).getByRole("button", { name: "Copy address" }));
    await within(card).findByTestId("money-copy-error");
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(within(card).getByRole("button", { name: "Copy address" }));
    expect(await within(card).findByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(within(card).queryByTestId("money-copy-error")).not.toBeInTheDocument();
  });
});

// covers: payments.money.onchain-card, payments.money.bolt12-card, payments.uri
describe("Open in wallet on a payment in a message", () => {
  /**
   * "Open in wallet" on a payment in a message. In Desktop's WKWebView (and an extension page) a `lightning:` or
   * `bitcoin:` link goes nowhere, so the link asks the platform to open it (`openPaymentLink`), as Pay externally's
   * does. The macOS WKWebView itself is proven in e2e/desktop-macos/payment-links.spec.ts.
   */
  const message = (text: string): ChatMessage => ({ id: "m1", text, sender: "peer", timestamp: 1_700_000_000_000 });
  const bubble = (text: string) => renderApp(<MessageBubble message={message(text)} peerPubKey="peer" />);
  const BIP21 = `bitcoin:${TB1Q}?amount=0.0001&label=Coffee`;

  /** Clicks the link as a person would, and says whether the page was left to follow it. */
  const click = (link: HTMLElement) => fireEvent.click(link);

  beforeEach(() => fakeEngine.reset());

  it.each([
    ["a Bitcoin payment link", BIP21, "onchain-open-wallet", BIP21],
    ["a Bitcoin address", TB1Q, "onchain-open-wallet", `bitcoin:${TB1Q}`],
    ["a BOLT12 offer", "", "bolt12-open-wallet", ""],
  ])("%s: the desktop app and the extension hand the link to the system", async (_, text, testId, expected) => {
    const offer = bolt12Offer({ description: "tips" });
    const open = vi.fn(async () => {});
    fakeEngine.openPaymentLink = open;
    bubble(text || offer);
    const link = await screen.findByTestId(testId);
    const uri = expected || `lightning:${offer}`;
    expect(link).toHaveAttribute("href", uri);
    expect(click(link)).toBe(false);
    expect(open).toHaveBeenCalledWith(uri);
  });

  it("a test-money link hands out no real-money leg: the QR and Open in wallet carry what the card shows", async () => {
    const mainnetInvoice = "lnbc21u1p42mkf2dqqpp56q3d9mfahf0974jqwy0yyfrg7zxksgxk7ufcc084yydhfx43daqqsp59g4z52329g4z52329g4z52329g4z52329g4z52329g4z52329g4q9qrsgqcqzyskhkhqar4dqgqfmarvdttr8x2nrp4txtamfupfftrnn4hmrp7s8ayen7hp2ye58jq8zu65rch9eplpxkhf3pf2nvuynhqxvkw5f7a2vgq486x8x";
    bubble(`pay me here bitcoin:${TB1Q}?amount=0.00001&lightning=${mainnetInvoice}`);
    expect(await screen.findByTestId("onchain-open-wallet")).toHaveAttribute("href", `bitcoin:${TB1Q}?amount=0.00001`);
    expect(screen.queryByTestId("onchain-lightning")).toBeNull();
    expect(document.body.innerHTML).not.toContain("lnbc");
  });

  it.each([
    ["written plainly", `bitcoin:${TB1Q}?amount=0.0001&label=Bob%27s%20(Tue)&message=Thanks!*~`],
    ["percent-encoded", `bitcoin:${TB1Q}?amount=0.0001&label=Bob%27s%20%28Tue%29&message=Thanks%21%2A%7E`],
  ])("a label and message with ' ( ) ! * ~ (%s) make a link the desktop app and the extension open", async (_, text) => {
    const open = vi.fn(async () => {});
    fakeEngine.openPaymentLink = open;
    bubble(text);
    const link = await screen.findByTestId("onchain-open-wallet");
    const uri = `bitcoin:${TB1Q}?amount=0.0001&label=Bob%27s%20%28Tue%29&message=Thanks%21%2A%7E`;
    expect(link).toHaveAttribute("href", uri);
    // The card reads them as they were written.
    expect(document.body.textContent).toContain("Bob's (Tue)");
    // What the extension (apps/extension/src/background.ts) and Desktop (apps/desktop/src/commands.rs is_payment_link)
    // agree to open: anything else is refused, and the person reads "Couldn't open a wallet".
    expect(uri).toMatch(/^(lightning|bitcoin):[A-Za-z0-9?=&%.:_-]{1,4096}$/);
    click(link);
    expect(open).toHaveBeenCalledWith(uri);
  });

  it("on a web page the browser follows the link itself", async () => {
    bubble(BIP21);
    const link = await screen.findByTestId("onchain-open-wallet");
    expect(click(link)).toBe(true);
  });

  it("a wallet that cannot be opened says so beside the link", async () => {
    fakeEngine.openPaymentLink = vi.fn(async () => { throw new Error("Not a payment link"); });
    bubble(BIP21);
    click(await screen.findByTestId("onchain-open-wallet"));
    expect(await screen.findByTestId("onchain-open-wallet-error")).toHaveTextContent("Couldn't open a wallet" + "Copy the text or scan the code instead.");
  });
});

// covers: payments.money.monero-card
describe("a Monero address or monero: link in a message", () => {
  const message = (text: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({ id: "m1", text, sender: "peer", timestamp: 1_700_000_000_000, ...patch });
  const bubble = (text: string, patch: Partial<ChatMessage> = {}) => renderApp(<MessageBubble message={message(text, patch)} peerPubKey="peer" />);

  beforeEach(() => fakeEngine.reset());

  it("shows the amount in XMR, the description, the full address, and Pay opens the link in the person's own wallet", async () => {
    const link = `monero:${XMR_MAINNET}?tx_amount=0.25&recipient_name=Bob&tx_description=Rent%20May`;
    const { user } = bubble(`rent: ${link}`);
    const card = screen.getByTestId("monero-bubble");
    expect(card).toHaveTextContent("Monero");
    expect(within(card).getByTestId("money-network")).toHaveTextContent("Real money");
    expect(within(card).getByTestId("money-amount")).toHaveTextContent("0.25");
    expect(card).toHaveTextContent("XMR");
    expect(card).toHaveTextContent("Bob");
    expect(card).toHaveTextContent("Rent May");
    expect(within(card).getByTestId("money-detail")).toHaveTextContent(XMR_MAINNET);
    expect(screen.getByText("rent:")).toBeInTheDocument();

    // A plain link on the web: the browser hands it to the wallet app.
    const pay = within(card).getByTestId("monero-pay");
    expect(pay).toHaveTextContent("Pay");
    expect(pay).toHaveAttribute("href", `monero:${XMR_MAINNET}?tx_amount=0.25&recipient_name=Bob&tx_description=Rent%20May`);
    expect(pay).not.toHaveAttribute("target");

    // No wallet, no keys, nothing asked of the engine.
    expect(fakeEngine.callsTo("preparePayment")).toHaveLength(0);
    expect(screen.queryByTestId("money-off")).toBeNull();

    // Why Pay leaves the app, behind the ⓘ.
    expect(within(card).queryByTestId("monero-info-text")).toBeNull();
    await user.click(within(card).getByTestId("monero-info"));
    expect(within(card).getByTestId("monero-info-text")).toHaveTextContent("Ghostly has no Monero wallet");
    expect(within(card).getByTestId("monero-info")).toHaveAttribute("aria-expanded", "true");
  });

  it("on Desktop and the extension, Pay asks the platform to open the link", async () => {
    const open = vi.fn(async () => {});
    fakeEngine.openPaymentLink = open;
    bubble(XMR_MAINNET);
    const pay = await screen.findByTestId("monero-pay");
    expect(fireEvent.click(pay)).toBe(false);
    expect(open).toHaveBeenCalledWith(`monero:${XMR_MAINNET}`);
  });

  it("says the network in words when it is not mainnet, with Any amount when the text gives none", () => {
    bubble(XMR_STAGENET_SUBADDRESS);
    const card = screen.getByTestId("monero-bubble");
    expect(card).toHaveAttribute("data-network", "testnet");
    expect(within(card).getByTestId("money-network")).toHaveTextContent("Test money· stagenet");
    expect(card).toHaveTextContent("Any amount");
  });

  it("offers no Pay on my own message, and copies the address", async () => {
    const { user } = bubble(XMR_MAINNET, { sender: "me" });
    const card = screen.getByTestId("monero-bubble");
    expect(within(card).queryByTestId("monero-pay")).toBeNull();
    // The ⓘ only explains Pay: no Pay, no ⓘ.
    expect(within(card).queryByTestId("monero-info")).toBeNull();
    await user.click(within(card).getByRole("button", { name: "Copy address" }));
    expect(await navigator.clipboard.readText()).toBe(XMR_MAINNET);
  });

  it("is text, not a card, when the checksum is wrong", () => {
    bubble(`send to ${corrupt(XMR_MAINNET)}`);
    expect(screen.queryByTestId("monero-bubble")).toBeNull();
  });

  it("is said in the app's language, the amount written its way", async () => {
    const { user } = renderApp(<MessageBubble message={message(`monero:${XMR_MAINNET}?tx_amount=1.5`)} peerPubKey="peer" />, { language: "pt" });
    const pay = await screen.findByTestId("monero-pay");
    expect(pay).toHaveTextContent("Pagar");
    expect(pay).toHaveAttribute("title", "Abre sua carteira Monero neste aparelho");
    expect(screen.getByTestId("money-amount")).toHaveTextContent("1,5");
    await user.click(screen.getByTestId("monero-info"));
    expect(screen.getByTestId("monero-info-text")).toHaveTextContent("O Ghostly não tem carteira Monero");
  });
});
