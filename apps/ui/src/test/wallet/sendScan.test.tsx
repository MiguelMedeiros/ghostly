import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      qr.text = anyAmount();
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
      expect(quoteInvoice).toHaveBeenCalledWith(anyAmount(), "cashu", 700);
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
    const { user } = show({ receiveToken: async () => 1_000 });
    await user.click(screen.getByRole("tab", { name: "Send" }));
    await user.type(screen.getByTestId("wallet-pay-input"), "cashuBo2F0gaJhaUgA");
    await user.click(screen.getByRole("button", { name: /^Redeem/ }));
    expect(await screen.findByTestId("wallet-notice")).toHaveTextContent("Redeemed 1,000 test sats.");

    await user.type(screen.getByTestId("wallet-pay-input"), "l");
    expect(screen.queryByTestId("wallet-notice")).not.toBeInTheDocument();
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
