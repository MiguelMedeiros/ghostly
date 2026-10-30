import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ETHEREUM_USDT, SEPOLIA_TEST_USDT } from "@ghostly/core";
import { UsdtWalletPanel } from "../../components/UsdtWalletPanel";
import { routeUsdtSend } from "../../lib/sendRoute";
import { servicesPlatform, type WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: wallet.usdt.send-scan

const qr = vi.hoisted(() => ({ text: null as string | null, clipboard: null as string | null }));
vi.mock("../../lib/qrReader", async (original) => ({
  ...await original<typeof import("../../lib/qrReader")>(),
  readQrImage: async () => qr.text,
}));
vi.mock("../../lib/clipboard", async (original) => ({
  ...await original<typeof import("../../lib/clipboard")>(),
  readClipboardText: async () => qr.clipboard,
}));

/** EIP-55's own example, checksum and all. */
const TO = "0x52908400098527886E0F7030069857D2E4169EE7";
const SEPOLIA = { chainId: 11155111, token: SEPOLIA_TEST_USDT };
const picture = () => new File([new Uint8Array([137, 80, 78, 71])], "qr.png", { type: "image/png" });

describe("what the USDT card's Send was given", () => {
  it("an address, or a link to one on the card's chain", () => {
    expect(routeUsdtSend(` ${TO} `, SEPOLIA)).toEqual({ kind: "address", address: TO });
    expect(routeUsdtSend(`ethereum:${TO}@11155111`, SEPOLIA)).toEqual({ kind: "address", address: TO });
    expect(routeUsdtSend(`ethereum:${TO}`, SEPOLIA)).toEqual({ kind: "address", address: TO });
  });

  it("a transfer of the card's token names the recipient and the amount, in base units", () => {
    expect(routeUsdtSend(`ethereum:${SEPOLIA_TEST_USDT}@11155111/transfer?address=${TO}&uint256=1500000`, SEPOLIA)).toEqual({ kind: "address", address: TO, amount: 1_500_000n });
  });

  it("never reads the token's own contract as the recipient, nor ether's value as USDT", () => {
    expect(routeUsdtSend(`ethereum:${TO}@11155111?value=5000000000000000000`, SEPOLIA)).toEqual({ kind: "address", address: TO });
    // Another token, on a chain whose USDT is known: not this card's.
    expect(routeUsdtSend(`ethereum:${ETHEREUM_USDT}@11155111/transfer?address=${TO}&uint256=1`, SEPOLIA)).toEqual({ kind: "unknown" });
    expect(routeUsdtSend(`ethereum:${SEPOLIA_TEST_USDT}@11155111/approve?address=${TO}&uint256=1`, SEPOLIA)).toEqual({ kind: "unknown" });
  });

  it("another chain, a bad checksum, the zero address or anything else is not this card's", () => {
    expect(routeUsdtSend(`ethereum:${TO}@1`, SEPOLIA)).toEqual({ kind: "unknown" });
    expect(routeUsdtSend(`ethereum:${ETHEREUM_USDT}@1/transfer?address=${TO}&uint256=1`, SEPOLIA)).toEqual({ kind: "unknown" });
    expect(routeUsdtSend(TO.replace("E7", "e7"), SEPOLIA)).toEqual({ kind: "unknown" });
    expect(routeUsdtSend(`0x${"0".repeat(40)}`, SEPOLIA)).toEqual({ kind: "unknown" });
    expect(routeUsdtSend(`pay ${TO} please`, SEPOLIA)).toEqual({ kind: "unknown" });
    expect(routeUsdtSend(`ethereum:${TO}@11155111 extra`, SEPOLIA)).toEqual({ kind: "unknown" });
    expect(routeUsdtSend("https://example.com/menu", SEPOLIA)).toEqual({ kind: "unknown" });
  });
});

describe("Send on the USDT card: scan, paste or picture", () => {
  beforeEach(() => { qr.text = null; qr.clipboard = null; });
  const show = async () => {
    const state = walletView({ mode: "testnet", usdt: { configured: true, locked: false, network: "sepolia", provider: "http://127.0.0.1:1", chainId: 11155111, token: SEPOLIA_TEST_USDT, decimals: 6, address: "0xde709f2102306220921060314715629080e2fb77", balance: "5000000", gasBalance: "1000000000000000" } }) as WalletState;
    const rendered = renderApp(<UsdtWalletPanel wallet={servicesPlatform!.wallet} state={state} />);
    await rendered.user.click(screen.getByRole("tab", { name: "Send" }));
    return rendered;
  };
  const field = () => screen.getByLabelText("USDT recipient address");

  it("a picture of a transfer link fills the recipient and the amount in USDT, and nothing is reviewed until the person asks", async () => {
    qr.text = `ethereum:${SEPOLIA_TEST_USDT}@11155111/transfer?address=${TO}&uint256=1500000`;
    const { user, engine } = await show();
    await user.upload(screen.getByLabelText("Choose image"), picture());
    expect(await screen.findByDisplayValue(TO)).toBe(field());
    expect(screen.getByDisplayValue("1.5")).toBeInTheDocument();
    expect(engine.callsTo("preparePayment")).toEqual([]);
  });

  it("Paste of a bare address fills it, and the amount meant for the last one goes", async () => {
    const { user } = await show();
    await user.type(screen.getByLabelText(/^Amount/), "7");
    qr.clipboard = TO;
    await user.click(screen.getByTestId("wallet-send-paste"));
    expect(await screen.findByDisplayValue(TO)).toBe(field());
    expect(screen.queryByDisplayValue("7")).not.toBeInTheDocument();
  });

  it("another chain's link fills nothing, and says so", async () => {
    qr.text = `ethereum:${TO}@1`;
    const { user } = await show();
    await user.upload(screen.getByLabelText("Choose image"), picture());
    expect(await screen.findByTestId("wallet-send-unknown")).toHaveTextContent("That is not a USDT address for this wallet.");
    expect(field()).toHaveValue("");
  });
});
