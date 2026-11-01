import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SparkWalletPanel } from "../../components/SparkWalletPanel";
import { servicesPlatform, type WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: wallet.spark.send

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

/** Made by the Breez SDK on Breez's regtest (sparkPanel.test.tsx): a wallet's address, and an invoice of 1234 sats ("probe"). */
const ADDRESS = "sparkrt1pgss87y4e569hncpt9649q5s6x7c3vv9lqwrjlucxfl3a3kk355a3pfkwf2mtr";
const INVOICE = "sparkrt1pgss87y4e569hncpt9649q5s6x7c3vv9lqwrjlucxfl3a3kk355a3pfkzg5qsqgjzqq6p4sscrm8avymnelqhzrus7wz5ptswfhkyef6qcydm9xh65rzyqcg6gy35sxa3w5e20exjmr8xhyl96u3cxqk9ttgwes2xkfepzpp5nmw3zu5aczluq5t2fly3venjcv3cn9fvmtjgwcaae4fw2rqw4fy0nwd082rg0zclp2";
const picture = () => new File([new Uint8Array([137, 80, 78, 71])], "qr.png", { type: "image/png" });

describe("Send on the Spark card: scan, paste or picture", () => {
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
