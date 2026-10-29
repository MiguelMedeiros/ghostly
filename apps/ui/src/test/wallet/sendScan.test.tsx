import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bech32 } from "@scure/base";
import { TEST_MINTS } from "@ghostly/browser/shared/mints";
import { fakeInvoice } from "@ghostly/browser/engine/paymentAdapters/providers/testing";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type LightningAddressInfo, type WalletPlatform, type WalletState } from "../../lib/platform";
import { fakeEngine, walletView } from "../fakeEngine";
import { liveMainnetInvoice, mint, REAL_MINT } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: wallet.cashu.send-scan, wallet.cashu.pay-invoice, wallet.lnurl.address, payments.mainnet-confirm

/** What the next QR read finds (a picture or the camera), and what the clipboard holds. */
const qr = vi.hoisted(() => ({ text: null as string | null, clipboard: null as string | null, camera: null as MediaStream | null, held: null as Promise<void> | null }));
vi.mock("../../lib/qrReader", async (original) => ({
  ...await original<typeof import("../../lib/qrReader")>(),
  readQrImage: async () => qr.text,
  qrCamera: async () => { if (qr.camera) return qr.camera; throw new Error("NotAllowedError"); },
  qrFrameReader: () => Object.assign(async () => null, { ready: Promise.resolve(), close: () => {} }),
  scanQrFrames: async () => {},
}));
vi.mock("../../lib/clipboard", async (original) => ({
  ...await original<typeof import("../../lib/clipboard")>(),
  readClipboardText: async () => { await qr.held; return qr.clipboard; },
}));

const TEST_MINT = TEST_MINTS[0];
const invoice = fakeInvoice(21, new Uint8Array(32).fill(3), "Two coffees");
const anyAmount = () => {
  const { words } = bech32.decode(fakeInvoice(1, new Uint8Array(32).fill(7)) as `${string}1${string}`, false);
  return bech32.encode("lnbcrt", words, false);
};
const picture = () => new File([new Uint8Array([137, 80, 78, 71])], "qr.png", { type: "image/png" });

function show(methods: Partial<WalletPlatform>, network: "testnet" | "mainnet" = "testnet", balance = 5_000) {
  const mints = network === "testnet" ? [mint(TEST_MINT, balance)] : [mint(REAL_MINT, balance)];
  const state = networkState(walletView({ mode: network, mints, balance }) as WalletState, network);
  const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet), { getState: () => state, ...methods });
  return renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
}

describe("Send on the Cashu card: scan, paste or picture, review, pay", () => {
  beforeEach(() => { qr.text = null; qr.clipboard = null; qr.camera = null; qr.held = null; });

  it("a picture of an invoice's QR opens its review; Pay pays it and the result leads back to Send", async () => {
    qr.text = `LIGHTNING:${invoice.toUpperCase()}`;
    const quoted: string[] = [];
    const payQuote = vi.fn(async () => true);
    const { user } = show({ quoteInvoice: async (text) => { quoted.push(text); return { quote: "q-1", mint: TEST_MINT, amount: 21, feeReserve: 2 }; }, payQuote });
    await user.click(screen.getByRole("tab", { name: "Send" }));
    expect(screen.getByTestId("wallet-send-camera")).toHaveTextContent("Scan");
    expect(screen.getByText("Paying a contact? Use ⚡ in the chat.")).toBeInTheDocument();
    await user.upload(screen.getByLabelText("Choose image"), picture());

    const review = await screen.findByTestId("wallet-pay-review");
    expect(quoted).toEqual([invoice]);
    expect(review).toHaveTextContent("Pay 21 test sats");
    expect(review).toHaveTextContent("2");
    expect(screen.getByTestId("wallet-pay-description")).toHaveTextContent("Two coffees");
    await user.click(screen.getByTestId("wallet-pay-confirm"));
    expect(payQuote).toHaveBeenCalledWith("q-1", TEST_MINT, undefined, false);
    expect(await screen.findByTestId("wallet-notice")).toHaveTextContent("Paid.");
    await waitFor(() => expect(screen.getByTestId("wallet-send-done")).toHaveFocus());
    await user.click(screen.getByTestId("wallet-send-done"));
    expect(screen.getByTestId("wallet-pay-input")).toHaveValue("");
    expect(screen.getByTestId("wallet-send-camera")).toBeInTheDocument();
  });

  it("on Mainnet, a scanned invoice is paid only through the real-money confirmation", async () => {
    qr.text = liveMainnetInvoice(2_100);
    const payQuote = vi.fn(async () => true);
    const { user } = show({ quoteInvoice: async () => ({ quote: "q-2", mint: REAL_MINT, amount: 2_100, feeReserve: 3 }), payQuote }, "mainnet");
    await user.click(screen.getByRole("tab", { name: "Send" }));
    await user.upload(screen.getByLabelText("Choose image"), picture());
    await user.click(await screen.findByTestId("wallet-pay-confirm"));
    expect(payQuote).not.toHaveBeenCalled();
    expect(screen.getByTestId("review-mainnet-confirm")).toHaveTextContent("Real money");
    await user.click(screen.getByTestId("review-confirm-send"));
    expect(payQuote).toHaveBeenCalledWith("q-2", REAL_MINT, undefined, true);
  });

  it("a failed payment says why and keeps the review, to try again or cancel", async () => {
    qr.text = invoice;
    const { user } = show({ quoteInvoice: async () => ({ quote: "q-3", mint: TEST_MINT, amount: 21, feeReserve: 0 }), payQuote: async () => { throw new Error("Route not found"); } });
    await user.click(screen.getByRole("tab", { name: "Send" }));
    await user.upload(screen.getByLabelText("Choose image"), picture());
    await user.click(await screen.findByTestId("wallet-pay-confirm"));
    expect(await screen.findByTestId("wallet-error")).toBeInTheDocument();
    expect(screen.getByTestId("wallet-pay-review")).toBeInTheDocument();
    expect(screen.queryByTestId("wallet-send-result")).not.toBeInTheDocument();
  });

  it("a picture the Linux app's webview hides from a paste (Ctrl+V shows the page nothing) is read through the app", async () => {
    qr.text = invoice;
    const nothing = { files: [], types: [], items: [], getData: () => "" };
    const shot = (size: number) => ({ name: null, size, mime: "image/png", read: vi.fn(async () => new Uint8Array([137, 80, 78, 71])), done: vi.fn() });
    fakeEngine.readClipboardFiles = vi.fn(async () => [shot(4)]);
    const quoteInvoice = vi.fn(async () => ({ quote: "q-4", mint: TEST_MINT, amount: 21, feeReserve: 0 }));
    const { user } = show({ quoteInvoice });
    await user.click(screen.getByRole("tab", { name: "Send" }));
    fireEvent.paste(screen.getByTestId("wallet-pay-input"), { clipboardData: nothing });
    expect(await screen.findByTestId("wallet-pay-review")).toHaveTextContent("Pay 21 test sats");
    expect(fakeEngine.readClipboardFiles).toHaveBeenCalledTimes(1);
    expect(quoteInvoice).toHaveBeenCalledWith(invoice, "cashu");
  });

  it("a picture read through the app that is too large, or a paste the app cannot read, is said", async () => {
    const huge = { name: null, size: 64 * 1024 * 1024, mime: "image/png", read: vi.fn(async () => new Uint8Array()), done: vi.fn() };
    fakeEngine.readClipboardFiles = vi.fn(async () => [huge]);
    const { user } = show({});
    await user.click(screen.getByRole("tab", { name: "Send" }));
    fireEvent.paste(screen.getByTestId("wallet-pay-input"), { clipboardData: { files: [], types: [], items: [], getData: () => "" } });
    expect(await screen.findByTestId("wallet-send-scan-error")).toHaveTextContent("Choose an image smaller than 12 MB.");
    expect(huge.read).not.toHaveBeenCalled();
    // A browser's "Copy image" (its HTML only) whose picture the app fails to read.
    fakeEngine.readClipboardFiles = vi.fn(async () => { throw "Clipboard unavailable"; });
    const copied = { files: [], types: ["text/html"], items: [], getData: (type: string) => type === "text/html" ? "<img src=\"https://example.com/qr.png\">" : "" };
    fireEvent.paste(screen.getByTestId("wallet-pay-input"), { clipboardData: copied });
    await waitFor(() => expect(screen.getByTestId("wallet-send-scan-error")).toHaveTextContent("Could not read"));
  });

  it("Paste: a Lightning address goes to its steps, whose amount shows the balance and a Max", async () => {
    qr.clipboard = "shop@example.com";
    const info: LightningAddressInfo = { id: "a-1", kind: "address", text: "shop@example.com", domain: "example.com", callbackDomain: "example.com", minSat: 5, maxSat: 1_000, description: "Coffee shop", commentAllowed: 0 };
    const { user } = show({ resolveLightningAddress: async () => info }, "testnet", 700);
    await user.click(screen.getByRole("tab", { name: "Send" }));
    await user.click(screen.getByTestId("wallet-send-paste"));
    expect(screen.getByTestId("wallet-pay-input")).toHaveValue("shop@example.com");
    await user.click(screen.getByTestId("lnurl-lookup"));
    expect(await screen.findByTestId("lnurl-balance")).toHaveTextContent("Balance: 700 test sats");
    await user.click(screen.getByTestId("lnurl-max"));
    expect(screen.getByTestId("lnurl-amount")).toHaveValue("700");
    // Max is a phone-sized target like the panel's other buttons, its label at full strength (the line's dim is the text's).
    const maxButton = screen.getByTestId("lnurl-max");
    expect(maxButton.className).toContain("max-md:min-h-11");
    expect(maxButton.className).toContain("min-h-6");
    for (let at: HTMLElement | null = maxButton; at; at = at.parentElement) expect(at.className).not.toMatch(/\bopacity-70\b/);
  });

  it("an invoice with no amount, and a QR that is no payment, are said plainly", async () => {
    qr.text = anyAmount();
    const quoteInvoice = vi.fn();
    const { user } = show({ quoteInvoice });
    await user.click(screen.getByRole("tab", { name: "Send" }));
    await user.upload(screen.getByLabelText("Choose image"), picture());
    expect(await screen.findByTestId("wallet-pay-no-amount")).toHaveTextContent("This invoice has no amount.");
    expect(screen.getByRole("button", { name: /^Pay$/ })).toBeDisabled();

    qr.text = "https://example.com/menu";
    await user.upload(screen.getByLabelText("Choose image"), picture());
    expect(await screen.findByText("That is not a Lightning invoice or a Lightning address.")).toBeInTheDocument();
    qr.text = null;
    await user.upload(screen.getByLabelText("Choose image"), picture());
    expect(await screen.findByTestId("wallet-send-scan-error")).toHaveTextContent("No QR found");
    expect(quoteInvoice).not.toHaveBeenCalled();
  });

  it("a bitcoin: link the chat would not pay opens no review: refused, or its Lightning leg left out", async () => {
    const quoteInvoice = vi.fn();
    const { user } = show({ quoteInvoice });
    await user.click(screen.getByRole("tab", { name: "Send" }));
    // BIP 21: a req- parameter this app does not understand means the link is not paid.
    qr.text = `bitcoin:?req-pop=x&lightning=${invoice}`;
    await user.upload(screen.getByLabelText("Choose image"), picture());
    expect(await screen.findByTestId("wallet-pay-refused")).toHaveTextContent("This link asks for something this app does not understand");
    // A fallback for another amount than its link's is not the same payment.
    qr.text = `bitcoin:bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080?amount=0.001&lightning=${invoice}`;
    await user.upload(screen.getByLabelText("Choose image"), picture());
    expect(await screen.findByText("That is not a Lightning invoice or a Lightning address.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Pay$/ })).toBeDisabled();
    expect(quoteInvoice).not.toHaveBeenCalled();
  });

  it("no camera: Scan says so and leaves Paste, the field and Choose image", async () => {
    const { user } = show({});
    await user.click(screen.getByRole("tab", { name: "Send" }));
    await user.click(screen.getByTestId("wallet-send-camera"));
    expect(await screen.findByTestId("wallet-send-scan-error")).toHaveTextContent("Camera unavailable");
    expect(screen.getByTestId("wallet-send-paste")).toBeEnabled();
    expect(screen.getByTestId("wallet-pay-input")).toBeInTheDocument();
  });

  it("from the keyboard, Paste keeps the focus while it reads and after it finds nothing", async () => {
    let release = () => {};
    qr.held = new Promise((resolve) => { release = resolve; });
    qr.clipboard = " ";
    const { user } = show({});
    await user.click(screen.getByRole("tab", { name: "Send" }));
    const paste = screen.getByTestId("wallet-send-paste");
    paste.focus();
    await user.keyboard("{Enter}");
    // Busy: marked so, not disabled (a disabled button drops the focus to the page), and a second press does nothing.
    expect(paste).not.toBeDisabled();
    expect(paste).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("wallet-send-image")).not.toBeDisabled();
    expect(paste).toHaveFocus();
    release();
    expect(await screen.findByTestId("wallet-send-scan-error")).toHaveTextContent("Nothing to paste");
    expect(paste).not.toHaveAttribute("aria-disabled");
    expect(paste).toHaveFocus();
  });

  it("from the keyboard, Scan hands the focus to the camera's Cancel, and Cancel back to Scan", async () => {
    const track = { stop: vi.fn() };
    qr.camera = { getTracks: () => [track] } as unknown as MediaStream;
    // A stand-in camera: the preview takes it and plays (frames are read elsewhere: scanQrFrames).
    const srcObject = vi.spyOn(HTMLMediaElement.prototype, "srcObject", "set").mockImplementation(() => {});
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const { user } = show({});
    await user.click(screen.getByRole("tab", { name: "Send" }));
    screen.getByTestId("wallet-send-camera").focus();
    await user.keyboard("{Enter}");
    const cancel = await screen.findByTestId("wallet-send-scan-stop");
    await waitFor(() => expect(cancel).toHaveFocus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByTestId("wallet-send-camera")).toHaveFocus());
    expect(track.stop).toHaveBeenCalled();
    srcObject.mockRestore(); play.mockRestore();
  });
});
