import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import type { ChatMessage } from "../../lib/types";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";
import { TB1Q, bolt12Offer } from "./moneyFormatFixtures";

// covers: payments.money.onchain-card, payments.money.bolt12-card, payments.uri

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

describe("Open in wallet on a payment in a message", () => {
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

  it("on a web page the browser follows the link itself", async () => {
    bubble(BIP21);
    const link = await screen.findByTestId("onchain-open-wallet");
    expect(click(link)).toBe(true);
  });

  it("a wallet that cannot be opened says so beside the link", async () => {
    fakeEngine.openPaymentLink = vi.fn(async () => { throw new Error("Not a payment link"); });
    bubble(BIP21);
    click(await screen.findByTestId("onchain-open-wallet"));
    expect(await screen.findByTestId("onchain-open-wallet-error")).toHaveTextContent("Could not open a wallet: Not a payment link");
  });
});
