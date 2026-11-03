import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProviderDescriptorView } from "@ghostly/browser/engine/paymentAdapters/providers/types";
import { SourcePicker } from "../../components/wallet/providers/SourcePicker";
import { NewWalletDialog } from "../../components/wallet/NewWalletDialog";
import { providerText } from "../../components/wallet/providers/providerText";
import { englishT } from "../../locales/translate";
import { renderApp } from "../render";
import { descriptor, offered, sourceView } from "./descriptors";
import { choose } from "../select";
import { flatten, LOCALES } from "../i18n/locales";

// covers: wallet.lightning.sources, wallet.onchain.sources, wallet.instances.create

const BUILT_IN = ["cashu-mint", "fedimint", "breez", "nwc", "core-lightning", "webln", "lnd", "bitcoind", "bdk"];

/** A provider registered by a plugin: no keys of its own, so its English stays. */
const plugin: ProviderDescriptorView = {
  id: "acme-node", label: "Acme node", kind: "lightning", description: "An Acme node over its API. Your node holds the sats.",
  networks: ["regtest"], platforms: ["web"],
  fields: [{ name: "url", label: "Acme address", kind: "url", placeholder: "https://acme.local", help: "Where the Acme node listens." }],
} as ProviderDescriptorView;

/** Wallet → a source's form, and New's provider step: a built-in provider's lines in the app's language. */
describe("a provider's lines in the app's language", () => {
  it("LND's form in Portuguese: its description, field names, help and placeholder; technical names and the command as they are", async () => {
    const { user } = renderApp(<SourcePicker kind="lightning" view={sourceView({ mode: "testnet", offered: offered("lightning", "testnet") })} onSet={vi.fn(async () => {})} />, { language: "pt" });
    await choose(user, screen.getByTestId("lightning-source-select"), "lnd");
    const config = screen.getByTestId("lightning-source-config");
    expect(config).toHaveTextContent("Seu próprio nó LND, pela API REST dele. Seu nó guarda os sats.");
    expect(within(config).getByRole("textbox", { name: "Endereço REST" })).toBeInTheDocument();
    expect(config).toHaveTextContent("Certificado TLS");
    expect(config).toHaveTextContent("Nunca o macaroon de administrador: crie um com lncli bakemacaroon info:read invoices:read invoices:write offchain:read offchain:write");
    expect(within(config).getByLabelText("Macaroon (hex)")).toHaveAttribute("placeholder", "0201036c6e64…");
    expect(config).not.toHaveTextContent(/REST address|Your own LND node|Never the admin macaroon/);
  });

  it("the BDK wallet's options and suggestions in Japanese, network names and servers as they are", async () => {
    const { user } = renderApp(<SourcePicker kind="onchain" view={sourceView({ mode: "testnet", offered: offered("onchain", "testnet") })} onSet={vi.fn(async () => {})} />, { language: "ja" });
    await choose(user, screen.getByTestId("onchain-source-select"), "bdk");
    const config = screen.getByTestId("onchain-source-config");
    expect(config).not.toHaveTextContent(/Esplora server|Addresses|Native SegWit|Test networks only/);
    expect(within(config).getByRole("combobox", { name: "アドレス" })).toHaveTextContent("ネイティブ SegWit (BIP84, bc1q…)");
    expect(screen.getByTestId("field-suggestions-esplora")).toHaveTextContent("blockstream.info (Signet)");
    await choose(user, within(config).getByRole("combobox", { name: "ネットワーク" }), "regtest");
    expect(screen.getByTestId("field-suggestions-esplora")).toHaveTextContent(/^このコンピューター: e2e の regtest スタック（npm run e2e:infra:up）$/);
  });

  it("Change server on a saved BDK wallet says the Esplora field in Italian", async () => {
    const view = sourceView({ mode: "testnet", offered: offered("onchain", "testnet"), providerId: "bdk", label: "BDK wallet", status: "ready", config: { network: "signet", esplora: "" } });
    const { user } = renderApp(<SourcePicker kind="onchain" view={view} onSet={vi.fn(async () => {})} onReconfigure={vi.fn(async () => {})} />, { language: "it" });
    await user.click(screen.getByTestId("onchain-source-change-server"));
    const form = screen.getByTestId("onchain-source-server-form");
    expect(within(form).getByRole("textbox", { name: "Server Esplora" })).toHaveAttribute("placeholder", "Vuoto: un server pubblico della rete");
    expect(form).not.toHaveTextContent(/Esplora server|Blank:/);
  });

  it("Bitcoin Core's form in French", async () => {
    const { user } = renderApp(<SourcePicker kind="onchain" view={sourceView({ mode: "testnet", offered: [descriptor("bitcoind")] })} onSet={vi.fn(async () => {})} />, { language: "fr" });
    await choose(user, screen.getByTestId("onchain-source-select"), "bitcoind");
    const config = screen.getByTestId("onchain-source-config");
    expect(within(config).getByRole("textbox", { name: "Adresse RPC" })).toBeInTheDocument();
    expect(config).toHaveTextContent("Nom du portefeuille");
    expect(config).not.toHaveTextContent(/RPC address|Wallet name|RPC password or cookie/);
  });

  it("New's provider step says Core Lightning's description and fields in Portuguese", async () => {
    const offers = [{ type: "lightning", network: "testnet", available: true, needs: "provider", providers: offered("lightning", "testnet").filter((d) => d.id !== "cashu-mint") }] as never;
    const { user } = renderApp(<NewWalletDialog wallet={{} as never} offers={offers} onClose={() => {}} onCreated={() => {}} />, { language: "pt" });
    await user.click(screen.getByTestId("new-wallet-type-lightning"));
    const step = await screen.findByTestId("new-wallet-provider");
    await choose(user, within(step).getByRole("combobox"), "core-lightning");
    expect(step).toHaveTextContent("Seu próprio nó Core Lightning, pelo Commando com uma rune.");
    expect(within(step).getByRole("textbox", { name: "Id do nó" })).toBeInTheDocument();
    expect(within(step).getByRole("textbox", { name: "Endereço WebSocket" })).toBeInTheDocument();
    expect(step).toHaveTextContent(/lightning-cli createrune restrictions='\[\["method=getinfo",/);
    expect(step).not.toHaveTextContent(/Your own Core Lightning node|Node id|WebSocket address/);
  });

  it("a plugin provider, without keys of its own, keeps its English lines", async () => {
    const { user } = renderApp(<SourcePicker kind="lightning" view={sourceView({ mode: "testnet", offered: [plugin] })} onSet={vi.fn(async () => {})} />, { language: "pt" });
    await choose(user, screen.getByTestId("lightning-source-select"), "acme-node");
    const config = screen.getByTestId("lightning-source-config");
    expect(config).toHaveTextContent("An Acme node over its API. Your node holds the sats.");
    expect(within(config).getByRole("textbox", { name: "Acme address" })).toHaveAttribute("placeholder", "https://acme.local");
    expect(config).toHaveTextContent("Where the Acme node listens.");
  });
});

describe("the built-in providers' English keys", () => {
  it("say what the descriptors say, word for word", () => {
    for (const id of BUILT_IN) {
      const own = descriptor(id);
      expect(providerText(englishT, own), id).toEqual(own);
    }
  });

  it("are all a line of a built-in provider: none is left over from a renamed field", () => {
    const keys = [...flatten(LOCALES.en).keys()].filter((key) => key.startsWith("wallet.source.providers."));
    expect(keys.length).toBeGreaterThan(30);
    const lines = new Set(BUILT_IN.flatMap((id) => {
      const d = descriptor(id), base = `wallet.source.providers.${id}`;
      return [`${base}.description`, ...d.fields.flatMap((f) => [
        `${base}.fields.${f.name}.label`, `${base}.fields.${f.name}.help`, `${base}.fields.${f.name}.placeholder`,
        ...(f.options ?? []).map((o) => `${base}.fields.${f.name}.options.${o.value.replace(/[^A-Za-z0-9]+/g, "_")}`),
        ...(f.suggestions ?? []).map((s) => `${base}.fields.${f.name}.suggestions.${s.value.replace(/[^A-Za-z0-9]+/g, "_")}`),
      ])];
    }));
    expect(keys.filter((key) => !lines.has(key))).toEqual([]);
  });
});
