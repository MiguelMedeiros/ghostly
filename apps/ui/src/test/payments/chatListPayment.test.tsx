import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PaymentView } from "@ghostly/browser/shared/types";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { fakeEngine, paymentView } from "../fakeEngine";
import { renderApp } from "../render";
import { TEST_MINT } from "./fixtures";

// covers: chats.list.rows, payments.cashu.test-sats

/**
 * A chat whose last message is a payment or a request: its line in the chat list says what the bubble says, in the
 * app's language, test sats as test sats. The engine keeps an English line with the message (for the CLI and older
 * apps), which is not what a person reads here.
 */

const NOW = Date.now();
const PEER = "p".repeat(52);
const session = (text: string, sender: "me" | "peer"): ChatSession =>
  ({ id: "c", profile: "paired-chat/1", mySeedB64: "seed", peerPubKeyB64: PEER, encKeyB64: "enc", nick: "Bob", nickSource: "profile", createdAt: NOW,
    messages: [{ id: `${sender}_${NOW}`, text, sender, timestamp: NOW, paymentId: "pay-1" }] } as ChatSession);
function show(text: string, sender: "me" | "peer", payment: Partial<PaymentView>, language?: "pt" | "en") {
  fakeEngine.setState({ payments: { "pay-1": paymentView(payment) } });
  saveSession(session(text, sender));
  renderApp(<UpdateProvider><Sidebar /></UpdateProvider>, { language });
  return within(screen.getByTestId("chat-row")).getByTestId("chat-row-preview");
}

describe("a payment as the chat list's last line", () => {
  it("a Testnet request from the contact says test sats, not sats", () => {
    const line = show("⚡ Requested 1,234 sats", "peer", { kind: "request", direction: "in", amount: 1_234, network: "testnet", mints: [TEST_MINT] });
    expect(line).toHaveTextContent(/1,234 test sats/);
  });

  it("a Testnet payment I sent says test sats, not sats", () => {
    const line = show("⚡ 21 sats", "me", { kind: "payment", direction: "out", amount: 21, network: "testnet", mint: TEST_MINT });
    expect(line).toHaveTextContent(/21 test sats/);
  });

  it("is in the app's language, with its number format", () => {
    const line = show("⚡ Requested 1,234 test sats", "me", { kind: "request", direction: "out", amount: 1_234, network: "testnet", mints: [TEST_MINT] }, "pt");
    expect(line).toHaveTextContent(/1\.234 sats de teste/);
    expect(line).not.toHaveTextContent("Requested");
  });

  it("a Mainnet payment received says sats", () => {
    const line = show("⚡ 500 sats", "peer", { kind: "payment", direction: "in", amount: 500, network: "mainnet" });
    expect(line).toHaveTextContent(/500 sats/);
    expect(line).not.toHaveTextContent("test");
  });

  it("keeps the stored line while the wallet does not know the payment", () => {
    fakeEngine.setState({ payments: {} });
    saveSession(session("⚡ 21 test sats", "peer"));
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    expect(within(screen.getByTestId("chat-row")).getByTestId("chat-row-preview")).toHaveTextContent("⚡ 21 test sats");
  });
});
