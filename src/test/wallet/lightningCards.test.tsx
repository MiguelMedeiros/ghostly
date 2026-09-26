import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LightningCardView } from "@ghostly/browser/engine/paymentAdapters/providers/lightningCards";
import type { NetworkWalletsView, PaymentView, WalletInstanceView, WalletView } from "@ghostly/browser/shared/types";
import { Wallet } from "../../pages/Wallet";
import { PaymentBubble } from "../../components/PaymentBubble";
import { PaymentComposer } from "../../components/PaymentComposer";
import { rememberRail } from "../../lib/chatPayments";
import { fakeEngine, linkView, paymentView, walletView } from "../fakeEngine";
import { renderApp } from "../render";
import { lightningSource, REGTEST_INVOICE, reviewContext } from "../payments/fixtures";
import { offered } from "./descriptors";
import { choose } from "../select";

// covers: wallet.lightning.cards, wallet.instances.create

/** One Lightning card of Testnet, as the engine lists it. */
const lnCard = (card: string, name: string, patch: Partial<LightningCardView> = {}): LightningCardView =>
  ({ ...lightningSource({ mode: "testnet", network: "regtest", providerId: "nwc", label: "Nostr Wallet Connect", balance: 5_000, offered: offered("lightning", "testnet") }), card, name, receive: false, ...patch });
const empty = (): NetworkWalletsView => ({ mints: [], balance: 0, history: [], feesPaid: 0 });
/** A profile with these Lightning cards on Testnet, and nothing else. */
function withCards(...cards: LightningCardView[]): WalletView {
  const receiving = cards.find((c) => c.receive) ?? cards[0];
  return walletView({ networks: { mainnet: empty(), testnet: { ...empty(), lightning: receiving, lightnings: cards } } });
}
const home = () => lnCard("home", "Home (LND)", { providerId: "lnd", label: "LND node", receive: true, balance: 9_000 });
const office = () => lnCard("ln-0ff1ce00", "Alby Hub (NWC)", { alias: "Alby Hub", balance: 50 });

describe("several Lightning cards on a network", () => {
  it("each is a card of its own, named; the default for receiving says so; a network's only one is its Lightning", async () => {
    const { engine } = renderApp(<Wallet />);
    engine.update({ wallet: withCards(home(), office()) });
    const deck = await screen.findByRole("tablist", { name: "Testnet wallets" });
    expect(within(deck).getAllByRole("tab").map((t) => t.dataset.testid)).toEqual(["wallet-card-lightning-testnet-home", "wallet-card-lightning-testnet-ln-0ff1ce00"]);
    const first = screen.getByTestId("wallet-card-lightning-testnet-home"), second = screen.getByTestId("wallet-card-lightning-testnet-ln-0ff1ce00");
    expect(first).toHaveTextContent("Home (LND)");
    expect(within(first).getByTestId("wallet-card-tag")).toHaveTextContent("Default");
    expect(second).toHaveTextContent("Alby Hub (NWC)");
    expect(within(second).queryByTestId("wallet-card-tag")).not.toBeInTheDocument();

    engine.update({ wallet: withCards(home()) });
    expect(await screen.findByTestId("wallet-card-lightning-testnet")).toHaveTextContent("Lightning");
    expect(screen.queryByTestId("wallet-card-tag")).not.toBeInTheDocument();
    expect(screen.queryByTestId("lightning-card")).not.toBeInTheDocument();
  });

  it("a card is made the default and renamed from its own settings; its source is its own (no picker)", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: withCards(home(), office()) });
    engine.on("lightningSetReceive", () => undefined).on("lightningRename", () => undefined);
    await user.click(await screen.findByTestId("wallet-card-lightning-testnet-ln-0ff1ce00"));
    const settings = await screen.findByTestId("lightning-card");
    const toggle = within(settings).getByTestId("lightning-card-default");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(toggle);
    expect(engine.callsTo("lightningSetReceive")).toEqual([{ network: "testnet", card: "ln-0ff1ce00" }]);
    const name = within(settings).getByTestId("lightning-card-name");
    await user.clear(name);
    await user.type(name, "Office wallet");
    await user.click(within(settings).getByTestId("lightning-card-rename"));
    expect(engine.callsTo("lightningRename")).toEqual([{ network: "testnet", card: "ln-0ff1ce00", name: "Office wallet" }]);
    expect(screen.queryByTestId("lightning-source-select")).not.toBeInTheDocument();
    expect(screen.getByTestId("lightning-source-current")).toHaveTextContent("Nostr Wallet Connect");

    // The default one shows its switch on, and it cannot be turned off (another card is made the default instead).
    await user.click(screen.getByTestId("wallet-card-lightning-testnet-home"));
    expect(await screen.findByTestId("lightning-card-default")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("lightning-card-default")).toBeDisabled();
  });

  it("New adds another Lightning card, and brings it to the front, selected", async () => {
    const { user, engine } = renderApp(<Wallet />);
    engine.update({ wallet: withCards(home()) });
    const made: WalletInstanceView = { id: "lightning:testnet:ln-0ff1ce00", type: "lightning", network: "testnet", config: { providerId: "nwc" }, card: "ln-0ff1ce00", name: "Alby Hub (NWC)", receive: false };
    engine.on("walletCreate", () => { engine.update({ wallet: withCards(home(), office()) }); return made; });
    await user.click(await screen.findByTestId("wallet-add"));
    await user.click(screen.getByTestId("new-wallet-network-testnet"));
    expect(screen.getByTestId("new-wallet-type-lightning-status")).toHaveTextContent("Add another…");
    await user.click(screen.getByTestId("new-wallet-type-lightning"));
    const form = await screen.findByTestId("new-wallet-provider");
    await choose(user, within(form).getByRole("combobox", { name: "Source" }), "nwc");
    await user.type(within(form).getByLabelText("Connection URI"), "nostr+walletconnect://office");
    await user.click(within(form).getByTestId("provider-save"));
    expect(engine.callsTo("walletCreate")).toEqual([{ type: "lightning", network: "testnet", providerId: "nwc", values: expect.objectContaining({ uri: "nostr+walletconnect://office" }) }]);
    await waitFor(() => expect(screen.queryByTestId("new-wallet")).not.toBeInTheDocument());
    expect(screen.getByTestId("wallet-card-lightning-testnet-ln-0ff1ce00")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("wallet-card-lightning-testnet-home")).toHaveAttribute("aria-selected", "false");
  });
});

describe("in a chat", () => {
  it("the Pay deck shows each Lightning card; a request on one carries that card's invoice; Accept keeps one Lightning switch", async () => {
    fakeEngine.setState({ links: [linkView()], wallet: withCards(home(), office()) });
    rememberRail("peer", "lightning:testnet:ln-0ff1ce00");
    const onRequest = vi.fn(async () => null);
    const { user } = renderApp(<PaymentComposer balance={0} onSend={vi.fn(async () => null)} onRequest={onRequest} onClose={vi.fn()} reviewContext={reviewContext()} contact="Alice" onSaveMethods={vi.fn(async () => {})} />);
    expect(screen.getAllByRole("radio").map((r) => r.dataset.testid)).toEqual(["payment-card-lightning-testnet-home", "payment-card-lightning-testnet-ln-0ff1ce00"]);
    expect(screen.getByTestId("payment-card-lightning-testnet-ln-0ff1ce00")).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByTestId("payment-use"));
    await user.type(screen.getByTestId("payment-amount"), "21");
    await user.click(screen.getByTestId("payment-request"));
    expect(onRequest).toHaveBeenCalledWith(21, "", "cashu", "lightning", "testnet", "ln-0ff1ce00");
  });

  it("Accept shows one Lightning card per network: the chat's switch, whatever card receives", async () => {
    fakeEngine.setState({ links: [linkView()], wallet: withCards(home(), office()) });
    const { user } = renderApp(<PaymentComposer balance={0} onSend={vi.fn(async () => null)} onRequest={vi.fn(async () => null)} onClose={vi.fn()} reviewContext={reviewContext()} contact="Alice" onSaveMethods={vi.fn(async () => {})} />);
    await user.click(screen.getByTestId("payment-mode-accept"));
    expect(screen.getAllByRole("switch").map((r) => r.dataset.testid)).toEqual(["payment-accept-lightning-testnet"]);
  });

  it("a contact's request is paid with the card picked: the first eligible one to start with", async () => {
    const request: Partial<PaymentView> = { kind: "request", direction: "in", amount: 100, invoice: REGTEST_INVOICE, network: "testnet" };
    fakeEngine.setState({ links: [linkView()], wallet: withCards(lnCard("low", "Low (NWC)", { balance: 10, receive: true }), home()), payments: { "pay-1": paymentView(request) } });
    const { user, engine } = renderApp(<PaymentBubble paymentId="pay-1" peerPubKey="peer" fallbackText="[a payment]" />);
    engine.on("walletQuoteInvoice", () => ({ quote: "q-1", mint: "", amount: 100, feeReserve: 3, source: "lnd" })).on("payRequest", () => undefined);
    // The first card that holds enough, not the first card.
    const pick = screen.getByRole("combobox", { name: "Lightning card" });
    expect(pick).toHaveTextContent("Home (LND)");
    await user.click(screen.getByRole("button", { name: "Review payment" }));
    expect(engine.callsTo("walletQuoteInvoice")).toEqual([{ invoice: REGTEST_INVOICE, via: undefined, network: "testnet", card: "home" }]);
    expect(await screen.findByTestId("payment-review")).toHaveTextContent("Through Home (LND)");
    await user.click(screen.getByRole("button", { name: "Approve payment" }));
    expect(engine.callsTo("payRequest")).toEqual([expect.objectContaining({ paymentId: "pay-1", via: "lightning", network: "testnet", card: "home" })]);
  });
});
