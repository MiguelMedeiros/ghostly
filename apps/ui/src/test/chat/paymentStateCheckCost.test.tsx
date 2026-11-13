import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageAnnouncer, type Announceable } from "../../components/chat/MessageAnnouncer";
import { fakeEngine, paymentView } from "../fakeEngine";
import { TEST_MINT } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: app.accessibility

// The chat's announcer worked out every payment's state line again at every engine state, though the client keeps a
// payment's view as it was until a payment changes: a chat with 1,000 payments spent ~23 ms of each state on it.

const N = 50;

describe("an open chat's payments, at an engine state that changes none of them", () => {
  it("are not read again", () => {
    let reads = 0;
    const list = Array.from({ length: N }, (_, i) => {
      const view = paymentView({ id: `pay-${i}`, kind: "request", direction: "out", amount: 1_000 + i, network: "testnet", mints: [TEST_MINT], state: "pending" } as never);
      // Every state line starts from the payment's state: a read of it is a line worked out again.
      return Object.defineProperty({ ...view }, "state", { get: () => { reads++; return "pending"; }, enumerable: true });
    });
    act(() => { fakeEngine.update({ payments: Object.fromEntries(list.map(p => [p.id, p])) }); });
    const rows: Announceable[] = list.map((p, i) => ({ id: `m${i}`, sender: "me", text: "⚡ Requested 1,000 test sats", paymentId: p.id }));
    renderApp(<MessageAnnouncer chat="c" messages={rows} nameOf={() => "Alice"} />);
    reads = 0;
    for (let i = 0; i < 10; i++) act(() => { fakeEngine.update({ typing: { [`x${i}`]: true } } as never); });
    expect(reads).toBe(0);
  });
});
