import type { ComponentType } from "react";
import { act, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isRecoveryPhrase } from "@ghostly/browser/engine/paymentAdapters/providers/recoveryPhrase";
import { BdkForm } from "../../components/wallet/providers/BdkForm";
import { BreezForm } from "../../components/wallet/providers/BreezForm";
import { WeblnForm } from "../../components/wallet/providers/WeblnForm";
import type { ProviderFormProps } from "../../components/wallet/providers/forms";
import { renderApp } from "../render";
import { descriptor } from "./descriptors";
import { choose } from "../select";

// covers: wallet.onchain.bdk.create, wallet.lightning.breez.connect, wallet.lightning.webln.connect

/** A valid BIP39 phrase (the standard test vector), to restore from. */
const RESTORE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function render(Form: ComponentType<ProviderFormProps>, id: string, mode: "mainnet" | "testnet", busy = false) {
  const onSubmit = vi.fn();
  return { onSubmit, ...renderApp(<Form descriptor={descriptor(id)} mode={mode} busy={busy} onSubmit={onSubmit} />) };
}

/** The words a form shows for a new wallet, without their numbers. */
const shownPhrase = (testId: string) => within(screen.getByTestId(testId)).getAllByRole("listitem").map((li) => li.textContent!.replace(/^\d+/, "")).join(" ");

describe("BdkForm", () => {
  it("makes a new wallet's 12 words and shows them, with no phrase to type", () => {
    render(BdkForm, "bdk", "testnet");
    const phrase = shownPhrase("bdk-new-phrase");
    expect(phrase.split(" ")).toHaveLength(12);
    expect(isRecoveryPhrase(phrase)).toBe(true);
    expect(screen.queryByLabelText("Recovery phrase")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "New wallet" })).toHaveAttribute("aria-checked", "true");
  });

  it("refuses to make the wallet until the words are written down", async () => {
    const { user, onSubmit } = render(BdkForm, "bdk", "testnet");
    await user.click(screen.getByRole("button", { name: "Use BDK wallet" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Write the 12 words down first: they are the only way back into this wallet.");
    // Ticking the box takes the message away.
    await user.click(screen.getByTestId("bdk-written"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("submits the declared fields with the phrase it showed", async () => {
    const { user, onSubmit } = render(BdkForm, "bdk", "testnet");
    const phrase = shownPhrase("bdk-new-phrase");
    await user.click(screen.getByTestId("bdk-written"));
    await choose(user, screen.getByLabelText("Addresses"), "bip86");
    await user.click(screen.getByRole("button", { name: "Use BDK wallet" }));
    expect(onSubmit).toHaveBeenCalledWith({ network: "signet", esplora: "", script: "bip86", mnemonic: phrase });
  });

  it("restores from typed words, a secret field, without the written-down check", async () => {
    const { user, onSubmit } = render(BdkForm, "bdk", "testnet");
    await user.click(screen.getByRole("radio", { name: "Restore" }));
    expect(screen.queryByTestId("bdk-new-phrase")).not.toBeInTheDocument();
    const words = screen.getByLabelText("Recovery phrase");
    expect(words).toHaveAttribute("type", "password");
    expect(screen.getByText("Secrets are sealed on this device and never shown again.")).toBeInTheDocument();
    await user.type(words, RESTORE);
    await user.click(screen.getByRole("button", { name: "Use BDK wallet" }));
    expect(onSubmit).toHaveBeenCalledWith({ network: "signet", esplora: "", script: "bip84", mnemonic: RESTORE });
  });

  it("starts the fields over when switching between new and restore", async () => {
    const { user } = render(BdkForm, "bdk", "testnet");
    await choose(user, screen.getByLabelText("Network"), "regtest");
    await user.click(screen.getByRole("radio", { name: "Restore" }));
    expect(screen.getByLabelText("Network")).toHaveAttribute("data-value", "signet");
  });

  it("clears the written-down message when switching to restore", async () => {
    const { user } = render(BdkForm, "bdk", "testnet");
    await user.click(screen.getByRole("button", { name: "Use BDK wallet" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Restore" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("BreezForm", () => {
  const save = () => screen.getByTestId("provider-save");

  it("makes a new wallet's phrase and waits for it to be written down (Testnet: no key needed)", async () => {
    const { user, onSubmit } = render(BreezForm, "breez", "testnet");
    const phrase = shownPhrase("breez-new-phrase");
    expect(isRecoveryPhrase(phrase)).toBe(true);
    expect(save()).toBeDisabled();
    expect(screen.getByText(/Breez API key/)).toHaveTextContent("Breez API key (optional in Testnet)");
    expect(screen.getByText("Regtest works without one.")).toBeInTheDocument();
    await user.click(screen.getByTestId("breez-phrase-written"));
    expect(save()).toBeEnabled();
    await user.click(save());
    expect(onSubmit).toHaveBeenCalledWith({ mnemonic: phrase, apiKey: "" });
  });

  it("needs an API key on Mainnet", async () => {
    const { user, onSubmit } = render(BreezForm, "breez", "mainnet");
    expect(screen.getByText("Mainnet needs one: Breez gives them for free.")).toBeInTheDocument();
    expect(screen.queryByText(/optional in Testnet/)).not.toBeInTheDocument();
    await user.click(screen.getByTestId("breez-phrase-written"));
    expect(save()).toBeDisabled();
    await user.type(screen.getByLabelText("Breez API key"), "   ");
    expect(save()).toBeDisabled();
    await user.type(screen.getByLabelText("Breez API key"), "key-1");
    expect(save()).toBeEnabled();
    await user.click(save());
    expect(onSubmit).toHaveBeenCalledWith({ mnemonic: shownPhrase("breez-new-phrase"), apiKey: "   key-1" });
  });

  it("keeps the API key in a password input a password manager does not fill", () => {
    render(BreezForm, "breez", "testnet");
    expect(screen.getByLabelText("Breez API key")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Breez API key")).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByText("The recovery phrase and the API key are sealed on this device and never shown again.")).toBeInTheDocument();
  });

  it("restores from a phrase, and says when it is not a valid one", async () => {
    const { user, onSubmit } = render(BreezForm, "breez", "testnet");
    await user.click(screen.getByRole("radio", { name: "Restore" }));
    expect(screen.queryByTestId("breez-new-phrase")).not.toBeInTheDocument();
    expect(save()).toBeDisabled();
    const words = screen.getByLabelText("Recovery phrase");
    await user.type(words, "abandon abandon nonsense");
    expect(screen.getByTestId("breez-phrase-invalid")).toHaveTextContent("That is not a valid recovery phrase.");
    expect(save()).toBeDisabled();
    await user.clear(words);
    // Typed however: capitals and extra spaces are still the phrase.
    await user.type(words, `  ${RESTORE.toUpperCase()} `);
    expect(screen.queryByTestId("breez-phrase-invalid")).not.toBeInTheDocument();
    await user.click(save());
    // Sent as typed; the engine normalizes it.
    expect(onSubmit).toHaveBeenCalledWith({ mnemonic: `  ${RESTORE.toUpperCase()} `, apiKey: "" });
  });

  it("does not submit the new wallet's phrase from Restore", async () => {
    const { user } = render(BreezForm, "breez", "testnet");
    await user.click(screen.getByTestId("breez-phrase-written"));
    await user.click(screen.getByRole("radio", { name: "Restore" }));
    // Written-down was for the new phrase: Restore needs its own words.
    expect(save()).toBeDisabled();
  });

  it("says it is connecting while busy", () => {
    render(BreezForm, "breez", "testnet", true);
    expect(save()).toHaveTextContent("Connecting…");
    expect(save()).toBeDisabled();
  });
});

describe("WeblnForm", () => {
  const win = window as { webln?: unknown };
  afterEach(() => { delete win.webln; });

  it("says no browser wallet is here, and still lets the person try", async () => {
    const { user, onSubmit } = render(WeblnForm, "webln", "mainnet");
    expect(screen.getByTestId("webln-missing")).toHaveTextContent("No WebLN wallet found in this browser.");
    await user.click(screen.getByRole("button", { name: "Connect browser wallet" }));
    // Nothing to type, nothing kept.
    expect(onSubmit).toHaveBeenCalledWith({});
  });

  it("finds a wallet already in the page", () => {
    win.webln = { enable: async () => {} };
    render(WeblnForm, "webln", "mainnet");
    expect(screen.getByTestId("webln-found")).toBeInTheDocument();
    expect(screen.queryByTestId("webln-missing")).not.toBeInTheDocument();
  });

  it("notices a wallet that arrives after the page loaded", () => {
    render(WeblnForm, "webln", "mainnet");
    expect(screen.getByTestId("webln-missing")).toBeInTheDocument();
    win.webln = { enable: async () => {} };
    act(() => { window.dispatchEvent(new Event("webln:ready")); });
    expect(screen.getByTestId("webln-found")).toBeInTheDocument();
  });

  it("ignores a webln object that cannot be enabled", () => {
    win.webln = {};
    render(WeblnForm, "webln", "mainnet");
    expect(screen.getByTestId("webln-missing")).toBeInTheDocument();
  });

  it("waits for the wallet while busy", () => {
    render(WeblnForm, "webln", "mainnet", true);
    expect(screen.getByTestId("provider-save")).toHaveTextContent("Waiting for the wallet…");
    expect(screen.getByTestId("provider-save")).toBeDisabled();
  });
});
