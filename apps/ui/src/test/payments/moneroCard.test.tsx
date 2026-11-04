import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import type { ChatMessage } from "../../lib/types";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";
import { XMR_MAINNET, XMR_STAGENET_SUBADDRESS, corrupt } from "./moneyFormatFixtures";

// covers: payments.money.monero-card

const message = (text: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({ id: "m1", text, sender: "peer", timestamp: 1_700_000_000_000, ...patch });
const bubble = (text: string, patch: Partial<ChatMessage> = {}) => renderApp(<MessageBubble message={message(text, patch)} peerPubKey="peer" />);

beforeEach(() => fakeEngine.reset());

describe("a Monero address or monero: link in a message", () => {
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
