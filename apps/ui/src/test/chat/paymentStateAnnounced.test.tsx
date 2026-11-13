import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupPayNote } from "@ghostly/browser/shared/types";
import { ANNOUNCE_CLEAR_MS, ANNOUNCE_WINDOW_MS, MessageAnnouncer, type Announceable } from "../../components/chat/MessageAnnouncer";
import type { Language } from "../../lib/settings";
import { fakeEngine, paymentView } from "../fakeEngine";
import { TEST_MINT } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: app.accessibility, payments.chat.refused, groups.payments.notes

// A payment's state line in its bubble changed (my request Paid, my ecash Received or Taken back, a group's note paid)
// with no live region anywhere: a screen reader was never told, so who asked for money did not hear it was paid.

const nameOf = () => "Alice";
const HISTORY: Announceable[] = [{ id: "h1", sender: "peer", text: "an old one" }, { id: "h2", sender: "me", text: "my old one" }];
const request = (state: string, patch = {}) => paymentView({ id: "pay-1", kind: "request", direction: "out", amount: 1_000, network: "testnet", mints: [TEST_MINT], state, ...patch } as never);
const sent = (state: string, patch = {}) => paymentView({ id: "pay-2", kind: "payment", direction: "out", amount: 1_200, network: "testnet", mints: [TEST_MINT], state, ...patch } as never);
const PAYMENTS: Announceable[] = [...HISTORY, { id: "r1", sender: "me", text: "⚡ Requested 1,000 test sats", paymentId: "pay-1" }, { id: "s1", sender: "me", text: "⚡ 1,200 test sats", paymentId: "pay-2" }];

let heard: string[] = [];
let observer: MutationObserver | null = null;
const region = () => screen.getByTestId("chat-announcement");
const flush = () => act(async () => { await Promise.resolve(); });
const wait = async (ms: number) => {
  for (let left = ms; left > 0; left -= 100) { act(() => { vi.advanceTimersByTime(Math.min(100, left)); }); await flush(); }
};
const listen = () => {
  heard = [];
  observer = new MutationObserver(() => { const text = region().textContent ?? ""; if (text) heard.push(text); });
  observer.observe(region(), { childList: true, characterData: true, subtree: true });
};
const payments = (...list: ReturnType<typeof paymentView>[]) => act(() => { fakeEngine.update({ payments: Object.fromEntries(list.map(p => [p.id, p])) }); });

function setup(messages: readonly Announceable[], language?: Language, active = true) {
  const view = renderApp(<MessageAnnouncer chat="c" messages={messages} nameOf={nameOf} active={active} />, language ? { language } : undefined);
  listen();
  return view;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  observer?.disconnect();
  observer = null;
  vi.useRealTimers();
});

describe("a payment's state that changes while the chat is open, read out to a screen reader", () => {
  it("my request turning Paid is said once, politely, with what it was", async () => {
    payments(request("pending"), sent("pending"));
    setup(PAYMENTS);
    payments(request("settled"), sent("pending"));
    await wait(ANNOUNCE_CLEAR_MS + 200);
    expect(heard).toEqual(["⚡ You requested 1,000 test sats · Paid"]);
    expect(region()).toHaveAttribute("aria-live", "polite");
    expect(region()).toHaveTextContent("");
  });

  it("ecash I sent turning Received, then a Taken back one with its reason, each once", async () => {
    payments(request("pending"), sent("pending"));
    setup(PAYMENTS);
    payments(request("pending"), sent("settled"));
    await wait(ANNOUNCE_CLEAR_MS + 200);
    payments(request("pending"), sent("reclaimed", { error: "Your contact's wallet refused it" }));
    await wait(ANNOUNCE_CLEAR_MS + 200);
    expect(heard).toEqual(["⚡ You sent 1,200 test sats · Received", "⚡ You sent 1,200 test sats · Taken back · Your contact's wallet refused it"]);
  });

  it("a request's Lightning payment going from pending to paid is said at each step", async () => {
    payments(request("pending"), sent("pending"));
    setup(PAYMENTS);
    payments(request("pending", { lightningPending: true }), sent("pending"));
    await wait(ANNOUNCE_CLEAR_MS + 200);
    payments(request("settled"), sent("pending"));
    await wait(ANNOUNCE_CLEAR_MS + 200);
    expect(heard).toEqual(["⚡ You requested 1,000 test sats · Lightning payment pending…", "⚡ You requested 1,000 test sats · Paid"]);
  });

  it("nothing is said as the chat opens, on a redraw that changes nothing, or as the wallet first knows the payment", async () => {
    payments();
    const view = setup(PAYMENTS);
    payments(request("settled"), sent("failed"));
    await wait(ANNOUNCE_WINDOW_MS * 2);
    payments(request("settled", { createdAt: 5 }), sent("failed"));
    view.rerender(<MessageAnnouncer chat="c" messages={PAYMENTS.map(m => ({ ...m }))} nameOf={nameOf} />);
    await wait(ANNOUNCE_WINDOW_MS * 2);
    expect(heard).toEqual([]);
  });

  it("a payment that arrives: its arrival is said, not its first state", async () => {
    payments(request("pending"));
    const view = setup(HISTORY);
    payments(request("pending"), paymentView({ id: "pay-3", kind: "payment", direction: "in", amount: 50, network: "testnet", mints: [TEST_MINT], state: "settled" } as never));
    view.rerender(<MessageAnnouncer chat="c" messages={[...HISTORY, { id: "p3", sender: "peer", text: "⚡ 50 test sats", paymentId: "pay-3" }]} nameOf={nameOf} />);
    await wait(ANNOUNCE_WINDOW_MS + ANNOUNCE_CLEAR_MS + 200);
    expect(heard).toEqual(["Alice: ⚡ Sent you 50 test sats"]);
  });

  it("a chat kept open behind another one says nothing", async () => {
    payments(request("pending"), sent("pending"));
    setup(PAYMENTS, undefined, false);
    payments(request("settled"), sent("pending"));
    await wait(ANNOUNCE_WINDOW_MS * 2);
    expect(heard).toEqual([]);
  });

  it("is said in the person's language", async () => {
    payments(request("pending"), sent("pending"));
    setup(PAYMENTS, "pt");
    payments(request("settled"), sent("pending"));
    await wait(ANNOUNCE_CLEAR_MS + 200);
    expect(heard).toEqual(["⚡ Você pediu 1.000 sats de teste · Pago"]);
  });
});

const note = (patch: Partial<GroupPayNote> = {}): GroupPayNote =>
  ({ id: "n1", kind: "request", from: "*", to: "alice", amount: "1000", unit: "sat", decimals: 0, rail: "cashu", test: true, createdAt: 0, state: "open", ...patch });
const noteLine = (n: GroupPayNote) => `${n.state}${n.claims ? ` ${n.claims.join()}` : ""}${n.by ? ` by ${n.by}` : ""}`;

describe("a group's payment note that changes where it stands", () => {
  const rows = (n: GroupPayNote): Announceable[] => [...HISTORY, { id: "g1", sender: "peer", text: "", member: "alice", groupPay: n }];
  const draw = (n: GroupPayNote, view?: ReturnType<typeof renderApp>) => {
    const ui = <MessageAnnouncer chat="g" messages={rows(n)} nameOf={nameOf} noteLine={noteLine} />;
    if (view) { view.rerender(ui); return view; }
    const drawn = renderApp(ui);
    listen();
    return drawn;
  };

  it("each step is said once, in the group's words; the same step drawn again is not", async () => {
    const view = draw(note());
    draw(note({ state: "sent", claims: ["bob"] }), view);
    await wait(ANNOUNCE_CLEAR_MS + 200);
    draw(note({ state: "sent", claims: ["bob"] }), view);
    await wait(ANNOUNCE_CLEAR_MS + 200);
    draw(note({ state: "paid", claims: ["bob"], by: "bob" }), view);
    await wait(ANNOUNCE_CLEAR_MS + 200);
    expect(heard).toEqual(["sent bob", "paid bob by bob"]);
  });

  it("a note that arrives is said in the group's words, not the engine's English line", async () => {
    const view = renderApp(<MessageAnnouncer chat="g" messages={HISTORY} nameOf={nameOf} noteLine={noteLine} />);
    listen();
    view.rerender(<MessageAnnouncer chat="g" messages={[...HISTORY, { id: "g1", sender: "peer", text: "⚡ Requested 21 test sats", member: "alice", groupPay: note({ amount: "21" }) }]} nameOf={nameOf} noteLine={noteLine} />);
    await wait(ANNOUNCE_WINDOW_MS + ANNOUNCE_CLEAR_MS + 200);
    expect(heard).toEqual(["Alice: open"]);
  });

  it("a note already paid as the group opens is not said", async () => {
    const view = draw(note({ state: "paid", by: "bob" }));
    draw(note({ state: "paid", by: "bob" }), view);
    await wait(ANNOUNCE_WINDOW_MS * 2);
    expect(heard).toEqual([]);
  });
});
