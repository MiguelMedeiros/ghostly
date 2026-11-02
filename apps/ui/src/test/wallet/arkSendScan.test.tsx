import { screen } from "@testing-library/react";
import { bech32m } from "@scure/base";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArkWalletPanel } from "../../components/ArkWalletPanel";
import { BarkWalletPanel } from "../../components/BarkWalletPanel";
import { routeArkSend } from "../../lib/sendRoute";
import { servicesPlatform, type WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: wallet.ark.send-scan

const qr = vi.hoisted(() => ({ text: null as string | null, clipboard: null as string | null }));
vi.mock("../../lib/qrReader", async (original) => ({
  ...await original<typeof import("../../lib/qrReader")>(),
  readQrImage: async () => qr.text,
}));
vi.mock("../../lib/clipboard", async (original) => ({
  ...await original<typeof import("../../lib/clipboard")>(),
  readClipboardText: async () => qr.clipboard,
}));

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
