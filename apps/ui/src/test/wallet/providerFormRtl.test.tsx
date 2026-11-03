import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProviderConfigForm, SourcePicker } from "../../components/wallet/providers/SourcePicker";
import { renderApp } from "../render";
import { choose } from "../select";
import arWallet from "../../locales/ar/wallet.json";
import { descriptor, sourceView } from "./descriptors";

// covers: wallet.lightning.sources, wallet.onchain.sources, app.i18n

/**
 * A payment provider's description and its fields' labels, help and suggestions come from its module, in English. In
 * Arabic they keep their own direction (a <bdi>), or "Macaroon (hex)" showed as "(Macaroon (hex" and every help line's
 * period landed at its start, as Identities → Add did before its lines were isolated.
 */
const arabic = (ui: React.ReactElement) => renderApp(ui, { language: "ar" });
/** The element showing exactly this text is laid out in its own direction: a <bdi>, or dir="auto". */
const ownDirection = (root: HTMLElement, text: string) => {
  const shown = within(root).getByText(text);
  return shown.tagName === "BDI" || shown.getAttribute("dir") === "auto";
};

describe("in Arabic, a payment provider's form", () => {
  it.each(["lnd", "core-lightning", "nwc", "bitcoind"])("%s: each field's label and help keep their own direction", (id) => {
    const d = descriptor(id);
    const { container } = arabic(<ProviderConfigForm descriptor={d} mode="mainnet" busy={false} onSubmit={vi.fn()} />);
    for (const field of d.fields) {
      expect(ownDirection(container, field.label)).toBe(true);
      if (field.help) expect(ownDirection(container, field.help)).toBe(true);
    }
  });

  it("a field's suggestions keep their own direction", () => {
    // BDK's Esplora suggestions are offered for Regtest only.
    const d = { ...descriptor("bdk"), fields: descriptor("bdk").fields.map((f) => (f.name === "network" ? { ...f, defaults: { mainnet: "regtest" } } : f)) };
    const { container } = arabic(<ProviderConfigForm descriptor={d} mode="mainnet" busy={false} onSubmit={vi.fn()} />);
    const suggestions = d.fields.find((f) => f.name === "esplora")!.suggestions!.filter((s) => s.when?.network === "regtest");
    expect(suggestions.length).toBeGreaterThan(0);
    for (const s of suggestions) expect(ownDirection(container, s.label)).toBe(true);
  });

  it("the chosen provider's description keeps its own direction", async () => {
    const lnd = descriptor("lnd");
    const { user } = arabic(<SourcePicker kind="lightning" view={sourceView({ offered: [lnd] })} onSet={vi.fn()} />);
    await choose(user, screen.getByTestId("lightning-source-select"), "lnd");
    // A built-in provider's description is shown in the person's language (`providerText`).
    expect(ownDirection(screen.getByTestId("lightning-source-config"), arWallet.source.providers.lnd.description)).toBe(true);
  });

  it("a plugin provider's description, in its own English, keeps its own direction", async () => {
    const plugin = { ...descriptor("lnd"), id: "acme-node", name: "Acme node", description: "Acme's own node (REST)." };
    const { user } = arabic(<SourcePicker kind="lightning" view={sourceView({ offered: [plugin] })} onSet={vi.fn()} />);
    await choose(user, screen.getByTestId("lightning-source-select"), "acme-node");
    expect(ownDirection(screen.getByTestId("lightning-source-config"), plugin.description)).toBe(true);
  });
});
