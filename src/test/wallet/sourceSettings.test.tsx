import "fake-indexeddb/auto";
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ONCHAIN_PROVIDERS } from "@ghostly/browser/engine/paymentAdapters/providers/registry";
import { ProviderSources } from "@ghostly/browser/engine/paymentAdapters/providers/sources";
import type { ProviderDescriptor, ProviderNetwork, ProviderSettings } from "@ghostly/browser/engine/paymentAdapters/providers/types";
import { SourcePicker } from "../../components/wallet/providers/SourcePicker";
import { renderApp } from "../render";
import { choose } from "../select";

// covers: wallet.lightning.lnd.connect, wallet.onchain.bitcoind, wallet.lightning.sources

/**
 * What the forms submit is one flat map of values; the engine (ProviderSources.set) splits it by the
 * provider's field kinds into `config`, shown back, and `secrets`, sealed and never shown. These tests
 * drive the real form into the real split, with the real descriptors: only `create` (which would reach a
 * node) is replaced by one that records what it was handed.
 */
interface Recorded { info(): Promise<{ network: ProviderNetwork }>; close(): Promise<void> }

let created: ProviderSettings[];
let sources: ProviderSources<Recorded>;

const recording = (id: string): ProviderDescriptor<Recorded> => ({
  ...(ONCHAIN_PROVIDERS.find((d) => d.id === id) as unknown as ProviderDescriptor<Recorded>),
  create: async (settings) => { created.push(settings); return { info: async () => ({ network: "signet" }), close: async () => {} }; },
});

async function setUp(ids: string[]) {
  created = [];
  // Desktop: Bitcoin Core only runs there.
  sources = new ProviderSources<Recorded>({ kind: "onchain", network: "testnet", descriptors: () => ids.map(recording), host: () => ({ platform: "desktop" }), changed: () => {} });
  await sources.start();
  return renderApp(<SourcePicker kind="onchain" view={sources.view} onSet={(id, values) => sources.set(id, values)} />);
}

describe("a source's settings, from the form to the engine", () => {
  beforeEach(() => indexedDB.deleteDatabase("ghostly"));

  it("keeps text and url fields as config and puts the secret field in secrets", async () => {
    const { user } = await setUp(["bitcoind"]);
    await choose(user, screen.getByRole("combobox", { name: "Bitcoin source" }), "bitcoind");
    await user.type(screen.getByLabelText("Wallet name"), "ghostly");
    await user.type(screen.getByLabelText("RPC user"), "ghost");
    await user.type(screen.getByLabelText("RPC password or cookie"), " hunter2 ");
    await user.click(screen.getByRole("button", { name: "Use Bitcoin Core" }));
    expect(await screen.findByTestId("onchain-source-saved")).toHaveTextContent("Bitcoin Core is now your Bitcoin source.");
    // Trimmed; the Testnet default address came with the form.
    expect(created).toEqual([{ config: { url: "http://127.0.0.1:38332", wallet: "ghostly", user: "ghost" }, secrets: { password: "hunter2" } }]);
    // What the UI is told afterwards: the config, and only the names of the secrets.
    expect(sources.view.config).toEqual({ url: "http://127.0.0.1:38332", wallet: "ghostly", user: "ghost" });
    expect(sources.view.secrets).toEqual(["password"]);
    expect(JSON.stringify(sources.view)).not.toContain("hunter2");
  });

  it("leaves empty optional fields out", async () => {
    const { user } = await setUp(["bitcoind"]);
    await choose(user, screen.getByRole("combobox", { name: "Bitcoin source" }), "bitcoind");
    // A cookie file's contents, without a user.
    await user.type(screen.getByLabelText("RPC password or cookie"), "__cookie__:abc123");
    await user.click(screen.getByRole("button", { name: "Use Bitcoin Core" }));
    await screen.findByTestId("onchain-source-saved");
    expect(created).toEqual([{ config: { url: "http://127.0.0.1:38332" }, secrets: { password: "__cookie__:abc123" } }]);
  });

  it("says which required field is empty, before anything is contacted", async () => {
    const { user } = await setUp(["bitcoind"]);
    await choose(user, screen.getByRole("combobox", { name: "Bitcoin source" }), "bitcoind");
    await user.click(screen.getByRole("button", { name: "Use Bitcoin Core" }));
    expect(await screen.findByTestId("onchain-source-error")).toHaveTextContent("Enter rpc password or cookie");
    expect(created).toEqual([]);
  });

  it("shows the provider's own check of the form", async () => {
    const { user } = await setUp(["bitcoind"]);
    await choose(user, screen.getByRole("combobox", { name: "Bitcoin source" }), "bitcoind");
    await user.clear(screen.getByLabelText("RPC address"));
    await user.type(screen.getByLabelText("RPC address"), "http://me:pw@127.0.0.1:38332");
    await user.type(screen.getByLabelText("RPC password or cookie"), "pw");
    await user.click(screen.getByRole("button", { name: "Use Bitcoin Core" }));
    expect(await screen.findByTestId("onchain-source-error")).toHaveTextContent("Put the RPC user and password in their own fields, not in the address");
    expect(created).toEqual([]);
  });

  it("keeps select fields as config and a restored phrase as a secret (BDK)", async () => {
    const phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const { user } = await setUp(["bdk"]);
    await choose(user, screen.getByRole("combobox", { name: "Bitcoin source" }), "bdk");
    await user.click(screen.getByRole("radio", { name: "Restore" }));
    await choose(user, screen.getByLabelText("Addresses"), "bip86");
    await user.type(screen.getByLabelText("Recovery phrase"), phrase);
    await user.click(screen.getByRole("button", { name: "Use BDK wallet" }));
    expect(await screen.findByTestId("onchain-source-saved")).toHaveTextContent("BDK wallet is now your Bitcoin source.");
    expect(created).toEqual([{ config: { network: "signet", script: "bip86" }, secrets: { mnemonic: phrase } }]);
  });

  it("makes a new BDK wallet with the phrase it showed, sealed as a secret", async () => {
    const { user } = await setUp(["bdk"]);
    await choose(user, screen.getByRole("combobox", { name: "Bitcoin source" }), "bdk");
    const shown = screen.getByTestId("bdk-new-phrase").querySelectorAll("li");
    const phrase = [...shown].map((li) => li.textContent!.replace(/^\d+/, "")).join(" ");
    await user.click(screen.getByTestId("bdk-written"));
    await user.click(screen.getByRole("button", { name: "Use BDK wallet" }));
    await screen.findByTestId("onchain-source-saved");
    expect(created).toEqual([{ config: { network: "signet", script: "bip84" }, secrets: { mnemonic: phrase } }]);
  });

  it("refuses Regtest without an Esplora server, with the provider's message", async () => {
    const { user } = await setUp(["bdk"]);
    await choose(user, screen.getByRole("combobox", { name: "Bitcoin source" }), "bdk");
    await choose(user, screen.getByLabelText("Network"), "regtest");
    await user.click(screen.getByTestId("bdk-written"));
    await user.click(screen.getByRole("button", { name: "Use BDK wallet" }));
    expect(await screen.findByTestId("onchain-source-error")).toHaveTextContent("Regtest needs the address of your own Esplora server");
    expect(created).toEqual([]);
  });
});
