import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BitcoinWalletPanel } from "../../components/BitcoinWalletPanel";
import { routeBitcoinSend } from "../../lib/sendRoute";
import { servicesPlatform, type WalletPlatform, type WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: wallet.onchain.send-scan

const qr = vi.hoisted(() => ({ text: null as string | null, clipboard: null as string | null, camera: null as MediaStream | null }));
vi.mock("../../lib/qrReader", async (original) => ({
  ...await original<typeof import("../../lib/qrReader")>(),
  readQrImage: async () => qr.text,
  qrCamera: async () => { if (qr.camera) return qr.camera; throw new Error("NotAllowedError"); },
  qrFrameReader: () => Object.assign(async () => null, { ready: Promise.resolve(), close: () => {} }),
  scanQrFrames: async () => {},
}));
vi.mock("../../lib/clipboard", async (original) => ({
  ...await original<typeof import("../../lib/clipboard")>(),
  readClipboardText: async () => qr.clipboard,
}));

const REGTEST = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";
const MAINNET = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const picture = () => new File([new Uint8Array([137, 80, 78, 71])], "qr.png", { type: "image/png" });

describe("what the Bitcoin card's Send was given", () => {
  it("an address, or a link's address and amount, for the card's chain", () => {
    expect(routeBitcoinSend(`  ${REGTEST} `, "regtest")).toEqual({ kind: "address", address: REGTEST });
    expect(routeBitcoinSend(`bitcoin:${REGTEST}?amount=0.00001`, "regtest")).toEqual({ kind: "address", address: REGTEST, amountSat: 1_000 });
    expect(routeBitcoinSend(`BITCOIN:${REGTEST}`, "regtest")).toEqual({ kind: "address", address: REGTEST });
  });

  it("a link that must not be paid is refused, its Lightning leg included", () => {
    expect(routeBitcoinSend(`bitcoin:${REGTEST}?req-pop=x`, "regtest")).toEqual({ kind: "refused" });
    expect(routeBitcoinSend(`bitcoin:${REGTEST}?amount=lots`, "regtest")).toEqual({ kind: "refused" });
    expect(routeBitcoinSend("bitcoin:notanaddress", "regtest")).toEqual({ kind: "refused" });
  });

  it("another chain's address, and anything else, is not this card's", () => {
    expect(routeBitcoinSend(MAINNET, "regtest")).toEqual({ kind: "unknown" });
    expect(routeBitcoinSend(`bitcoin:${MAINNET}?amount=0.1`, "regtest")).toEqual({ kind: "unknown" });
    expect(routeBitcoinSend(REGTEST, "bitcoin")).toEqual({ kind: "unknown" });
    expect(routeBitcoinSend("https://example.com/menu", "regtest")).toEqual({ kind: "unknown" });
  });
});

describe("Send on the Bitcoin card: scan, paste or picture", () => {
  beforeEach(() => { qr.text = null; qr.clipboard = null; qr.camera = null; });
  const show = async () => {
    const state = walletView({ mode: "testnet", bitcoin: { mode: "testnet", status: "ready", network: "regtest", balance: 50_000, history: [], offered: [] } }) as WalletState;
    const rendered = renderApp(<BitcoinWalletPanel wallet={servicesPlatform!.wallet as WalletPlatform} state={state} />);
    await rendered.user.click(screen.getByRole("tab", { name: "Send" }));
    return rendered;
  };

  it("a picture of a link fills the address and the amount, and nothing is reviewed until the person asks", async () => {
    qr.text = `bitcoin:${REGTEST}?amount=0.00001`;
    const { user, engine } = await show();
    await user.upload(screen.getByLabelText("Choose image"), picture());
    expect(await screen.findByDisplayValue(REGTEST)).toBeInTheDocument();
    expect(screen.getByTestId("bitcoin-amount")).toHaveValue("1000");
    expect(engine.callsTo("preparePayment")).toEqual([]);
  });

  it("Paste of a bare address fills it, and takes away the amount meant for the last one", async () => {
    qr.text = `bitcoin:${REGTEST}?amount=0.00001`;
    const { user } = await show();
    await user.upload(screen.getByLabelText("Choose image"), picture());
    await screen.findByDisplayValue(REGTEST);
    qr.clipboard = "bcrt1q6rhpng9evdsfnn833a4f4vej0asu6dk5srld6x";
    await user.click(screen.getByTestId("wallet-send-paste"));
    expect(await screen.findByDisplayValue("bcrt1q6rhpng9evdsfnn833a4f4vej0asu6dk5srld6x")).toBeInTheDocument();
    expect(screen.getByTestId("bitcoin-amount")).toHaveValue("");
  });

  it("on a phone the camera runs as Send opens", async () => {
    const track = { stop: vi.fn() };
    qr.camera = { getTracks: () => [track] } as unknown as MediaStream;
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ media: query, matches: query === "(any-pointer: coarse)", onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }));
    vi.spyOn(HTMLMediaElement.prototype, "srcObject", "set").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    await show();
    expect(await screen.findByTestId("wallet-send-scan-stop")).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it("a link typed or pasted in the field is read the same way", async () => {
    const { user } = await show();
    await user.click(screen.getByLabelText("Bitcoin recipient address"));
    await user.paste(`bitcoin:${REGTEST}?amount=0.00001`);
    expect(await screen.findByDisplayValue(REGTEST)).toBeInTheDocument();
    expect(screen.getByTestId("bitcoin-amount")).toHaveValue("1000");
  });

  it("another chain's address fills nothing, and says so; a link that must not be paid is refused", async () => {
    qr.text = MAINNET;
    const { user } = await show();
    await user.upload(screen.getByLabelText("Choose image"), picture());
    expect(await screen.findByTestId("bitcoin-send-unknown")).toHaveTextContent("That is not a Bitcoin address for this wallet.");
    expect(screen.queryByDisplayValue(MAINNET)).not.toBeInTheDocument();
    qr.text = `bitcoin:${REGTEST}?req-pop=x`;
    await user.upload(screen.getByLabelText("Choose image"), picture());
    expect(await screen.findByTestId("bitcoin-send-refused")).toHaveTextContent("This link asks for something this app does not understand");
    expect(screen.queryByDisplayValue(REGTEST)).not.toBeInTheDocument();
  });
});
