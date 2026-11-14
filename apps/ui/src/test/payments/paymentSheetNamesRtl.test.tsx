import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletView } from "@ghostly/browser/shared/types";
import { PaymentComposer } from "../../components/PaymentComposer";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { everyWallet, reviewContext } from "./fixtures";

// covers: payments.chat.cards, payments.chat.methods, app.i18n

/*
 * The chat's payment sheet says whom it pays and with which card in its sentences: the contact's name and the card's
 * are someone's own words, in any script. Each is its own <bdi>, as a call's or a device's name is, or what sits at its
 * edge took the sentence's direction: in Arabic "Bob 🚀" read "🚀 Bob", "Bob!" read "!Bob"; in English an Arabic
 * name's emoji went to its other side.
 */

const BOB = "Bob 🚀";

beforeEach(() => { document.documentElement.dataset.reduceMotion = "true"; });

function open(wallet: Partial<WalletView> = everyWallet(), language: "ar" | "en" = "ar", contact = BOB) {
  fakeEngine.setState({ links: [linkView()], wallet });
  const view = renderApp(<PaymentComposer balance={1_000} onSend={vi.fn(async () => null)} onRequest={vi.fn(async () => null)} onClose={vi.fn()}
    onSaveMethods={vi.fn(async () => {})} reviewContext={reviewContext()} contact={contact} />, { language });
  document.documentElement.dataset.reduceMotion = "true";
  return view;
}

/** The <bdi>s inside the element, by their text. */
const isolated = (el: Element) => [...el.querySelectorAll("bdi")].map((bdi) => bdi.textContent);
const one = (selector: string) => document.querySelector(selector)!;

describe("the payment sheet's names, each in its own direction", () => {
  it("whom the sheet is with, what Send does with them, and the card Use goes on with", () => {
    open();
    expect(isolated(one(".composer-sheet-who"))).toEqual([BOB]);
    expect(isolated(one(".composer-sheet-hint"))).toContain(BOB);
    const use = screen.getByTestId("payment-use");
    expect(isolated(use)).toHaveLength(1);
    expect(use.textContent).toContain(isolated(use)[0]);
  });

  it("the card's back: the balance with them, and what Send does", async () => {
    const { user } = open();
    await user.click(screen.getByTestId("payment-use"));
    expect(isolated(one(".payment-back-meta"))).toEqual([BOB]);
    expect(isolated(one(".payment-back-hint"))).toContain(BOB);
  });

  it("Accept's hint and status", async () => {
    const { user } = open();
    await user.click(screen.getByTestId("payment-mode-accept"));
    expect(isolated(screen.getByTestId("payment-accept-hint"))).toContain(BOB);
    await user.click(screen.getAllByRole("switch")[0]);
    expect(isolated(screen.getByTestId("payment-accept-status"))).toEqual([BOB]);
  });

  it("no wallet yet", () => {
    open({});
    expect(isolated(screen.getByTestId("payment-no-wallet"))).toEqual([BOB]);
  });

  it("an Arabic name in the English app, and the text stays the same", () => {
    open(everyWallet(), "en", "محمد 🚀");
    expect(isolated(one(".composer-sheet-who"))).toEqual(["محمد 🚀"]);
    expect(one(".composer-sheet-who")).toHaveTextContent("with محمد 🚀");
  });
});
