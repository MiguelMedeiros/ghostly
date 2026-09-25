import { act, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkView, WalletView } from "@ghostly/browser/shared/types";
import { MessageInput } from "../../components/MessageInput";
import { PaymentComposer } from "../../components/PaymentComposer";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { ALL_METHODS_ON, rememberRail, type ChatPaymentMethods } from "../../lib/chatPayments";
import { servicesPlatform } from "../../lib/platform";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { everyWallet, reviewContext } from "./fixtures";

// covers: payments.chat.methods, payments.chat.cards

/**
 * The payment composer's Accept side: which ways of paying one chat takes, chosen on the cards beside Pay. It is the
 * same per-chat list the engine keeps (`setChatPaymentMethods`), and choosing never pays, asks or turns a card over.
 */

const ALL_OFF: ChatPaymentMethods = { cashu: false, lightning: false, arkade: false, bark: false, spark: false, bitcoin: false, fedimint: false, usdt: false };

beforeEach(() => { document.documentElement.dataset.reduceMotion = "true"; });

interface Open {
  link?: Partial<LinkView>;
  wallet?: Partial<WalletView>;
  /** What saving does; by default the engine takes the list, as the real one does, and says so in its state. */
  save?: (methods: ChatPaymentMethods) => Promise<void>;
}

/** The composer in a 1:1 chat with "peer" (Alice), with its Accept side. */
function open({ link, wallet = everyWallet(), save }: Open = {}) {
  fakeEngine.setState({ links: [linkView(link)], wallet });
  const handlers = {
    onSend: vi.fn(async () => null),
    onRequest: vi.fn(async () => null),
    onClose: vi.fn(),
    onSaveMethods: vi.fn(save ?? (async (methods: ChatPaymentMethods) => { fakeEngine.update({ links: [linkView({ ...link, paymentMethods: methods })] }); })),
  };
  const view = renderApp(<PaymentComposer balance={1_000} {...handlers} reviewContext={reviewContext()} contact="Alice" />);
  document.documentElement.dataset.reduceMotion = "true";
  return { ...view, ...handlers };
}

const composer = () => screen.getByTestId("payment-composer");
const mode = (m: "pay" | "accept") => screen.getByTestId(`payment-mode-${m}`);
const accept = (rail: string) => screen.getByTestId(`payment-accept-${rail}`);
const save = () => screen.getByTestId("payment-accept-save");
const status = () => screen.getByTestId("payment-accept-status");
const hint = () => screen.getByTestId("payment-accept-hint");
const ticked = () => screen.getAllByRole("checkbox").filter((c) => c.getAttribute("aria-checked") === "true").map((c) => c.dataset.testid);

describe("Pay and Accept", () => {
  it("has Pay and Accept in its head, and opens on Pay", () => {
    open();
    expect(screen.getByRole("tablist", { name: "Payments with Alice" })).toBeInTheDocument();
    expect(mode("pay")).toHaveAttribute("aria-selected", "true");
    expect(mode("accept")).toHaveAttribute("aria-selected", "false");
    expect(composer()).toHaveAttribute("data-mode", "pay");
    expect(screen.getByRole("radiogroup", { name: "Pay with" })).toBeInTheDocument();
  });

  it("shows on Pay only the ways this chat has on; Accept keeps every card, the one off unticked", async () => {
    const { user } = open({ link: { paymentMethods: { ...ALL_METHODS_ON, bark: false } } });
    expect(screen.queryByTestId("payment-card-bark")).not.toBeInTheDocument();
    expect(screen.getByTestId("payment-card-spark")).toBeInTheDocument();
    await user.click(mode("accept"));
    expect(screen.getByRole("group", { name: "Ways of paying this chat accepts from Alice" })).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(8);
    expect(accept("bark")).toHaveAttribute("aria-checked", "false");
    expect(within(accept("bark")).getByText("Off here")).toBeInTheDocument();
    expect(accept("spark")).toHaveAttribute("aria-checked", "true");
    // The ways that are on sit a little raised; the one off stays down.
    expect(accept("spark").style.getPropertyValue("--y")).toBe("-5px");
    expect(accept("bark").style.getPropertyValue("--y")).toBe("0px");
  });

  it("goes between the two sides with the arrow keys, as tabs", async () => {
    const { user } = open();
    mode("pay").focus();
    await user.keyboard("{ArrowRight}");
    expect(mode("accept")).toHaveFocus();
    expect(composer()).toHaveAttribute("data-mode", "accept");
    await user.keyboard("{ArrowLeft}");
    expect(composer()).toHaveAttribute("data-mode", "pay");
  });
});

describe("choosing what this chat accepts", () => {
  it("changes nothing until Save, then saves this chat's whole list", async () => {
    const { user, onSaveMethods } = open();
    await user.click(mode("accept"));
    expect(save()).toBeDisabled();
    expect(status()).toHaveTextContent("A way works only when both of you have it on.");
    await user.click(accept("cashu"));
    await user.click(accept("usdt"));
    expect(accept("cashu")).toHaveAttribute("aria-checked", "false");
    expect(status()).toHaveTextContent("Not saved yet: Alice is told when you save.");
    expect(onSaveMethods).not.toHaveBeenCalled();
    await user.click(save());
    expect(onSaveMethods).toHaveBeenCalledWith({ ...ALL_METHODS_ON, cashu: false, usdt: false });
    expect(await screen.findByText("Saved: Alice knows now.")).toBeInTheDocument();
    expect(save()).toBeDisabled();
    // Pay shows what is left on.
    await user.click(mode("pay"));
    expect(screen.queryByTestId("payment-card-cashu")).not.toBeInTheDocument();
    expect(screen.getByTestId("payment-card-lightning")).toHaveAttribute("aria-checked", "true");
  });

  it("never pays, asks or turns a card over", async () => {
    const { user, engine, onSend, onRequest, onClose } = open();
    await user.click(mode("accept"));
    await user.click(accept("arkade"));
    await user.keyboard(" ");
    await user.keyboard("{Enter}");
    await user.click(save());
    await screen.findByText("Saved: Alice knows now.");
    expect(onSend).not.toHaveBeenCalled();
    expect(onRequest).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(engine.calls.map((c) => c.method).filter((m) => /pay|ask|request|send/i.test(m))).toEqual([]);
    expect(screen.queryByTestId("payment-back")).not.toBeInTheDocument();
    expect(screen.queryByTestId("payment-amount")).not.toBeInTheDocument();
  });

  it("opens on Accept when every way is off, and turns one on again from there", async () => {
    const { user, onSaveMethods } = open({ link: { paymentMethods: ALL_OFF } });
    expect(composer()).toHaveAttribute("data-mode", "accept");
    expect(ticked()).toEqual([]);
    // The keyboard starts on the cards, even with none on.
    expect(accept("cashu")).toHaveFocus();
    await user.keyboard(" ");
    await user.click(save());
    expect(onSaveMethods).toHaveBeenCalledWith({ ...ALL_OFF, cashu: true });
    await user.click(mode("pay"));
    expect(screen.getByTestId("payment-card-cashu")).toHaveAttribute("aria-checked", "true");
    expect(screen.getAllByRole("radio")).toHaveLength(1);
  });

  it("says on Pay that nothing is on, and leads to Accept", async () => {
    const { user } = open({ link: { paymentMethods: ALL_OFF } });
    await user.click(mode("pay"));
    expect(screen.getByTestId("payment-none")).toHaveTextContent("No way of paying is on in this chat.");
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("payment-none-accept"));
    expect(composer()).toHaveAttribute("data-mode", "accept");
  });

  it("says what the contact has on, for the ways this chat has on", async () => {
    // What both sides allow: USDT is on here, so the contact is the one who has it off.
    const { user } = open({ link: { dataLink: "open", paymentMethods: { ...ALL_METHODS_ON, bark: false }, capabilities: { files: true, payments: true, methods: { ...ALL_METHODS_ON, bark: false, usdt: false } } } });
    await user.click(mode("accept"));
    expect(within(accept("cashu")).getByText("Contact: accepts it")).toBeInTheDocument();
    expect(within(accept("usdt")).getByText("Contact: has it off")).toBeInTheDocument();
    // Off here, the contact's choice is not known: the card's own line stays.
    expect(within(accept("bark")).queryByText(/Contact:/)).not.toBeInTheDocument();
    expect(hint()).toHaveTextContent("Cashu is on for both of you");
    accept("cashu").focus();
    await user.keyboard("{End}");
    expect(accept("usdt")).toHaveFocus();
    expect(hint()).toHaveTextContent("USDT is on here, but Alice has it off: it works once you both have it on.");
    await user.keyboard(" ");
    expect(hint()).toHaveTextContent("USDT is off here: neither of you can pay the other with it in this chat.");
  });

  it("says the contact is told when the chat next connects, while it is not connected", async () => {
    const { user } = open({ link: { dataLink: "idle" } });
    await user.click(mode("accept"));
    expect(hint()).toHaveTextContent("Cashu is on here. It works when Alice has it on too.");
    await user.click(accept("lightning"));
    await user.click(save());
    expect(await screen.findByText("Saved: Alice is told when you next connect.")).toBeInTheDocument();
  });

  it("shows why saving failed and keeps what was chosen", async () => {
    const { user } = open({ save: async () => { throw new Error("Chat not found"); } });
    await user.click(mode("accept"));
    await user.click(accept("bitcoin"));
    await user.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent("Chat not found");
    expect(accept("bitcoin")).toHaveAttribute("aria-checked", "false");
    expect(save()).toBeEnabled();
  });
});

describe("one chat at a time", () => {
  const other = () => linkView({ id: "link-2", peerPubKeyZ32: "peer-2", paymentMethods: ALL_METHODS_ON });

  it("saves the list of this chat only; another chat keeps its own", async () => {
    fakeEngine.setState({ links: [linkView(), other()], wallet: everyWallet() });
    const { user, engine } = renderApp(<PaymentComposer balance={1_000} onSend={async () => null} onRequest={async () => null} onClose={() => {}}
      reviewContext={reviewContext()} contact="Alice" onSaveMethods={(methods) => servicesPlatform!.setChatPaymentMethods("peer", methods)} />);
    engine.on("setChatPaymentMethods", () => undefined);
    await user.click(mode("accept"));
    await user.click(accept("cashu"));
    await user.click(save());
    await act(async () => {});
    expect(engine.callsTo("setChatPaymentMethods")).toEqual([{ linkId: "link-1", methods: { ...ALL_METHODS_ON, cashu: false } }]);
  });

  it("remembers the card last used per chat", () => {
    rememberRail("peer", "arkade");
    fakeEngine.setState({ links: [linkView(), other()], wallet: everyWallet() });
    renderApp(<PaymentComposer balance={1_000} onSend={async () => null} onRequest={async () => null} onClose={() => {}}
      reviewContext={{ ...reviewContext(), peer: "peer-2", linkId: "link-2" }} contact="Bob" onSaveMethods={async () => {}} />);
    expect(screen.getByTestId("payment-card-cashu")).toHaveAttribute("aria-checked", "true");
  });
});

describe("the + menu of a chat that chooses its own ways", () => {
  const OFF = "Payments are off in this chat. Turn a way on under + → Payment → Accept.";
  function composerWith(props: Partial<Parameters<typeof MessageInput>[0]>, link: Partial<LinkView> = { paymentMethods: ALL_OFF }) {
    fakeEngine.setState({ links: [linkView(link)], wallet: everyWallet() });
    return renderApp(<LockScreenProvider><MessageInput onSend={async () => null} {...props} /></LockScreenProvider>);
  }
  const payments = (onSaveMethods?: (m: ChatPaymentMethods) => Promise<void>) => ({ balance: 1_000, contact: "Alice", onSend: async () => null, onRequest: async () => null, reviewContext: reviewContext(), onSaveMethods });

  it("still opens Payment with every way off, the reason as its hint, on Accept", async () => {
    const { user } = composerWith({ payments: payments(async () => {}), paymentsUnavailable: OFF });
    await user.click(screen.getByTestId("composer-more"));
    const row = screen.getByTestId("payment-button");
    expect(row).toBeEnabled();
    expect(row).toHaveTextContent(OFF);
    await user.click(row);
    expect(composer()).toHaveAttribute("data-mode", "accept");
  });

  it("opens with the contact's refusal on every card of Pay, and Accept still there", async () => {
    const refused = "Your contact has payments off in this chat, or needs an updated Ghostly";
    const { user } = composerWith({ payments: payments(async () => {}), paymentsUnavailable: refused }, {});
    await user.click(screen.getByTestId("composer-more"));
    await user.click(screen.getByTestId("payment-button"));
    expect(screen.getByTestId("payment-card-cashu")).toHaveAttribute("title", refused);
    expect(screen.getByTestId("payment-use")).toBeDisabled();
    await user.click(mode("accept"));
    expect(save()).toBeInTheDocument();
  });

  it("greys the row when there is nothing of this chat's own to choose", async () => {
    const { user } = composerWith({ payments: payments(), paymentsUnavailable: OFF });
    await user.click(screen.getByTestId("composer-more"));
    expect(screen.getByTestId("payment-button")).toBeDisabled();
  });
});
