// The engine sends its whole state anew on every change (up to 20 a second while a file moves). A group's open ⚡ sheet
// draws again only when what it shows changes, as the open group (groupStateRedraw.test.tsx) and its members panel
// (groupMembersRedraw.test.tsx) do: with a community's 256 members, a state that changes none of their links drew every
// row again, or the whole payment form while its amount was typed.
import { Profiler } from "react";
import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GroupMemberView } from "@ghostly/browser/shared/types";
import { GroupPaymentComposer } from "../../components/GroupPaymentComposer";
import { NewGroupDialog } from "../../components/NewGroupDialog";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { everyWallet } from "../payments/fixtures";

// covers: groups.community.payments.member, groups.create

const MEMBERS = 256;
const key = (i: number) => `m${i}`.padEnd(52, "y");
const member = (i: number): GroupMemberView => ({ key: key(i), role: i === 1 ? "admin" : "member", me: i === 0, online: false, missing: 0, nick: `Member ${i}` });
const none = { cashu: false, lightning: false, arkade: false, bark: false, spark: false, bitcoin: false, usdt: false, fedimint: false };
const group = groupView({ id: "group-1", profile: "community", status: "active", epoch: 1, myKey: key(0), community: { hub: false, hubs: 2, connected: 1 },
  members: Array.from({ length: MEMBERS }, (_, i) => member(i)) });
/**
 * The community, each member's link through it (all take Cashu and Lightning, but `refuses`), another group's edge and
 * a file moving: each a new object, as every state of the engine brings them.
 */
const state = (patch: { transfer?: number; refuses?: number } = {}) => ({
  groups: [group],
  edges: [
    ...Array.from({ length: MEMBERS - 1 }, (_, i) => i + 1).map(i => linkView({ id: `cpay:group-1:${key(i)}`, peerPubKeyZ32: key(i),
      capabilities: i === patch.refuses ? { files: false, payments: false, methods: none } : { files: false, payments: true, methods: { ...none, cashu: true, lightning: true } } })),
    linkView({ id: "edge-other", peerPubKeyZ32: "other".padEnd(52, "y"), dataLink: "open" }),
  ],
  wallet: everyWallet(),
  ...(patch.transfer !== undefined && { transfers: { [`t${patch.transfer}`]: { bytes: patch.transfer } } }),
});

function sheet() {
  fakeEngine.on("groupPaymentHello", () => undefined).update(state() as never);
  const counter = { draws: 0 };
  const view = renderApp(
    <Profiler id="pay" onRender={() => { counter.draws++; }}>
      <GroupPaymentComposer group={group} onClose={() => {}} />
    </Profiler>,
  );
  return { ...view, counter };
}

describe("an engine state that changes nothing of a group's open ⚡ sheet", () => {
  it("draws its 256 members' list not at all; a member's link changing still updates their row", () => {
    const { counter } = sheet();
    expect(screen.getAllByTestId("group-pay-recipient")).toHaveLength(MEMBERS - 1);

    counter.draws = 0;
    for (let i = 0; i < 200; i++) act(() => fakeEngine.update(state({ transfer: i }) as never));
    expect(counter.draws).toBe(0);

    // Member 7's app now says it takes nothing this device allows: their row says so and cannot be chosen.
    act(() => fakeEngine.update(state({ refuses: 7 }) as never));
    expect(counter.draws).toBeGreaterThan(0);
    const row = screen.getAllByTestId("group-pay-recipient").find(r => r.dataset.key === key(7))!;
    expect(row).toBeDisabled();
    expect(row).toHaveTextContent("They take no way of paying you allow");
    expect(screen.getAllByTestId("group-pay-recipient").filter(r => (r as HTMLButtonElement).disabled)).toHaveLength(1);
  });

  it("with a member picked, draws the payment form not at all while its amount is typed", async () => {
    const { user, counter } = sheet();
    await user.click(screen.getAllByTestId("group-pay-recipient")[4]);
    expect(screen.getByTestId("payment-composer")).toHaveTextContent("with Member 5");
    await user.click(screen.getByTestId("payment-use"));
    await user.type(screen.getByTestId("payment-amount"), "2");

    counter.draws = 0;
    for (let i = 0; i < 200; i++) act(() => fakeEngine.update(state({ transfer: i }) as never));
    expect(counter.draws).toBe(0);

    // The typing goes on where it was.
    await user.type(screen.getByTestId("payment-amount"), "1");
    expect(screen.getByTestId("payment-amount")).toHaveValue("21");
  });
});

describe("an engine state that changes nothing of the new group dialog", () => {
  it("draws it not at all; the app losing its group links still says so", () => {
    fakeEngine.update(state() as never);
    let draws = 0;
    renderApp(
      <Profiler id="new-group" onRender={() => { draws++; }}>
        <NewGroupDialog onClose={vi.fn()} onCreated={vi.fn()} />
      </Profiler>,
    );
    expect(screen.getByTestId("new-group-create")).toBeInTheDocument();

    draws = 0;
    for (let i = 0; i < 50; i++) act(() => fakeEngine.update(state({ transfer: i }) as never));
    expect(draws).toBe(0);

    act(() => fakeEngine.update({ transport: { protocol: "webrtc/1", relays: [], groupLinks: false } } as never));
    expect(draws).toBeGreaterThan(0);
  });
});
