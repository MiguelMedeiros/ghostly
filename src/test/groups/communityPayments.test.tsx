import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { GroupMemberView, GroupView } from "@ghostly/browser/shared/types";
import { GroupPaymentComposer } from "../../components/GroupPaymentComposer";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView, linkView, type StatePatch } from "../fakeEngine";
import { renderApp } from "../render";
import { everyWallet } from "../payments/fixtures";

// covers: groups.community.payments.member, groups.community.payments.group-request

/**
 * ⚡ in a community group: members have no edge to each other, so nobody is "not reachable": a payment goes through
 * the group, sealed to them, now or when they are back. The composer asks their app what it takes.
 */
const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y"), BOB = "bob".padEnd(52, "y"), CAROL = "carol".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: false, missing: 0, ...patch });
const members = [member({ key: ME, me: true }), member({ key: ALICE, nick: "Alice", role: "admin" }), member({ key: BOB, nick: "Bob" }), member({ key: CAROL, nick: "Carol" })];
const group = (patch: Partial<GroupView> = {}) => groupView({ profile: "community", status: "active", epoch: 1, myKey: ME, members, community: { hub: false, hubs: 2, connected: 1 }, ...patch });
const none = { cashu: false, lightning: false, arkade: false, bark: false, bitcoin: false, usdt: false, fedimint: false };
/** What the engine lists once members said what they take: Carol takes nothing this device allows. */
const edges = [
  linkView({ id: `cpay:group-1:${ALICE}`, peerPubKeyZ32: ALICE, capabilities: { files: false, payments: true, methods: { ...none, cashu: true, lightning: true } } }),
  linkView({ id: `cpay:group-1:${CAROL}`, peerPubKeyZ32: CAROL, capabilities: { files: false, payments: false, methods: none } }),
];

function composer(state: StatePatch = {}) {
  fakeEngine.setState({ groups: [group()], edges, wallet: everyWallet(), ...state });
  fakeEngine.on("groupPaymentHello", () => undefined);
  return renderApp(<GroupPaymentComposer group={group()} onClose={() => {}} />);
}

describe("GroupPaymentComposer in a community", () => {
  it("every member can be chosen, away or not; only one who takes nothing says so", () => {
    composer();
    const rows = screen.getAllByTestId("group-pay-recipient");
    expect(rows.map(r => r.dataset.key)).toEqual([ALICE, BOB, CAROL]);
    expect(rows[0]).toBeEnabled();
    // Bob has not said what he takes yet: Cashu and Lightning until he does.
    expect(rows[1]).toBeEnabled();
    expect(rows[2]).toBeDisabled();
    expect(rows[2]).toHaveTextContent("They take no way of paying you allow");
    expect(screen.getByTestId("group-pay-recipients")).toHaveTextContent("sealed to the two of you");
  });

  it("asks the member's app what it takes, and a request goes through the group's link to them", async () => {
    const { user, engine } = composer();
    engine.on("requestPayment", () => ({ paymentId: "r1" }));
    await user.click(screen.getAllByTestId("group-pay-recipient")[1]);
    expect(engine.callsTo("groupPaymentHello")).toEqual([{ groupId: "group-1", member: BOB }]);
    expect(screen.getByTestId("payment-composer")).toHaveTextContent("with Bob");
    await user.click(screen.getByTestId("payment-use"));
    await user.type(screen.getByTestId("payment-amount"), "21");
    await user.click(screen.getByTestId("payment-request"));
    expect(engine.callsTo("requestPayment")).toEqual([expect.objectContaining({ linkId: `cpay:group-1:${BOB}`, amount: 21, rail: "cashu" })]);
  });

  it("the page offers ⚡ in a community", async () => {
    fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined);
    fakeEngine.update({ groups: [group()], edges, wallet: everyWallet() });
    renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
    expect(await screen.findByTestId("payment-button")).toBeEnabled();
  });
});
