import { screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { fakeInvoice } from "@ghostly/browser/engine/paymentAdapters/providers/testing";
import type { GroupMemberView, StoredMessage } from "@ghostly/browser/shared/types";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { lightningSource, TEST_MINT } from "./fixtures";

// covers: wallet.testnet.receive-held

/**
 * A test mint's Receive invoice counts only once a payer says it paid it (the engine's held quote). Pasted in a group and
 * paid from its card there, the member who wrote it is told over our chat with them, when they are a contact.
 */

const BOB = "bob".padEnd(52, "y"), ME = "me".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });

async function payInGroup(memberLinks: Record<string, string>) {
  const invoice = fakeInvoice(25, new Uint8Array(32).fill(9));
  const message: StoredMessage = { linkId: "group:group-1", id: "g1", text: invoice, sender: "peer", member: BOB, timestamp: Date.now(), via: "datalink" };
  fakeEngine.on("groupMessages", () => [message]).on("updateSettings", () => undefined).on("setGroupTyping", () => undefined);
  fakeEngine.update({
    links: [linkView({ id: "link-bob", peerPubKeyZ32: "bob-contact" })],
    groups: [groupView({ status: "active", epoch: 1, members: [member({ key: ME, me: true }), member({ key: BOB, nick: "Bob" })], memberLinks })],
    wallet: { lightning: lightningSource({ mode: "testnet", providerId: "fake-lightning" }) },
  });
  const view = renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
  view.engine.on("walletQuoteInvoice", () => ({ quote: "melt-1", mint: TEST_MINT, amount: 25, feeReserve: 0, source: "cashu-mint" })).on("walletPayQuote", () => ({ paid: true }));
  await view.user.click(within(await screen.findByTestId("invoice-bubble")).getByTestId("invoice-pay"));
  await view.user.click(await screen.findByTestId("invoice-confirm"));
  expect(await screen.findByTestId("invoice-paid")).toBeInTheDocument();
  return { calls: view.engine.callsTo("walletPayQuote"), invoice };
}

describe("a Testnet invoice paid from its card in a group", () => {
  it("names our chat with the member who wrote it, so they are told", async () => {
    const { calls, invoice } = await payInGroup({ "link-bob": BOB });
    expect(calls).toEqual([{ quote: "melt-1", mint: TEST_MINT, linkId: "link-bob", invoice }]);
  });

  it("names no chat when the member who wrote it is not a contact", async () => {
    const { calls } = await payInGroup({});
    expect(calls).toEqual([{ quote: "melt-1", mint: TEST_MINT }]);
  });
});
