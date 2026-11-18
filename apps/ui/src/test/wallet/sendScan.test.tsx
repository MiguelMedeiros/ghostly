import { act, createEvent, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bech32, bech32m } from "@scure/base";
import type { ClipboardFile } from "@ghostly/browser/host";
import { TEST_MINTS } from "@ghostly/browser/shared/mints";
import { fakeInvoice } from "@ghostly/browser/engine/paymentAdapters/providers/testing";
import { ETHEREUM_USDT, SEPOLIA_TEST_USDT } from "@ghostly/core";
import { ArkWalletPanel } from "../../components/ArkWalletPanel";
import { BarkWalletPanel } from "../../components/BarkWalletPanel";
import { BitcoinWalletPanel } from "../../components/BitcoinWalletPanel";
import { SparkWalletPanel } from "../../components/SparkWalletPanel";
import { UsdtWalletPanel } from "../../components/UsdtWalletPanel";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { networkState } from "../../components/walletCardData";
import { followPlatformDrags, guardFileDrops, resetPlatformDrags } from "../../lib/pastedFiles";
import { servicesPlatform, type LightningAddressInfo, type WalletPlatform, type WalletState } from "../../lib/platform";
import { routeArkSend, routeBitcoinSend, routeSend, routeUsdtSend } from "../../lib/sendRoute";
import { fakeEngine, walletView } from "../fakeEngine";
import { liveMainnetInvoice, mint, REAL_MINT, REGTEST_INVOICE } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: wallet.cashu.send-scan, wallet.cashu.pay-invoice, wallet.lnurl.address, payments.mainnet-confirm

/** What the next QR read finds (a picture or the camera), and what the clipboard holds. */
const qr = vi.hoisted(() => ({ text: null as string | null, clipboard: null as string | null, camera: null as MediaStream | null, held: null as Promise<void> | null, asked: null as Promise<void> | null }));
vi.mock("../../lib/qrReader", async (original) => ({
  ...await original<typeof import("../../lib/qrReader")>(),
  readQrImage: async () => qr.text,
  qrCamera: async () => { await qr.asked; if (qr.camera) return qr.camera; throw new Error("NotAllowedError"); },
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
/** A PNG's signature and header, saying `width` x `height`. */
const pngHead = (width: number, height: number) => {
  const head = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 0, 0, 0, 0, 0, 8, 6, 0, 0, 0]);
  new DataView(head.buffer).setUint32(16, width); new DataView(head.buffer).setUint32(20, height);
  return head;
};

function show(methods: Partial<WalletPlatform>, network: "testnet" | "mainnet" = "testnet", balance = 5_000) {
  const mints = network === "testnet" ? [mint(TEST_MINT, balance)] : [mint(REAL_MINT, balance)];
  const state = networkState(walletView({ mode: network, mints, balance }) as WalletState, network);
  const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet), { getState: () => state, ...methods });
  return renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
}

describe("Send on the Cashu card: scan, paste or picture, review, pay", () => {
  beforeEach(() => { qr.text = null; qr.clipboard = null; qr.camera = null; qr.held = null; });

  it("a phone's keyboard is told not to change what is typed into Send or a mint's address", async () => {
    const { user } = show({});
    await user.click(screen.getByRole("tab", { name: "Send" }));
    for (const field of [screen.getByTestId("wallet-pay-input"), screen.getByTestId("wallet-mint-url")]) {
      expect(field).toHaveAttribute("autocapitalize", "none");
      expect(field).toHaveAttribute("autocorrect", "off");
      expect(field).toHaveAttribute("spellcheck", "false");
    }
    expect(screen.getByTestId("wallet-mint-url")).toHaveAttribute("inputmode", "url");
  });

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
    expect(await screen.findByTestId("wallet-error")).toHaveTextContent("Route not found");
    expect(screen.getByTestId("wallet-pay-review")).toBeInTheDocument();
    expect(screen.queryByTestId("wallet-send-result")).not.toBeInTheDocument();
  });

  it("a picture the Linux app's webview hides from a paste (Ctrl+V shows the page nothing) is read through the app", async () => {
    qr.text = invoice;
    const nothing = { files: [], types: [], items: [], getData: () => "" };
    // A 12 MP phone photo, 14 MB as the app's PNG: judged by its pixels, not its bytes.
    const shot = (size: number) => ({ name: null, size, mime: "image/png", read: vi.fn(async (offset: number) => offset ? new Uint8Array() : pngHead(4032, 3024)), done: vi.fn() });
    fakeEngine.readClipboardFiles = vi.fn(async () => [shot(13_985_607)]);
    const quoteInvoice = vi.fn(async () => ({ quote: "q-4", mint: TEST_MINT, amount: 21, feeReserve: 0 }));
    const { user } = show({ quoteInvoice });
    await user.click(screen.getByRole("tab", { name: "Send" }));
    fireEvent.paste(screen.getByTestId("wallet-pay-input"), { clipboardData: nothing });
    expect(await screen.findByTestId("wallet-pay-review")).toHaveTextContent("Pay 21 test sats");
    expect(fakeEngine.readClipboardFiles).toHaveBeenCalledTimes(1);
    expect(quoteInvoice).toHaveBeenCalledWith(invoice, "cashu");
  });

  it("a picture read through the app that is too large, or a paste the app cannot read, is said", async () => {
    const huge = { name: "photo.png", size: 64 * 1024 * 1024, mime: "image/png", read: vi.fn(async () => new Uint8Array()), done: vi.fn() };
    fakeEngine.readClipboardFiles = vi.fn(async () => [huge]);
    const { user } = show({});
    await user.click(screen.getByRole("tab", { name: "Send" }));
    const nothing = { files: [], types: [], items: [], getData: () => "" };
    fireEvent.paste(screen.getByTestId("wallet-pay-input"), { clipboardData: nothing });
    expect(await screen.findByTestId("wallet-send-scan-error")).toHaveTextContent("Choose an image smaller than 12 MB.");
    expect(huge.read).not.toHaveBeenCalled();
    // A picture the app made a PNG of is judged by its pixels: one of 10000 x 6000, by its header alone.
    const vast = { name: null, size: 9_000_000, mime: "image/png", read: vi.fn(async () => pngHead(10_000, 6_000)), done: vi.fn() };
    fakeEngine.readClipboardFiles = vi.fn(async () => [vast]);
    fireEvent.paste(screen.getByTestId("wallet-pay-input"), { clipboardData: nothing });
    await waitFor(() => expect(screen.getByTestId("wallet-send-scan-error")).toHaveTextContent("That picture is too large to read."));
    expect(vast.read).toHaveBeenCalledTimes(1);
    expect(vast.done).toHaveBeenCalledTimes(1);
    // A browser's "Copy image" (its HTML only) whose picture the app fails to read.
    fakeEngine.readClipboardFiles = vi.fn(async () => { throw "Clipboard unavailable"; });
    const copied = { files: [], types: ["text/html"], items: [], getData: (type: string) => type === "text/html" ? "<img src=\"https://example.com/qr.png\">" : "" };
    fireEvent.paste(screen.getByTestId("wallet-pay-input"), { clipboardData: copied });
    await waitFor(() => expect(screen.getByTestId("wallet-send-scan-error")).toHaveTextContent("Could not read"));
  });

  describe("a picture dragged in from a file manager, which the Linux app's webview names by address only", () => {
    /** A file manager's drag as WebKitGTK shows it to the page: no File, no text. */
    const named = () => ({ dataTransfer: { files: [], types: ["text/uri-list", "text/html"], items: [], getData: () => "", dropEffect: "none" } });
    const held = (name: string, size: number) => ({ name, size, mime: null, read: vi.fn(async (offset: number) => offset ? new Uint8Array() : pngHead(400, 400)), done: vi.fn() });
    let read: ReturnType<typeof vi.fn<() => Promise<ClipboardFile[]>>>;
    let over: (on: boolean) => void;
    let unguard: () => void;
    beforeEach(() => { read = vi.fn(async () => []); over = followPlatformDrags(read); unguard = guardFileDrops(window); });
    afterEach(() => { unguard(); resetPlatformDrags(); });

    it("is taken as a drop, and the app reads the picture alone: its invoice opens the review", async () => {
      qr.text = invoice;
      const notes = held("notes.pdf", 9), code = held("invoice.png", 29);
      read.mockResolvedValue([notes, code]);
      const quoteInvoice = vi.fn(async () => ({ quote: "q-7", mint: TEST_MINT, amount: 21, feeReserve: 0 }));
      const { user } = show({ quoteInvoice });
      await user.click(screen.getByRole("tab", { name: "Send" }));
      act(() => over(true));
      // Taken where it is over Send's field, not refused as the page refuses another app's files elsewhere.
      const field = screen.getByTestId("wallet-pay-input");
      const moved = createEvent.dragOver(field, named());
      fireEvent(field, moved);
      expect(moved.defaultPrevented).toBe(true);
      expect((moved as DragEvent).dataTransfer?.dropEffect).toBe("copy");
      expect(fireEvent.drop(field, named())).toBe(false);
      expect(await screen.findByTestId("wallet-pay-review")).toHaveTextContent("Pay 21 test sats");
      expect(quoteInvoice).toHaveBeenCalledWith(invoice, "cashu");
      expect(read).toHaveBeenCalledTimes(1);
      expect(notes.read).not.toHaveBeenCalled();
      expect([notes.done, code.done].map((done) => done.mock.calls.length)).toEqual([1, 1]);
    });

    it("dropped files with no picture among them, and a picture too large, say so unread", async () => {
      read.mockResolvedValueOnce([held("a.pdf", 4)]);
      const { user } = show({});
      await user.click(screen.getByRole("tab", { name: "Send" }));
      const scan = screen.getByTestId("wallet-send-scan");
      act(() => over(true));
      expect(fireEvent.drop(scan, named())).toBe(false);
      expect(await screen.findByTestId("wallet-send-scan-error")).toHaveTextContent("Could not read the image. Try PNG or JPEG.");

      const huge = held("photo.png", 64 * 1024 * 1024);
      read.mockResolvedValueOnce([huge]);
      act(() => over(true));
      fireEvent.drop(scan, named());
      await waitFor(() => expect(screen.getByTestId("wallet-send-scan-error")).toHaveTextContent("Choose an image smaller than 12 MB."));
      expect(huge.read).not.toHaveBeenCalled();
      expect(huge.done).toHaveBeenCalledTimes(1);
    });
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

  describe("Max on a Lightning address", () => {
    const info: LightningAddressInfo = { id: "a-1", kind: "address", text: "shop@example.com", domain: "example.com", callbackDomain: "example.com", minSat: 5, maxSat: 1_000, description: "Coffee shop", commentAllowed: 0 };
    const start = async (methods: Partial<WalletPlatform>, balance = 700) => {
      qr.clipboard = "shop@example.com";
      const rendered = show({ resolveLightningAddress: async () => info, ...methods }, "testnet", balance);
      await rendered.user.click(screen.getByRole("tab", { name: "Send" }));
      await rendered.user.click(screen.getByTestId("wallet-send-paste"));
      await rendered.user.click(screen.getByTestId("lnurl-lookup"));
      await rendered.user.click(await screen.findByTestId("lnurl-max"));
      return rendered;
    };
    const asked = () => vi.fn(async (_id: string, amount: number) => ({ invoice: `inv-${amount}`, note: "n" }));

    it("a mint that holds all of it but not the fee: the amount comes down to what leaves room, and goes to the review", async () => {
      const lightningAddressInvoice = asked();
      const quoteInvoice = vi.fn(async (text: string) => {
        if (text === "inv-700") throw new Error("Not enough sats in your wallet: 690 sats leave room for the fee");
        return { quote: "q", mint: TEST_MINT, amount: 690, feeReserve: 10 };
      });
      const { user } = await start({ lightningAddressInvoice, quoteInvoice });
      await user.click(screen.getByTestId("lnurl-invoice"));
      expect(await screen.findByTestId("lnurl-review")).toHaveTextContent("690");
      expect(lightningAddressInvoice.mock.calls.map((call) => call[1])).toEqual([700, 690]);
    });

    it("a source that quotes all of it: the fee is taken off, so the review is one the card can pay", async () => {
      const lightningAddressInvoice = asked();
      const quoteInvoice = vi.fn(async (text: string) => ({ quote: "q", mint: "node", amount: Number(text.slice(4)), feeReserve: 7 }));
      const { user } = await start({ lightningAddressInvoice, quoteInvoice });
      await user.click(screen.getByTestId("lnurl-invoice"));
      expect(await screen.findByTestId("lnurl-review")).toHaveTextContent("693");
      expect(lightningAddressInvoice.mock.calls.map((call) => call[1])).toEqual([700, 693]);
    });

    it("what leaves room is below what the address takes: the refusal is said, and nothing more is asked", async () => {
      const lightningAddressInvoice = asked();
      const quoteInvoice = vi.fn(async () => { throw new Error("Not enough sats in your wallet: 3 sats leave room for the fee"); });
      const { user } = await start({ lightningAddressInvoice, quoteInvoice }, 10);
      await user.click(screen.getByTestId("lnurl-invoice"));
      expect(await screen.findByTestId("lnurl-error")).toBeInTheDocument();
      expect(lightningAddressInvoice).toHaveBeenCalledTimes(1);
    });

    it("an amount typed after Max is the person's: it is never changed, the refusal is said", async () => {
      const lightningAddressInvoice = asked();
      const quoteInvoice = vi.fn(async () => { throw new Error("Not enough sats in your wallet: 690 sats leave room for the fee"); });
      const { user } = await start({ lightningAddressInvoice, quoteInvoice });
      const field = screen.getByTestId("lnurl-amount");
      await user.clear(field);
      await user.type(field, "695");
      await user.click(screen.getByTestId("lnurl-invoice"));
      expect(await screen.findByTestId("lnurl-error")).toBeInTheDocument();
      expect(lightningAddressInvoice).toHaveBeenCalledTimes(1);
      expect(field).toHaveValue("695");
    });
  });

  describe("an invoice with no amount", () => {
    const quoted = (amount: number) => vi.fn(async () => ({ quote: "q-any", mint: TEST_MINT, amount, feeReserve: 2 }));
    /** The Lightning card on another source than the mints: a node, which is not asked for a chosen amount. */
    const onSource = (methods: Partial<WalletPlatform>) => {
      const base = networkState(walletView({ mode: "testnet", mints: [mint(TEST_MINT, 5_000)], balance: 5_000 }) as WalletState, "testnet");
      const state = { ...base, lightning: { mode: "testnet", providerId: "lnd", status: "ready", balance: 5_000, offered: [], recent: [] } } as unknown as WalletState;
      const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet), { getState: () => state, ...methods });
      return renderApp(<CashuWallet wallet={wallet} state={state} rail="lightning" onOpenCashu={() => {}} />);
    };

    it("asks how much, reviews that amount through the mints, and pays it", async () => {
      // One invoice, compared with itself: a second made later carries a later timestamp, so it differs.
      const invoice = anyAmount();
      qr.text = invoice;
      const quoteInvoice = quoted(700), payQuote = vi.fn(async () => true);
      const { user } = show({ quoteInvoice, payQuote });
      await user.click(screen.getByRole("tab", { name: "Send" }));
      await user.upload(screen.getByLabelText("Choose image"), picture());
      expect(await screen.findByTestId("wallet-pay-choose")).toHaveTextContent("This invoice has no amount: choose how much to pay.");
      expect(quoteInvoice).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: /^Pay$/ })).toBeDisabled();
      await user.type(screen.getByTestId("wallet-pay-amount"), "700");
      await user.click(screen.getByRole("button", { name: /^Pay 700/ }));
      expect(await screen.findByTestId("wallet-pay-review")).toHaveTextContent("Pay 700 test sats");
      expect(quoteInvoice).toHaveBeenCalledWith(invoice, "cashu", 700);
      await user.click(screen.getByTestId("wallet-pay-confirm"));
      expect(payQuote).toHaveBeenCalledWith("q-any", TEST_MINT, undefined, false);
    });

    it("on Mainnet the amount chosen still goes through the real-money confirmation", async () => {
      qr.text = anyAmount();
      const payQuote = vi.fn(async () => true);
      const { user } = show({ quoteInvoice: quoted(700), payQuote }, "mainnet");
      await user.click(screen.getByRole("tab", { name: "Send" }));
      await user.upload(screen.getByLabelText("Choose image"), picture());
      await user.type(await screen.findByTestId("wallet-pay-amount"), "700");
      await user.click(screen.getByRole("button", { name: /^Pay 700/ }));
      await user.click(await screen.findByTestId("wallet-pay-confirm"));
      expect(payQuote).not.toHaveBeenCalled();
      expect(screen.getByTestId("review-mainnet-confirm")).toHaveTextContent("Real money");
    });

    it("a mint that refuses says so, and the amount stays to change", async () => {
      qr.text = anyAmount();
      const { user } = show({ quoteInvoice: async () => { throw new Error("None of your mints can pay an invoice with no amount"); } });
      await user.click(screen.getByRole("tab", { name: "Send" }));
      await user.upload(screen.getByLabelText("Choose image"), picture());
      await user.type(await screen.findByTestId("wallet-pay-amount"), "700");
      await user.click(screen.getByRole("button", { name: /^Pay 700/ }));
      expect(await screen.findByTestId("wallet-error")).toHaveTextContent("None of your mints can pay an invoice with no amount");
      expect(screen.getByTestId("wallet-pay-amount")).toHaveValue("700");
    });

    describe("Max", () => {
      const start = async (methods: Partial<WalletPlatform>, balance = 700) => {
        qr.text = anyAmount();
        const rendered = show(methods, "testnet", balance);
        await rendered.user.click(screen.getByRole("tab", { name: "Send" }));
        await rendered.user.upload(screen.getByLabelText("Choose image"), picture());
        await screen.findByTestId("wallet-pay-choose");
        return rendered;
      };
      /** A mint that keeps 10 sats back for its fee. */
      const roomFor = (room: number) => vi.fn(async (_invoice: string, _via?: "cashu", amount?: number) => {
        if (amount! > room) throw new Error(`Not enough sats in your wallet: ${room} sats leave room for the fee`);
        return { quote: "q-any", mint: TEST_MINT, amount: amount!, feeReserve: 10 };
      });

      it("fills all the card holds, shows it, and is a phone-sized button that does not submit", async () => {
        const quoteInvoice = roomFor(690);
        const { user } = await start({ quoteInvoice });
        expect(screen.getByTestId("wallet-pay-balance")).toHaveTextContent("Balance: 700 test sats");
        const max = screen.getByTestId("wallet-pay-max");
        expect(max.className).toContain("max-md:min-h-11");
        await user.click(max);
        expect(screen.getByTestId("wallet-pay-amount")).toHaveValue("700");
        expect(quoteInvoice).not.toHaveBeenCalled();
      });

      it("comes down to what leaves room for the fee, and goes to that review", async () => {
        const quoteInvoice = roomFor(690);
        const { user } = await start({ quoteInvoice });
        await user.click(screen.getByTestId("wallet-pay-max"));
        await user.click(screen.getByRole("button", { name: /^Pay 700/ }));
        expect(await screen.findByTestId("wallet-pay-review")).toHaveTextContent("Pay 690 test sats");
        expect(quoteInvoice.mock.calls.map((call) => call[2])).toEqual([700, 690]);
      });

      it("an amount typed over Max is the person's: it is refused, never lowered", async () => {
        const quoteInvoice = roomFor(690);
        const { user } = await start({ quoteInvoice });
        await user.click(screen.getByTestId("wallet-pay-max"));
        const field = screen.getByTestId("wallet-pay-amount");
        await user.clear(field);
        await user.type(field, "695");
        await user.click(screen.getByRole("button", { name: /^Pay 695/ }));
        expect(await screen.findByTestId("wallet-error")).toHaveTextContent("Not enough sats");
        expect(quoteInvoice).toHaveBeenCalledTimes(1);
        expect(field).toHaveValue("695");
      });

      it("a refusal for another reason stays, and is not asked again", async () => {
        const quoteInvoice = vi.fn(async () => { throw new Error("None of your mints can pay an invoice with no amount"); });
        const { user } = await start({ quoteInvoice });
        await user.click(screen.getByTestId("wallet-pay-max"));
        await user.click(screen.getByRole("button", { name: /^Pay 700/ }));
        expect(await screen.findByTestId("wallet-error")).toHaveTextContent("None of your mints can pay an invoice with no amount");
        expect(quoteInvoice).toHaveBeenCalledTimes(1);
      });

      it("is not offered on an empty card", async () => {
        await start({ quoteInvoice: roomFor(0) }, 0);
        expect(screen.queryByTestId("wallet-pay-max")).toBeNull();
      });
    });

    it("the amount typed for one invoice does not carry over to the next thing given", async () => {
      qr.text = anyAmount();
      const { user } = show({ quoteInvoice: quoted(700) });
      await user.click(screen.getByRole("tab", { name: "Send" }));
      await user.upload(screen.getByLabelText("Choose image"), picture());
      await user.type(await screen.findByTestId("wallet-pay-amount"), "700");
      await user.upload(screen.getByLabelText("Choose image"), picture());
      await waitFor(() => expect(screen.getByTestId("wallet-pay-amount")).toHaveValue(""));
    });

    it("past its expiry it is not paid, whatever the amount", async () => {
      // Made two hours ago, good for one.
      const now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now - 2 * 3_600_000);
      const { words } = bech32.decode(fakeInvoice(1, new Uint8Array(32).fill(8)) as `${string}1${string}`, false);
      clock.mockRestore();
      qr.text = bech32.encode("lnbcrt", words, false);
      const { user } = show({ quoteInvoice: quoted(700) });
      await user.click(screen.getByRole("tab", { name: "Send" }));
      await user.upload(screen.getByLabelText("Choose image"), picture());
      await user.type(await screen.findByTestId("wallet-pay-amount"), "700");
      expect(screen.getByRole("button", { name: /^Pay/ })).toBeDisabled();
    });

    it("a source that is not the mints asks no amount: it is said plainly, and nothing is quoted", async () => {
      qr.text = anyAmount();
      const quoteInvoice = vi.fn();
      const { user } = onSource({ quoteInvoice });
      await user.click(screen.getByRole("tab", { name: "Send" }));
      await user.upload(screen.getByLabelText("Choose image"), picture());
      expect(await screen.findByTestId("wallet-pay-no-amount")).toHaveTextContent("This invoice has no amount.");
      expect(screen.queryByTestId("wallet-pay-amount")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^Pay$/ })).toBeDisabled();
      expect(quoteInvoice).not.toHaveBeenCalled();
    });
  });

  it("a token's Redeemed goes once the field is typed in again, so it never stands beside the next payment's result", async () => {
    const { user } = show({ receiveToken: async () => ({ amount: 1_000, fee: 0 }) });
    await user.click(screen.getByRole("tab", { name: "Send" }));
    await user.type(screen.getByTestId("wallet-pay-input"), "cashuBo2F0gaJhaUgA");
    await user.click(screen.getByRole("button", { name: /^Redeem/ }));
    expect(await screen.findByTestId("wallet-notice")).toHaveTextContent("Redeemed 1,000 test sats.");

    await user.type(screen.getByTestId("wallet-pay-input"), "l");
    expect(screen.queryByTestId("wallet-notice")).not.toBeInTheDocument();
  });

  // agents#2255: at a mint that charges to take ecash in, a 3-sat token said only "Redeemed 1 test sats.": the 2 the mint
  // kept showed only later, in History.
  it.each([
    ["testnet", { amount: 1, fee: 2 }, "Redeemed 1 test sat (the mint kept 2 as its fee)."],
    ["testnet", { amount: 1_000, fee: 3 }, "Redeemed 1,000 test sats (the mint kept 3 as its fee)."],
    ["mainnet", { amount: 1, fee: 1 }, "Redeemed 1 sat (the mint kept 1 as its fee)."],
    ["mainnet", { amount: 62, fee: 2 }, "Redeemed 62 sats (the mint kept 2 as its fee)."],
  ] as const)("a token redeemed on %s at a mint that kept a fee says what arrived and what the mint kept: %j", async (network, received, notice) => {
    const { user } = show({ receiveToken: async () => received }, network);
    await user.click(screen.getByRole("tab", { name: "Send" }));
    await user.type(screen.getByTestId("wallet-pay-input"), "cashuBo2F0gaJhaUgA");
    await user.click(screen.getByRole("button", { name: /^Redeem/ }));
    expect(await screen.findByTestId("wallet-notice")).toHaveTextContent(notice);
  });

  it("a QR that is no payment, or no QR at all, is said plainly", async () => {
    const quoteInvoice = vi.fn();
    const { user } = show({ quoteInvoice });
    await user.click(screen.getByRole("tab", { name: "Send" }));

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

  describe("Send opening with the camera", () => {
    const track = { stop: vi.fn() };
    const camera = () => { qr.camera = { getTracks: () => [track] } as unknown as MediaStream; };
    const touch = (only: boolean) => vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ media: query, matches: query === "(any-pointer: coarse)" ? only : query === "(any-pointer: fine)" ? !only : false, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }));
    beforeEach(() => {
      track.stop.mockClear();
      vi.spyOn(HTMLMediaElement.prototype, "srcObject", "set").mockImplementation(() => {});
      vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    });
    afterEach(() => { vi.restoreAllMocks(); });

    it("on a phone the camera runs as Send opens, with the keyboard left down", async () => {
      touch(true); camera();
      const { user } = show({});
      await user.click(screen.getByRole("tab", { name: "Send" }));
      expect(await screen.findByTestId("wallet-send-scan-stop")).toBeInTheDocument();
      expect(screen.getByTestId("wallet-pay-input")).not.toHaveFocus();
    });

    it("with a mouse or trackpad the camera waits for Scan", async () => {
      touch(false); camera();
      const { user } = show({});
      await user.click(screen.getByRole("tab", { name: "Send" }));
      expect(screen.getByTestId("wallet-send-camera")).toBeInTheDocument();
      expect(screen.queryByTestId("wallet-send-scan-stop")).not.toBeInTheDocument();
      expect(screen.getByTestId("wallet-pay-input")).toHaveFocus();
    });

    it("no camera, or none allowed: nothing is said until the person presses Scan", async () => {
      touch(true);
      const { user } = show({});
      await user.click(screen.getByRole("tab", { name: "Send" }));
      const scan = await screen.findByTestId("wallet-send-camera");
      await waitFor(() => expect(scan).not.toHaveAttribute("aria-disabled"));
      expect(screen.queryByTestId("wallet-send-scan-error")).not.toBeInTheDocument();
      await user.click(scan);
      expect(await screen.findByTestId("wallet-send-scan-error")).toHaveTextContent("Camera unavailable");
    });

    it("Paste and Choose image work while the camera runs, and stop it", async () => {
      touch(true); camera();
      qr.clipboard = "shop@example.com";
      const { user } = show({});
      await user.click(screen.getByRole("tab", { name: "Send" }));
      await screen.findByTestId("wallet-send-scan-stop");
      await user.click(screen.getByTestId("wallet-send-paste"));
      expect(screen.getByTestId("wallet-pay-input")).toHaveValue("shop@example.com");
      expect(track.stop).toHaveBeenCalled();
      expect(screen.queryByTestId("wallet-send-scan-stop")).not.toBeInTheDocument();
    });

    it("Paste works while the camera's question stands, and a camera allowed after it is let go", async () => {
      touch(true); camera();
      let allow = () => {};
      qr.asked = new Promise((resolve) => { allow = resolve; });
      qr.clipboard = "shop@example.com";
      try {
        const { user } = show({});
        await user.click(screen.getByRole("tab", { name: "Send" }));
        // Scan has asked already, and does not ask twice.
        expect(screen.getByTestId("wallet-send-camera")).toHaveAttribute("aria-disabled", "true");
        expect(screen.getByTestId("wallet-send-paste")).not.toHaveAttribute("aria-disabled");
        await user.click(screen.getByTestId("wallet-send-paste"));
        expect(screen.getByTestId("wallet-pay-input")).toHaveValue("shop@example.com");

        allow();
        await waitFor(() => expect(track.stop).toHaveBeenCalled());
        expect(screen.queryByTestId("wallet-send-scan-stop")).not.toBeInTheDocument();
        expect(screen.getByTestId("wallet-send-camera")).not.toHaveAttribute("aria-disabled");
      } finally { qr.asked = null; }
    });

    it("Choose image works while the camera's question stands", async () => {
      touch(true); camera();
      qr.asked = new Promise(() => {});
      qr.text = invoice;
      try {
        const { user } = show({ quoteInvoice: async () => ({ quote: "q-6", mint: TEST_MINT, amount: 21, feeReserve: 0 }) });
        await user.click(screen.getByRole("tab", { name: "Send" }));
        await user.upload(screen.getByTestId("wallet-send-image"), picture());
        expect(await screen.findByText(/Two coffees/)).toBeInTheDocument();
      } finally { qr.asked = null; }
    });

    it("typing in the field stops the camera, and Scan starts it again", async () => {
      touch(true); camera();
      const { user } = show({});
      await user.click(screen.getByRole("tab", { name: "Send" }));
      await screen.findByTestId("wallet-send-scan-stop");
      await user.click(screen.getByTestId("wallet-pay-input"));
      expect(track.stop).toHaveBeenCalled();
      expect(screen.queryByTestId("wallet-send-scan-stop")).not.toBeInTheDocument();
      await user.keyboard("shop@example.com");
      expect(screen.getByTestId("wallet-pay-input")).toHaveValue("shop@example.com");
      expect(screen.getByTestId("wallet-pay-input")).toHaveFocus();
      await user.click(screen.getByTestId("wallet-send-camera"));
      expect(await screen.findByTestId("wallet-send-scan-stop")).toBeInTheDocument();
    });

    it("a field taken while the camera's question stands lets go of a camera allowed after it", async () => {
      touch(true); camera();
      let allow = () => {};
      qr.asked = new Promise((resolve) => { allow = resolve; });
      try {
        const { user } = show({});
        await user.click(screen.getByRole("tab", { name: "Send" }));
        expect(screen.getByTestId("wallet-send-camera")).toHaveAttribute("aria-disabled", "true");
        await user.click(screen.getByTestId("wallet-pay-input"));
        expect(screen.getByTestId("wallet-send-camera")).not.toHaveAttribute("aria-disabled");
        allow();
        await waitFor(() => expect(track.stop).toHaveBeenCalled());
        expect(screen.queryByTestId("wallet-send-scan-stop")).not.toBeInTheDocument();
      } finally { qr.asked = null; }
    });

    it("back from a review the camera stays off: it was started for opening Send", async () => {
      touch(true); camera();
      qr.text = invoice;
      const { user } = show({ quoteInvoice: async () => ({ quote: "q-5", mint: TEST_MINT, amount: 21, feeReserve: 0 }) });
      await user.click(screen.getByRole("tab", { name: "Send" }));
      await screen.findByTestId("wallet-send-scan-stop");
      await user.upload(screen.getByLabelText("Choose image"), picture());
      await user.click(within(await screen.findByTestId("wallet-pay-review")).getByRole("button", { name: "Cancel" }));
      expect(await screen.findByTestId("wallet-send-camera")).toBeInTheDocument();
      expect(screen.queryByTestId("wallet-send-scan-stop")).not.toBeInTheDocument();
    });

    it("leaving Send stops the camera", async () => {
      touch(true); camera();
      const { user } = show({});
      await user.click(screen.getByRole("tab", { name: "Send" }));
      await screen.findByTestId("wallet-send-scan-stop");
      await user.click(screen.getByRole("tab", { name: "Receive" }));
      expect(track.stop).toHaveBeenCalled();
    });
  });
});

// covers: wallet.ark.send-scan
describe("the Ark and Bark cards' Send", () => {
  /** Arkade: version byte 0 and two 32-byte keys. */
  const arkade = (prefix: "ark" | "tark") => bech32m.encode(prefix, bech32m.toWords(new Uint8Array(65).fill(7, 1)), 1023);
  /** Bark: version 1 as its first character, then a 4-byte Ark ID and a policy with its length. */
  const bark = (prefix: "ark" | "tark") => bech32m.encode(prefix, [1, ...bech32m.toWords(Uint8Array.from([1, 2, 3, 4, 33, ...new Array<number>(33).fill(9)]))], 1023);
  const REGTEST_BTC = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";
  const picture = () => new File([new Uint8Array([137, 80, 78, 71])], "qr.png", { type: "image/png" });

  describe("what an Ark card's Send was given", () => {
    it("an address of its kind and network, or a link's address and amount", () => {
      expect(routeArkSend(` ${arkade("tark")} `, "arkade", "testnet")).toEqual({ kind: "address", address: arkade("tark") });
      expect(routeArkSend(arkade("tark").toUpperCase(), "arkade", "testnet")).toEqual({ kind: "address", address: arkade("tark") });
      expect(routeArkSend(`bitcoin:?ark=${bark("tark")}&amount=0.00001`, "bark", "testnet")).toEqual({ kind: "address", address: bark("tark"), amountSat: 1_000 });
    });

    it("the other Ark, or the other network, is not this card's: they never pay each other", () => {
      expect(routeArkSend(bark("tark"), "arkade", "testnet")).toEqual({ kind: "unknown" });
      expect(routeArkSend(arkade("tark"), "bark", "testnet")).toEqual({ kind: "unknown" });
      expect(routeArkSend(arkade("ark"), "arkade", "testnet")).toEqual({ kind: "unknown" });
      expect(routeArkSend(`bitcoin:${REGTEST_BTC}`, "arkade", "testnet")).toEqual({ kind: "unknown" });
      expect(routeArkSend("https://example.com/menu", "arkade", "testnet")).toEqual({ kind: "unknown" });
      expect(routeArkSend(`see ${arkade("tark")} please`, "arkade", "testnet")).toEqual({ kind: "unknown" });
    });

    it("a link that must not be paid is refused", () => {
      expect(routeArkSend(`bitcoin:?ark=${arkade("tark")}&req-pop=x`, "arkade", "testnet")).toEqual({ kind: "refused" });
      expect(routeArkSend(`bitcoin:?ark=${arkade("tark")}&amount=lots`, "arkade", "testnet")).toEqual({ kind: "refused" });
    });
  });

  describe("Send on the Ark and Bark cards: scan, paste or picture", () => {
    beforeEach(() => { qr.text = null; qr.clipboard = null; });
    const ready = { configured: true, locked: false, network: "regtest" as const, provider: "http://127.0.0.1:1", balance: 5_000 };
    const panels = [
      ["Ark", () => <ArkWalletPanel wallet={servicesPlatform!.wallet} state={walletView({ mode: "testnet", ark: { ...ready, address: arkade("tark") } }) as WalletState} />, arkade("tark"), bark("tark")],
      ["Bark", () => <BarkWalletPanel wallet={servicesPlatform!.wallet} state={walletView({ mode: "testnet", bark: { ...ready, address: bark("tark") } }) as WalletState} />, bark("tark"), arkade("tark")],
    ] as const;

    describe.each(panels)("%s", (name, panel, mine, other) => {
      const show = async () => {
        const rendered = renderApp(panel());
        await rendered.user.click(screen.getByRole("tab", { name: "Send" }));
        return rendered;
      };
      const field = () => screen.getByLabelText(`${name} recipient address`);

      it("a phone's keyboard is told not to change a typed address", async () => {
        await show();
        expect(field()).toHaveAttribute("autocapitalize", "none");
        expect(field()).toHaveAttribute("autocorrect", "off");
        expect(field()).toHaveAttribute("spellcheck", "false");
      });

      it("a picture of a link fills the address and the amount, and nothing is reviewed until the person asks", async () => {
        qr.text = `bitcoin:?ark=${mine}&amount=0.00001`;
        const { user, engine } = await show();
        await user.upload(screen.getByLabelText("Choose image"), picture());
        expect(await screen.findByDisplayValue(mine)).toBe(field());
        expect(screen.getByDisplayValue("1000")).toBeInTheDocument();
        expect(engine.callsTo("preparePayment")).toEqual([]);
      });

      it("Paste of a bare address fills it, and the amount meant for the last one goes", async () => {
        const { user } = await show();
        await user.type(screen.getByLabelText(/^Amount/), "700");
        qr.clipboard = mine.toUpperCase();
        await user.click(screen.getByTestId("wallet-send-paste"));
        expect(await screen.findByDisplayValue(mine)).toBe(field());
        expect(screen.queryByDisplayValue("700")).not.toBeInTheDocument();
      });

      it("the other Ark's address fills nothing, and says so; a link that must not be paid is refused", async () => {
        qr.text = other;
        const { user } = await show();
        await user.upload(screen.getByLabelText("Choose image"), picture());
        expect(await screen.findByTestId("wallet-send-unknown")).toHaveTextContent(`That is not a ${name} address for this wallet.`);
        expect(field()).toHaveValue("");
        qr.text = `bitcoin:?ark=${mine}&req-pop=x`;
        await user.upload(screen.getByLabelText("Choose image"), picture());
        expect(await screen.findByTestId("wallet-send-refused")).toHaveTextContent("This link asks for something this app does not understand");
        expect(field()).toHaveValue("");
      });
    });
  });
});

// covers: wallet.onchain.send-scan
describe("the Bitcoin card's Send", () => {
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

    it("a phone's keyboard is told not to change a typed address: with a capital first letter it is no address", async () => {
      await show();
      const field = screen.getByLabelText("Bitcoin recipient address");
      expect(field).toHaveAttribute("autocapitalize", "none");
      expect(field).toHaveAttribute("autocorrect", "off");
      expect(field).toHaveAttribute("spellcheck", "false");
      expect(routeBitcoinSend(`B${REGTEST.slice(1)}`, "regtest")).toEqual({ kind: "unknown" });
    });

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

    it("a link typed a key at a time stays in the field as it is typed, and is read once the field is left", async () => {
      const { user } = await show();
      const field = screen.getByLabelText("Bitcoin recipient address");
      await user.type(field, `bitcoin:${REGTEST}?amount=0.00001`);
      expect(field).toHaveValue(`bitcoin:${REGTEST}?amount=0.00001`);
      expect(screen.queryByTestId("bitcoin-send-unknown")).not.toBeInTheDocument();
      expect(screen.queryByTestId("bitcoin-send-refused")).not.toBeInTheDocument();
      await user.tab();
      expect(field).toHaveValue(REGTEST);
      expect(screen.getByTestId("bitcoin-amount")).toHaveValue("1000");
    });

    it("a typed link that fills nothing stays to be put right, and says so once the field is left", async () => {
      const { user } = await show();
      const field = screen.getByLabelText("Bitcoin recipient address");
      await user.type(field, "bitcoin:");
      expect(field).toHaveValue("bitcoin:");
      expect(screen.queryByTestId("bitcoin-send-unknown")).not.toBeInTheDocument();
      await user.type(screen.getByTestId("bitcoin-amount"), "1000");
      expect(field).toHaveValue("bitcoin:");
      expect(screen.getByTestId("bitcoin-send-unknown")).toHaveTextContent("That is not a Bitcoin address for this wallet.");
      expect(screen.getByRole("button", { name: "Review payment" })).toBeDisabled();
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
});

// covers: wallet.spark.send
describe("Send on the Spark card: scan, paste or picture", () => {
  /** Made by the Breez SDK on Breez's regtest (walletPanels.test.tsx): a wallet's address, and an invoice of 1234 sats ("probe"). */
  const ADDRESS = "sparkrt1pgss87y4e569hncpt9649q5s6x7c3vv9lqwrjlucxfl3a3kk355a3pfkwf2mtr";
  const INVOICE = "sparkrt1pgss87y4e569hncpt9649q5s6x7c3vv9lqwrjlucxfl3a3kk355a3pfkzg5qsqgjzqq6p4sscrm8avymnelqhzrus7wz5ptswfhkyef6qcydm9xh65rzyqcg6gy35sxa3w5e20exjmr8xhyl96u3cxqk9ttgwes2xkfepzpp5nmw3zu5aczluq5t2fly3venjcv3cn9fvmtjgwcaae4fw2rqw4fy0nwd082rg0zclp2";
  const picture = () => new File([new Uint8Array([137, 80, 78, 71])], "qr.png", { type: "image/png" });

  beforeEach(() => { qr.text = null; qr.clipboard = null; qr.camera = null; });
  const show = async () => {
    const state = walletView({ mode: "testnet", spark: { configured: true, locked: false, network: "regtest", address: ADDRESS, balance: 5_000, history: [] } }) as WalletState;
    const rendered = renderApp(<SparkWalletPanel wallet={servicesPlatform!.wallet} state={state} />);
    await rendered.user.click(screen.getByTestId("wallet-send"));
    return rendered;
  };

  it("a phone's keyboard is told not to change a typed address", async () => {
    await show();
    const field = screen.getByLabelText("Spark address or invoice");
    expect(field).toHaveAttribute("autocapitalize", "none");
    expect(field).toHaveAttribute("autocorrect", "off");
    expect(field).toHaveAttribute("spellcheck", "false");
  });

  it("a picture of an address fills it, and asks the amount; nothing is reviewed until the person asks", async () => {
    qr.text = ADDRESS;
    const { user, engine } = await show();
    await user.upload(screen.getByLabelText("Choose image"), picture());
    expect(await screen.findByDisplayValue(ADDRESS)).toBeInTheDocument();
    expect(screen.getByTestId("spark-amount")).toHaveValue("");
    expect(engine.callsTo("preparePayment")).toEqual([]);
  });

  it("a QR's upper case reads as Spark's own lower case", async () => {
    qr.text = ADDRESS.toUpperCase();
    const { user } = await show();
    await user.upload(screen.getByLabelText("Choose image"), picture());
    expect(await screen.findByDisplayValue(ADDRESS)).toBeInTheDocument();
    expect(screen.queryByTestId("spark-address-invalid")).not.toBeInTheDocument();
  });

  it("Paste of an invoice shows its amount, and the amount typed for the last address goes", async () => {
    const { user } = await show();
    await user.type(screen.getByTestId("spark-amount"), "700");
    qr.clipboard = INVOICE;
    await user.click(screen.getByTestId("wallet-send-paste"));
    expect(await screen.findByTestId("spark-invoice-summary")).toHaveTextContent("1,234");
    qr.clipboard = ADDRESS;
    await user.click(screen.getByTestId("wallet-send-paste"));
    expect(await screen.findByTestId("spark-amount")).toHaveValue("");
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

  it("what is no Spark address is said, and cannot be reviewed", async () => {
    qr.text = "https://example.com/menu";
    const { user } = await show();
    await user.upload(screen.getByLabelText("Choose image"), picture());
    expect(await screen.findByTestId("spark-address-invalid")).toBeInTheDocument();
    expect(screen.getByTestId("spark-review")).toBeDisabled();
  });
});

// covers: wallet.usdt.send-scan
describe("the USDT card's Send", () => {
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

    it("a phone's keyboard is told not to change a typed address", async () => {
      await show();
      expect(field()).toHaveAttribute("autocapitalize", "none");
      expect(field()).toHaveAttribute("autocorrect", "off");
      expect(field()).toHaveAttribute("spellcheck", "false");
    });

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

    it("a link typed a key at a time stays in the field as it is typed, and is read once the field is left", async () => {
      const { user } = await show();
      await user.type(field(), `ethereum:${TO}@11155111`);
      expect(field()).toHaveValue(`ethereum:${TO}@11155111`);
      expect(screen.queryByTestId("wallet-send-unknown")).not.toBeInTheDocument();
      await user.tab();
      expect(field()).toHaveValue(TO);
    });

    it("a typed link that fills nothing stays to be put right, and says so once the field is left", async () => {
      const { user } = await show();
      await user.type(field(), "ethereum:");
      expect(field()).toHaveValue("ethereum:");
      expect(screen.queryByTestId("wallet-send-unknown")).not.toBeInTheDocument();
      await user.tab();
      expect(field()).toHaveValue("ethereum:");
      expect(screen.getByTestId("wallet-send-unknown")).toBeInTheDocument();
    });

    it("another chain's link fills nothing, and says so", async () => {
      qr.text = `ethereum:${TO}@1`;
      const { user } = await show();
      await user.upload(screen.getByLabelText("Choose image"), picture());
      expect(await screen.findByTestId("wallet-send-unknown")).toHaveTextContent("That is not a USDT address for this wallet.");
      expect(field()).toHaveValue("");
    });
  });
});

// covers: wallet.cashu.pay-invoice, wallet.cashu.send-scan
describe("Send sorts what it was given", () => {
  /** An invoice that lets the payer choose the amount: the fake regtest one with no amount in its prefix. */
  const anyAmount = () => {
    const { words } = bech32.decode(fakeInvoice(1, new Uint8Array(32).fill(7)) as `${string}1${string}`, false);
    return bech32.encode("lnbcrt", words, false);
  };

  it("an invoice, as typed, scanned in upper case or behind lightning:", () => {
    for (const text of [REGTEST_INVOICE, REGTEST_INVOICE.toUpperCase(), `lightning:${REGTEST_INVOICE}`, `LIGHTNING:${REGTEST_INVOICE.toUpperCase()}`, `  ${REGTEST_INVOICE}\n`]) {
      const route = routeSend(text);
      expect(route.kind).toBe("invoice");
      if (route.kind === "invoice") {
        expect(route.text).toBe(REGTEST_INVOICE);
        expect(route.invoice.amountSat).toBe(250_000);
      }
    }
  });

  it("a BIP 21 link pays by its lightning= leg, and without one it is not this card's", () => {
    const route = routeSend(`bitcoin:bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080?amount=0.0025&lightning=${REGTEST_INVOICE}`);
    expect(route).toMatchObject({ kind: "invoice", text: REGTEST_INVOICE });
    expect(routeSend(`BITCOIN:?LIGHTNING=${REGTEST_INVOICE.toUpperCase()}`)).toMatchObject({ kind: "invoice", text: REGTEST_INVOICE });
    expect(routeSend("bitcoin:bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080?amount=0.001").kind).toBe("unknown");
    expect(routeSend("bitcoin:bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080?lightning=nonsense").kind).toBe("unknown");
  });

  it("a BIP 21 link's lightning= leg only as the chat reads the same link: the same payment, and a link that may be paid", () => {
    const address = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";
    // The fallback asks 25 times the link's amount: not the same payment, so it is not paid from here.
    expect(routeSend(`bitcoin:${address}?amount=0.0001&lightning=${REGTEST_INVOICE}`).kind).toBe("unknown");
    // A req- parameter this app does not understand (BIP 21), or an amount it cannot read: the link is not paid at all.
    expect(routeSend(`bitcoin:${address}?amount=0.0025&req-pop=x&lightning=${REGTEST_INVOICE}`).kind).toBe("refused");
    expect(routeSend(`bitcoin:?req-pop=x&lightning=${REGTEST_INVOICE}`).kind).toBe("refused");
    expect(routeSend(`bitcoin:?amount=abc&lightning=${REGTEST_INVOICE}`).kind).toBe("refused");
    // A link with no address whose invoice asks another amount than the link: not the same payment.
    expect(routeSend(`bitcoin:?amount=0.00001&lightning=${REGTEST_INVOICE}`).kind).toBe("refused");
    expect(routeSend(`bitcoin:?amount=0.0025&lightning=${REGTEST_INVOICE}`).kind).toBe("invoice");
    // A req- parameter it does understand is no reason to refuse.
    expect(routeSend(`bitcoin:${address}?amount=0.0025&req-lightning=${REGTEST_INVOICE}&lightning=${REGTEST_INVOICE}`).kind).toBe("invoice");
  });

  it("an invoice with no amount is told apart", () => {
    const route = routeSend(anyAmount());
    expect(route.kind).toBe("no-amount");
  });

  it("a Lightning address and an LNURL-pay", () => {
    expect(routeSend("Satoshi@Example.com")).toEqual({ kind: "destination", text: "satoshi@example.com" });
    expect(routeSend("lightning:satoshi@example.com")).toEqual({ kind: "destination", text: "satoshi@example.com" });
    const lnurl = bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode("https://example.com/lnurlp/satoshi")), 2000);
    expect(routeSend(lnurl.toUpperCase())).toEqual({ kind: "destination", text: lnurl });
    expect(routeSend("lnurlp://example.com/pay")).toEqual({ kind: "destination", text: "lnurlp://example.com/pay" });
  });

  it("an LNURL that must not be asked says why", () => {
    const lnurl = bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode("http://example.com/pay")), 2000);
    const route = routeSend(lnurl);
    expect(route.kind).toBe("bad-destination");
    if (route.kind === "bad-destination") expect(String(route.error)).toMatch(/HTTPS/);
  });

  it("an ecash token, nothing, and anything else", () => {
    expect(routeSend("cashuBo2F0gaJhaUgA")).toEqual({ kind: "token", text: "cashuBo2F0gaJhaUgA" });
    expect(routeSend("   ").kind).toBe("empty");
    expect(routeSend("hello there").kind).toBe("unknown");
    expect(routeSend("lnbc-this-is-not-an-invoice").kind).toBe("unknown");
    expect(routeSend("https://example.com").kind).toBe("unknown");
  });

  it("a token behind the cashu: URI scheme (cashu:, cashu://, web+cashu://) is the token, given on bare", () => {
    for (const scheme of ["cashu:", "cashu://", "web+cashu://"]) {
      expect(routeSend(` ${scheme}cashuBo2F0gaJhaUgA\n`)).toEqual({ kind: "token", text: "cashuBo2F0gaJhaUgA" });
    }
    expect(routeSend("cashu:").kind).toBe("unknown");
    expect(routeSend("cashu:hello").kind).toBe("unknown");
  });
});
