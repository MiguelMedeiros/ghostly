import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SourceView } from "@ghostly/browser/engine/paymentAdapters/providers/sources";
import { SourcePicker } from "../../components/wallet/providers/SourcePicker";
import { renderApp } from "../render";
import { descriptor, offered, sourceView } from "./descriptors";
import type { UserEvent } from "@testing-library/user-event";
import { choose, optionsOf } from "../select";

// covers: wallet.lightning.sources, wallet.onchain.sources, wallet.instances.networks

type Kind = "lightning" | "onchain";

function picker(kind: Kind, view: SourceView, { onSet = vi.fn(async () => {}), onClear = vi.fn(async () => {}) }: { onSet?: (id: string, values: Record<string, string>) => Promise<void>; onClear?: () => Promise<void> } = {}) {
  return { onSet, onClear, ...renderApp(<SourcePicker kind={kind} view={view} onSet={onSet} onClear={onClear} />) };
}

const status = (kind: Kind = "lightning") => screen.getByTestId(`${kind}-source-status`);
/** The Lightning select's options, as "name · description". */
const options = async (user: UserEvent) => (await optionsOf(user, screen.getByTestId("lightning-source-select"))).map((o) => ({ ...o, text: [o.label, o.description].filter(Boolean).join(" · ") }));

/** Wallet → a card's Source: which provider pays and receives, and how to change it. */
describe("SourcePicker", () => {
  describe("the source in use", () => {
    it("says there is none, and offers every provider that runs here", async () => {
      const { user } = picker("lightning", sourceView({ offered: offered("lightning", "mainnet") }));
      expect(screen.getByTestId("lightning-source-current")).toHaveTextContent("No source");
      expect(status()).toHaveTextContent("Not set up");
      expect(screen.getByText("Choose a source")).toBeInTheDocument();
      expect(screen.queryByTestId("lightning-source-clear")).not.toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: "Lightning source" })).toHaveTextContent("5 available…");
      // Registry order; custodial and experimental ones say so.
      expect((await options(user)).map((o) => o.text)).toEqual([
        "Cashu mints · Custodial",
        "Nostr Wallet Connect",
        "Core Lightning",
        "Browser wallet (WebLN) · Experimental",
        "LND node · Experimental",
      ]);
    });

    it("shows the default Cashu mints as in use, without a way to remove them", async () => {
      const { user } = picker("lightning", sourceView({ offered: offered("lightning", "mainnet"), providerId: "cashu-mint", label: "Cashu mints", isDefault: true, custodial: true, status: "ready", network: "bitcoin" }));
      expect(screen.getByTestId("lightning-source-current")).toHaveTextContent("Cashu mintsDefault");
      // Bitcoin is real money: no network named. Custodial is.
      expect(status()).toHaveTextContent(/^Connected · custodial$/);
      expect(screen.getByText("Change source")).toBeInTheDocument();
      expect(screen.queryByTestId("lightning-source-clear")).not.toBeInTheDocument();
      // Picking it again would change nothing: nothing to configure and already connected.
      const cashu = (await options(user)).find((o) => o.label === "Cashu mints")!;
      expect(cashu).toMatchObject({ text: "Cashu mints · Custodial · In use", disabled: true });
    });

    it("composes the status line from the connection, the node's alias and a test network", async () => {
      const { user } = picker("lightning", sourceView({ mode: "testnet", offered: offered("lightning", "testnet"), providerId: "nwc", label: "Nostr Wallet Connect", status: "ready", alias: "Alby Hub", network: "signet" }));
      expect(status()).toHaveTextContent(/^Connected · Alby Hub · signet$/);
      // A source with fields can be picked again, to change them.
      const nwc = (await options(user)).find((o) => o.label === "Nostr Wallet Connect")!;
      expect(nwc).toMatchObject({ text: "Nostr Wallet Connect · In use", disabled: false });
    });

    it.each([
      ["connecting", "Connecting…"],
      ["error", "Not connected"],
    ] as const)("says %s sources are %s", (state, text) => {
      picker("lightning", sourceView({ offered: offered("lightning", "mainnet"), providerId: "lnd", label: "LND node", status: state }));
      expect(status()).toHaveTextContent(new RegExp(`^${text}$`));
    });

    it("shows the engine's error instead of the status", () => {
      picker("lightning", sourceView({ offered: offered("lightning", "mainnet"), providerId: "lnd", label: "LND node", status: "error", alias: "mynode", error: "Could not connect to LND node: refused" }));
      expect(status()).toHaveTextContent(/^Could not connect to LND node: refused$/);
    });

    it("names a source by its id when its provider is gone", () => {
      picker("lightning", sourceView({ offered: offered("lightning", "mainnet"), providerId: "old-plugin", status: "error", error: "old-plugin is not available in this version of Ghostly" }));
      expect(screen.getByTestId("lightning-source-current")).toHaveTextContent("old-plugin");
    });

    it("goes back to the Cashu mints from another Lightning source", async () => {
      const { user, onClear } = picker("lightning", sourceView({ offered: offered("lightning", "mainnet"), providerId: "nwc", label: "Nostr Wallet Connect", status: "ready" }));
      await user.click(screen.getByRole("button", { name: "Back to Cashu mints" }));
      expect(onClear).toHaveBeenCalledOnce();
    });

    it("removes an on-chain source, and shows why when that fails", async () => {
      const { user, onClear } = picker("onchain", sourceView({ mode: "testnet", offered: offered("onchain", "testnet"), providerId: "bdk", label: "BDK wallet", status: "ready", network: "signet" }),
        { onClear: vi.fn(async () => { throw new Error("A payment is still in flight through BDK wallet"); }) });
      await user.click(screen.getByRole("button", { name: "Remove" }));
      expect(onClear).toHaveBeenCalledOnce();
      expect(await screen.findByTestId("onchain-source-error")).toHaveTextContent("A payment is still in flight through BDK wallet");
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  describe("what is offered", () => {
    it("says when no on-chain provider runs here", () => {
      // Bitcoin Core is desktop-only and the BDK wallet test networks only: nothing on the web in Mainnet.
      picker("onchain", sourceView({ offered: offered("onchain", "mainnet") }));
      expect(screen.getByTestId("onchain-source-none-offered")).toHaveTextContent(/^No on-chain Bitcoin provider is available here yet\.$/);
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    });

    it("says it is about Testnet in Testnet", () => {
      picker("lightning", sourceView({ mode: "testnet", offered: [] }));
      expect(screen.getByTestId("lightning-source-none-offered")).toHaveTextContent(/^No Lightning provider is available here yet in Testnet\.$/);
    });

    it("offers Breez in Testnet only, as experimental", async () => {
      const { user } = picker("lightning", sourceView({ mode: "testnet", offered: offered("lightning", "testnet") }));
      expect((await options(user)).map((o) => o.text)).toContain("Breez (Spark) · Experimental");
    });

    it.each([
      ["mainnet", "This is the Mainnet wallet's source; a Testnet wallet has its own."],
      ["testnet", "This is the Testnet wallet's source; a Mainnet wallet has its own."],
    ] as const)("says the source belongs to the %s wallet, and the other network's wallet has its own", (mode, text) => {
      picker("lightning", sourceView({ mode, offered: offered("lightning", mode) }));
      expect(screen.getByText(text)).toBeInTheDocument();
      expect(document.body.textContent, "no Mainnet or Testnet mode to switch").not.toMatch(/source is kept/);
    });
  });

  describe("setting a source", () => {
    it("shows the provider's description and form once chosen", async () => {
      const { user } = picker("lightning", sourceView({ offered: offered("lightning", "mainnet") }));
      expect(screen.queryByTestId("lightning-source-config")).not.toBeInTheDocument();
      await choose(user, screen.getByRole("combobox", { name: "Lightning source" }), "nwc");
      const config = screen.getByTestId("lightning-source-config");
      expect(config).toHaveTextContent(descriptor("nwc").description);
      expect(within(config).getByTestId("provider-form-nwc")).toBeInTheDocument();
    });

    it("hands the typed values to onSet with the provider id, then says the source changed", async () => {
      const { user, onSet } = picker("lightning", sourceView({ offered: offered("lightning", "mainnet") }));
      await choose(user, screen.getByRole("combobox", { name: "Lightning source" }), "nwc");
      await user.type(screen.getByLabelText("Connection URI"), "nostr+walletconnect://wallet");
      await user.click(screen.getByRole("button", { name: "Use Nostr Wallet Connect" }));
      expect(onSet).toHaveBeenCalledWith("nwc", { uri: "nostr+walletconnect://wallet" });
      expect(await screen.findByTestId("lightning-source-saved")).toHaveTextContent("Nostr Wallet Connect is now your Lightning source.");
      // The form closes, the choice is reset.
      expect(screen.queryByTestId("lightning-source-config")).not.toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: "Lightning source" })).toHaveAttribute("data-value", "");
    });

    it("says Bitcoin for an on-chain source", async () => {
      const { user, onSet } = picker("onchain", sourceView({ mode: "testnet", offered: [descriptor("bitcoind")] }));
      await choose(user, screen.getByRole("combobox", { name: "Bitcoin source" }), "bitcoind");
      await user.type(screen.getByLabelText("RPC password or cookie"), "secret");
      await user.click(screen.getByRole("button", { name: "Use Bitcoin Core" }));
      expect(onSet).toHaveBeenCalledWith("bitcoind", { url: "http://127.0.0.1:38332", wallet: "", user: "", password: "secret" });
      expect(await screen.findByTestId("onchain-source-saved")).toHaveTextContent("Bitcoin Core is now your Bitcoin source.");
    });

    it("keeps the form open and shows the engine's refusal", async () => {
      const onSet = vi.fn(async () => { throw new Error("Could not connect to Nostr Wallet Connect: no answer"); });
      const { user } = picker("lightning", sourceView({ offered: offered("lightning", "mainnet") }), { onSet });
      await choose(user, screen.getByRole("combobox", { name: "Lightning source" }), "nwc");
      await user.type(screen.getByLabelText("Connection URI"), "nostr+walletconnect://wallet");
      await user.click(screen.getByRole("button", { name: "Use Nostr Wallet Connect" }));
      expect(await screen.findByTestId("lightning-source-error")).toHaveTextContent("Could not connect to Nostr Wallet Connect: no answer");
      expect(screen.queryByTestId("lightning-source-saved")).not.toBeInTheDocument();
      expect(screen.getByTestId("provider-form-nwc")).toBeInTheDocument();
      // What was typed is still there, to fix and try again.
      expect(screen.getByLabelText("Connection URI")).toHaveValue("nostr+walletconnect://wallet");
    });

    it("clears the success notice when another provider is chosen", async () => {
      const { user } = picker("lightning", sourceView({ offered: offered("lightning", "mainnet") }));
      await choose(user, screen.getByRole("combobox", { name: "Lightning source" }), "cashu-mint");
      await user.click(screen.getByRole("button", { name: "Use Cashu mints" }));
      expect(await screen.findByTestId("lightning-source-saved")).toBeInTheDocument();
      await choose(user, screen.getByRole("combobox", { name: "Lightning source" }), "lnd");
      expect(screen.queryByTestId("lightning-source-saved")).not.toBeInTheDocument();
    });

    it.each([
      ["webln", "lightning", "mainnet", "webln-missing"],
      ["breez", "lightning", "testnet", "breez-new-phrase"],
      ["bdk", "onchain", "testnet", "bdk-new-phrase"],
    ] as const)("uses %s's own form", async (id, kind, mode, marker) => {
      const { user } = picker(kind, sourceView({ mode, offered: offered(kind, mode) }));
      await choose(user, screen.getByTestId(`${kind}-source-select`), id);
      expect(screen.getByTestId(marker)).toBeInTheDocument();
    });
  });
});
