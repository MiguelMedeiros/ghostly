import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PayExternally } from "../../components/PayExternally";
import { Address } from "../../components/wallet/ui";
import { renderApp } from "../render";

// covers: payments.external, wallet.ark.boarding

const address = "bc1pe4cr9ugwk8p252z4vetllpzmvkyu4durcua2utepf0svhyz2kepqyryua8";

describe("the QR code's name for a screen reader", () => {
  it("a wallet's own address is a receiving address", () => {
    renderApp(<Address value={address} uri={`bitcoin:${address}`} testId="ark-boarding-address" />);
    expect(screen.getByRole("img", { name: "Receiving address" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Payment QR code" })).toBeNull();
  });

  it("someone else's invoice, paid with another wallet, is a payment", () => {
    renderApp(<PayExternally uri={`bitcoin:${address}`} value={address} testId="payment-external" onPaid={async () => undefined} />);
    expect(screen.getByRole("img", { name: "Payment QR code" })).toBeInTheDocument();
  });

  it("no QR code before there is an address", () => {
    renderApp(<Address value={undefined} testId="ark-boarding-address" />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByTestId("ark-boarding-address-pending")).toBeInTheDocument();
  });
});
