import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import type { ChatMessage } from "../../lib/types";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";
import { MAINNET_INVOICE } from "./fixtures";
import { TB1Q, arkadeAddress, bolt12Offer } from "./moneyFormatFixtures";

// covers: payments.money.onchain-card, payments.money.bolt12-card

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

describe("Copy on money in a message", () => {
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
