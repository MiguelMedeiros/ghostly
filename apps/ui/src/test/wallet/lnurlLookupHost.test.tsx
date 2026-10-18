import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LightningAddressPay } from "../../components/wallet/LightningAddressPay";
import { servicesPlatform } from "../../lib/platform";
import { fakeEngine, walletView } from "../fakeEngine";
import { mint, TEST_MINT } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: wallet.lightning.card

/** `https://192.168.1.1/x` as a bech32 LNURL. */
const LAN_LNURL = "lnurl1dp68gurn8ghj7vfexghrzd3c9ccjuvf00q0uhs8q";

/**
 * Before Look up, the line names the server that will learn of the payment: the host the lookup really asks, read as
 * the engine reads it. Read from the raw text, an `@` in an LNURL's path named another host, and a bech32 LNURL named
 * none at all.
 */
describe("before a Lightning lookup, the host named is the one asked", () => {
  const lookupLine = (text: string) => {
    fakeEngine.setState({ wallet: walletView({ mints: [mint(TEST_MINT, 5_000)] }) });
    renderApp(<LightningAddressPay wallet={servicesPlatform!.wallet.forNetwork("testnet")} text={text} />);
    return screen.getByTestId("lnurl-resolve");
  };

  it("an lnurlp:// with an @ in its path names its own host", () => {
    const line = lookupLine("lnurlp://evil.example/@good.example");
    expect(line).toHaveTextContent("evil.example");
    expect(line).not.toHaveTextContent("good.example");
  });

  it("a bech32 LNURL names the host it decodes to", () => {
    expect(lookupLine(LAN_LNURL)).toHaveTextContent("192.168.1.1");
  });

  it("an address names its domain", () => {
    expect(lookupLine("alice@example.com")).toHaveTextContent("example.com");
  });
});
