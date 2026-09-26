import { act, screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { GroupMemberView, GroupPayNote, GroupView, StoredMessage } from "@ghostly/browser/shared/types";
import { GroupPaymentComposer } from "../../components/GroupPaymentComposer";
import { GroupChat } from "../../pages/GroupChat";
import { groupPayStatus, groupPayTitle } from "../../lib/groupPayments";
import { fakeEngine, groupView, linkView, paymentView, type StatePatch } from "../fakeEngine";
import { renderApp } from "../render";
import { everyWallet, mint, REAL_MINT, TEST_MINT } from "../payments/fixtures";

// covers: groups.payments.member, groups.payments.group-request, groups.payments.notes, payments.chat.networks

const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y"), BOB = "bob".padEnd(52, "y"), CAROL = "carol".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const edge = (linkId: string, state: "open" | "waiting" = "open") => ({ linkId, state, transport: "webrtc/1" as const, lastSeenAt: 0 });
const members = [
  member({ key: ME, me: true }),
  member({ key: ALICE, nick: "Alice", role: "admin", edge: edge("edge-a") }),
  member({ key: BOB, nick: "Bob", edge: edge("edge-b") }),
  member({ key: CAROL, nick: "Carol", online: false, edge: edge("edge-c", "waiting") }),
];
const group = (patch: Partial<GroupView> = {}) => groupView({ status: "active", epoch: 1, myKey: ME, members, ...patch });
/** The edges' links as the engine shows them: payments negotiated on Alice's, none on Bob's (an older app). */
const edges = [
  linkView({ id: "edge-a", peerPubKeyZ32: "edge-peer-a", capabilities: { files: false, payments: true, methods: { cashu: true, lightning: true, arkade: true, bark: true, spark: true, bitcoin: true, usdt: true, fedimint: true } } }),
  linkView({ id: "edge-b", peerPubKeyZ32: "edge-peer-b", capabilities: { files: false, payments: false, methods: { cashu: false, lightning: false, arkade: false, bark: false, spark: false, bitcoin: false, usdt: false, fedimint: false } } }),
  linkView({ id: "edge-c", peerPubKeyZ32: "edge-peer-c", dataLink: "idle" }),
];

function composer(state: StatePatch = {}) {
  fakeEngine.setState({ groups: [group()], edges, wallet: everyWallet(), ...state });
  let closed = 0;
  const view = renderApp(<GroupPaymentComposer group={group()} onClose={() => { closed++; }} />);
  return { ...view, closed: () => closed };
}

describe("GroupPaymentComposer: whom first", () => {
  it("lists the other members; one who is away or whose app takes no payments says why and cannot be chosen", () => {
    composer();
    const rows = screen.getAllByTestId("group-pay-recipient");
    expect(rows.map(r => r.dataset.key)).toEqual([ALICE, BOB, CAROL]);
    expect(rows[0]).toBeEnabled();
    expect(rows[1]).toBeDisabled();
    expect(rows[1]).toHaveTextContent("needs an update");
    expect(rows[2]).toBeDisabled();
    expect(rows[2]).toHaveTextContent("Not reachable right now");
    expect(screen.getByTestId("group-pay-everyone")).toBeEnabled();
  });

  it("with one member: the chat's cards, and a request goes over the edge to them, on the card's rail and network only", async () => {
    const { user, engine } = composer();
    engine.on("requestPayment", () => ({ paymentId: "r1" }));
    await user.click(screen.getAllByTestId("group-pay-recipient")[0]);
    expect(screen.getByTestId("payment-composer")).toHaveTextContent("with Alice");
    await user.click(screen.getByTestId("payment-use"));
    await user.type(screen.getByTestId("payment-amount"), "21");
    await user.type(screen.getByRole("textbox", { name: "What for? (optional)" }), "tacos");
    await user.click(screen.getByTestId("payment-request"));
    expect(engine.callsTo("requestPayment")).toEqual([expect.objectContaining({ linkId: "edge-a", amount: 21, memo: "tacos", method: "cashu", rail: "cashu", network: "mainnet" })]);
  });

  it("back from the cards to whom", async () => {
    const { user } = composer();
    await user.click(screen.getAllByTestId("group-pay-recipient")[0]);
    await user.click(screen.getByTestId("payment-recipient-change"));
    expect(screen.getAllByTestId("group-pay-recipient")).toHaveLength(3);
  });

  it("the whole group: only Cashu or Lightning, no Send, and the request goes to the group on the chosen rail and network", async () => {
    const { user, engine } = composer();
    engine.on("requestGroupPayment", () => ({ paymentId: "g1" }));
    await user.click(screen.getByTestId("group-pay-everyone"));
    expect(screen.getByTestId("payment-composer")).toHaveTextContent("with the group");
    expect(screen.getByTestId("payment-card-arkade-testnet")).toHaveAttribute("title", "Ark cannot be used here");
    // Choosing a card turns it over.
    await user.click(screen.getByTestId("payment-card-lightning-mainnet"));
    await user.type(screen.getByTestId("payment-amount"), "10");
    expect(screen.getByTestId("payment-send")).toBeDisabled();
    expect(screen.getByText(/one Lightning invoice\. Any member may pay it, once/)).toBeInTheDocument();
    await user.click(screen.getByTestId("payment-request"));
    expect(engine.callsTo("requestGroupPayment")).toEqual([expect.objectContaining({ groupId: "group-1", amount: 10, rail: "lightning", network: "mainnet" })]);
  });

  it("the whole group: a request made on a Testnet card asks the group for test sats", async () => {
    // Cashu on both networks: each card asks on its own.
    const { user, engine } = composer({ wallet: everyWallet({ mints: [mint(REAL_MINT, 500), mint(TEST_MINT, 500)], balance: 500 }) });
    engine.on("requestGroupPayment", () => ({ paymentId: "g1" }));
    await user.click(screen.getByTestId("group-pay-everyone"));
    await user.click(screen.getByTestId("payment-card-cashu-testnet"));
    await user.type(screen.getByTestId("payment-amount"), "10");
    await user.click(screen.getByTestId("payment-request"));
    expect(engine.callsTo("requestGroupPayment")).toEqual([expect.objectContaining({ groupId: "group-1", amount: 10, rail: "cashu", network: "testnet" })]);
  });

  it("says what the engine refused", async () => {
    const { user, engine } = composer();
    engine.on("requestGroupPayment", () => { throw new Error("Nobody else is in the group yet"); });
    await user.click(screen.getByTestId("group-pay-everyone"));
    await user.click(screen.getByTestId("payment-use"));
    await user.type(screen.getByTestId("payment-amount"), "10");
    await user.click(screen.getByTestId("payment-request"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Nobody else is in the group yet");
  });
});

const note = (patch: Partial<GroupPayNote> = {}): GroupPayNote => ({ id: "req-1", kind: "request", from: BOB, to: ALICE, amount: "21", unit: "sat", decimals: 0, rail: "cashu", test: true, memo: "tacos", createdAt: 1_700_000_000_000, state: "open", ...patch });
const line = (patch: Partial<StoredMessage>): StoredMessage => ({ linkId: "group:group-1", id: "m", text: "", sender: "peer", timestamp: 1_700_000_000_000, via: "datalink", ...patch });

function openGroup(history: StoredMessage[], state: StatePatch = {}) {
  fakeEngine.on("groupMessages", () => history).on("updateSettings", () => undefined);
  fakeEngine.update({ groups: [group()], edges, wallet: everyWallet(), ...state });
  return renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
}

describe("GroupChat: payments in the timeline", () => {
  it("a payment between two others is a note: who asked whom, how much, how it stands, and nothing to pay with", async () => {
    openGroup([line({ id: "gpay:req-1", groupPay: note(), member: ALICE })]);
    const shown = await screen.findByTestId("group-pay-note");
    expect(within(shown).getByTestId("group-pay-note-title")).toHaveTextContent("Alice asked Bob");
    expect(shown).toHaveTextContent("21 test sats");
    expect(shown).toHaveTextContent("tacos");
    expect(shown).toHaveAttribute("data-state", "open");
    expect(within(shown).queryByRole("button")).not.toBeInTheDocument();
  });

  it("follows the note: claimed, then paid", async () => {
    const view = openGroup([line({ id: "gpay:req-1", groupPay: note({ claims: [BOB] }) })]);
    expect(await screen.findByTestId("group-pay-note-state")).toHaveTextContent("Bob says they paid · waiting for Alice's wallet");
    act(() => view.engine.messages("group:group-1", [line({ id: "gpay:req-1", groupPay: note({ state: "paid", by: BOB }) })]));
    expect(screen.getByTestId("group-pay-note")).toHaveAttribute("data-state", "paid");
    expect(screen.getByTestId("group-pay-note-state")).toHaveTextContent("Paid");
  });

  it("my own request shows its bubble, captioned once; its note is not shown twice", async () => {
    const payments = { "req-1": paymentView({ id: "req-1", linkId: "edge-a", kind: "request", direction: "out", amount: 21, state: "pending", mints: ["https://mint.example.com"] }),
      "pay-1": paymentView({ id: "pay-1", linkId: "edge-a", kind: "payment", direction: "in", amount: 21, requestId: "req-1", state: "settled" }) };
    openGroup([
      line({ id: "edge-a:me_1", sender: "me", paymentId: "req-1", text: "⚡ Requested 21 sats" }),
      line({ id: "edge-a:peer_2", paymentId: "pay-1", member: ALICE, text: "⚡ 21 sats" }),
      line({ id: "gpay:req-1", groupPay: note({ from: ALICE, to: ME, state: "paid", by: ALICE }) }),
    ], { payments });
    expect(await screen.findAllByTestId("payment-bubble")).toHaveLength(2);
    expect(screen.queryByTestId("group-pay-note")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("group-pay-caption")).toHaveLength(1);
    expect(screen.getByTestId("group-pay-caption")).toHaveTextContent("You asked Alice · Paid");
  });

  it("+ → Payment opens whom-to-pay; with nobody else in the group it says so", async () => {
    const view = openGroup([]);
    await view.user.click(screen.getByTestId("composer-more"));
    // A group offers what groups carry: payments, not files or identities.
    expect(screen.getAllByRole("button").filter((b) => b.hasAttribute("data-menu-item")).map((b) => b.dataset.action)).toEqual(["payment"]);
    await view.user.click(screen.getByTestId("payment-button"));
    expect(screen.getByTestId("group-pay-recipients")).toBeInTheDocument();
    act(() => view.engine.update({ groups: [group({ members: [members[0]] })] }));
    await view.user.click(screen.getByTestId("composer-more"));
    expect(screen.getByTestId("payment-button")).toBeDisabled();
    expect(screen.getByTestId("payment-button")).toHaveAttribute("title", "Nobody else is in the group yet");
    expect(screen.getByTestId("payment-button")).toHaveTextContent("Nobody else is in the group yet");
  });
});

describe("what a note says", () => {
  const g = group();
  it.each<[string, Partial<GroupPayNote>, string, string]>([
    ["a request to one member", {}, "Alice asked Bob", "Waiting for payment"],
    ["a request to the group, paid by someone", { from: "*", state: "paid", by: CAROL }, "Alice asked the group", "Paid by Carol"],
    ["a request to the group, paid by me", { from: "*", state: "paid", by: ME }, "Alice asked the group", "Paid by you"],
    ["a request to the group, paid through an invoice nobody claimed", { from: "*", state: "paid" }, "Alice asked the group", "Paid"],
    ["an ask answered: the payer started it", { ask: true, from: BOB }, "Bob is paying Alice", "Waiting for payment"],
    ["two members say they paid", { from: "*", claims: [BOB, CAROL] }, "Alice asked the group", "Bob, Carol paid · waiting for Alice's wallet"],
    ["a closed request", { state: "closed" }, "Alice asked Bob", "Closed"],
    ["a payment on its way", { kind: "payment", from: BOB, to: ALICE, state: "sent" }, "Bob sent Alice", "Sent · waiting for Alice"],
    ["a payment taken back", { kind: "payment", from: BOB, to: ALICE, state: "closed" }, "Bob sent Alice", "Taken back"],
    ["someone who left", { to: "gone".padEnd(52, "y") }, "A former member asked Bob", "Waiting for payment"],
  ])("%s", (_, patch, title, status) => {
    expect(groupPayTitle(note(patch), g)).toBe(title);
    expect(groupPayStatus(note(patch), g).text).toBe(status);
  });
});
