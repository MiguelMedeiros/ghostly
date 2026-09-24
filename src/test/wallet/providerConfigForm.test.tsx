import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProviderDescriptorView } from "@ghostly/browser/engine/paymentAdapters/providers/types";
import { ProviderConfigForm } from "../../components/wallet/providers/SourcePicker";
import { renderApp } from "../render";
import { descriptor } from "./descriptors";
import { choose, optionsOf } from "../select";

// covers: wallet.lightning.sources, wallet.onchain.sources

/** The generic form a provider gets from its declared fields (every provider without its own form). */
describe("ProviderConfigForm", () => {
  const form = (d: ProviderDescriptorView, mode: "mainnet" | "testnet" = "mainnet", busy = false) => {
    const onSubmit = vi.fn();
    return { onSubmit, ...renderApp(<ProviderConfigForm descriptor={d} mode={mode} busy={busy} onSubmit={onSubmit} />) };
  };

  it("submits what was typed in each field, by field name", async () => {
    // LND rather than Core Lightning: happy-dom's type=url check refuses wss:// addresses (browsers accept them).
    const { user, onSubmit } = form(descriptor("lnd"));
    await user.type(screen.getByLabelText("REST address"), "https://mynode.local:8080");
    await user.type(screen.getByLabelText("Macaroon (hex)"), "0201abcd");
    await user.click(screen.getByRole("button", { name: "Use LND node" }));
    // The optional certificate left empty is still sent, empty.
    expect(onSubmit).toHaveBeenCalledWith({ url: "https://mynode.local:8080", macaroon: "0201abcd", certificate: "" });
  });

  it("makes secret fields password inputs a password manager does not fill, and says secrets are sealed", () => {
    form(descriptor("core-lightning"));
    const rune = screen.getByLabelText("Rune");
    expect(rune).toHaveAttribute("type", "password");
    expect(rune).toHaveAttribute("autocomplete", "new-password");
    // The other kinds stay visible, with the browser's own autocomplete off.
    expect(screen.getByLabelText("Node id")).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("WebSocket address")).toHaveAttribute("type", "url");
    expect(screen.getByLabelText("Node id")).toHaveAttribute("autocomplete", "off");
    expect(screen.getByText("Secrets are sealed on this device and never shown again.")).toBeInTheDocument();
  });

  it("shows each field's help and placeholder", () => {
    const d = descriptor("core-lightning");
    form(d);
    for (const field of d.fields) {
      if (field.help) expect(screen.getByText(field.help)).toBeInTheDocument();
      if (field.placeholder) expect(screen.getByLabelText(field.label)).toHaveAttribute("placeholder", field.placeholder);
    }
  });

  it("marks optional fields", () => {
    form(descriptor("lnd"));
    // "TLS certificate" is optional, the macaroon is not.
    expect(screen.getByText("TLS certificate").textContent).toBe("TLS certificate (optional)");
    expect(screen.getByText("Macaroon (hex)").textContent).toBe("Macaroon (hex)");
  });

  it("pre-fills a field's default for the mode", async () => {
    // Bitcoin Core's RPC address differs per mode; its descriptor is desktop-only, the form does not care.
    const d = descriptor("bitcoind");
    const mainnet = form(d, "mainnet");
    expect(screen.getByLabelText("RPC address")).toHaveValue("http://127.0.0.1:8332");
    await mainnet.user.click(screen.getByRole("button", { name: "Use Bitcoin Core" }));
    // Fields left empty are still submitted, empty: the engine decides what is required.
    expect(mainnet.onSubmit).toHaveBeenCalledWith({ url: "http://127.0.0.1:8332", wallet: "", user: "", password: "" });
    mainnet.unmount();

    form(d, "testnet");
    expect(screen.getByLabelText("RPC address")).toHaveValue("http://127.0.0.1:38332");
  });

  it("starts a select on its default for the mode, else its first option", async () => {
    const { user, onSubmit } = form(descriptor("bdk"), "testnet");
    expect(screen.getByLabelText("Network")).toHaveAttribute("data-value", "signet");
    // No default for the address type: the first option.
    expect(screen.getByLabelText("Addresses")).toHaveAttribute("data-value", "bip84");
    expect((await optionsOf(user, screen.getByLabelText("Network"))).map((o) => o.label)).toEqual(["Signet", "Mutinynet", "Regtest"]);
    expect((await optionsOf(user, screen.getByLabelText("Addresses"))).map((o) => o.label)).toEqual(["Native SegWit (BIP84, bc1q…)", "Taproot (BIP86, bc1p…)"]);
    await choose(user, screen.getByLabelText("Addresses"), "bip86");
    await choose(user, screen.getByLabelText("Network"), "regtest");
    await user.click(screen.getByRole("button", { name: "Use BDK wallet" }));
    expect(onSubmit).toHaveBeenCalledWith({ network: "regtest", esplora: "", script: "bip86", mnemonic: "" });
  });

  it("renders a textarea field as a multi-line input", async () => {
    // No built-in declares one yet; a plugin can.
    const d: ProviderDescriptorView = { ...descriptor("lnd"), id: "plugin-node", label: "Plugin node", fields: [{ name: "notes", label: "Notes", kind: "textarea", placeholder: "anything" }] };
    const { user, onSubmit } = form(d);
    const notes = screen.getByLabelText("Notes");
    expect(notes.tagName).toBe("TEXTAREA");
    await user.type(notes, "line one{enter}line two");
    await user.click(screen.getByRole("button", { name: "Use Plugin node" }));
    expect(onSubmit).toHaveBeenCalledWith({ notes: "line one\nline two" });
    // Nothing secret declared: no sealing notice.
    expect(screen.queryByText(/Secrets are sealed/)).not.toBeInTheDocument();
  });

  it("is just the button for a provider with nothing to configure", async () => {
    const { user, onSubmit } = form(descriptor("cashu-mint"));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/Secrets are sealed/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use Cashu mints" }));
    expect(onSubmit).toHaveBeenCalledWith({});
  });

  it("disables the button while connecting", () => {
    form(descriptor("nwc"), "mainnet", true);
    expect(screen.getByTestId("provider-save")).toBeDisabled();
    expect(screen.getByTestId("provider-save")).toHaveTextContent("Connecting…");
  });

  it("submits with Enter from a field", async () => {
    const { user, onSubmit } = form(descriptor("nwc"));
    await user.type(screen.getByLabelText("Connection URI"), "nostr+walletconnect://abc{enter}");
    expect(onSubmit).toHaveBeenCalledWith({ uri: "nostr+walletconnect://abc" });
  });
});
