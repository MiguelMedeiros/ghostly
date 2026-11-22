import "fake-indexeddb/auto";
import { useState, type ComponentType } from "react";
import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBrowserHost, type BrowserHost } from "@ghostly/browser/host";
import { isRecoveryPhrase } from "@ghostly/browser/engine/paymentAdapters/providers/recoveryPhrase";
import { ONCHAIN_PROVIDERS } from "@ghostly/browser/engine/paymentAdapters/providers/registry";
import { ProviderSources, type SourceView } from "@ghostly/browser/engine/paymentAdapters/providers/sources";
import type { ProviderDescriptor, ProviderDescriptorView, ProviderNetwork, ProviderSettings } from "@ghostly/browser/engine/paymentAdapters/providers/types";
import { ProviderConfigForm, SourcePicker } from "../../components/wallet/providers/SourcePicker";
import { BdkForm } from "../../components/wallet/providers/BdkForm";
import { BreezForm } from "../../components/wallet/providers/BreezForm";
import { WeblnForm } from "../../components/wallet/providers/WeblnForm";
import type { ProviderFormProps } from "../../components/wallet/providers/forms";
import { providerText } from "../../components/wallet/providers/providerText";
import { BackupRows } from "../../components/wallet/BackupRows";
import { NewWalletDialog } from "../../components/wallet/NewWalletDialog";
import { useRun } from "../../components/wallet/run";
import { lockSecuresWindow } from "../../lib/secureWindow";
import { englishT } from "../../locales/translate";
import arWallet from "../../locales/ar/wallet.json";
import { renderApp } from "../render";
import { descriptor, offered, sourceView } from "./descriptors";
import type { UserEvent } from "@testing-library/user-event";
import { choose, optionsOf } from "../select";
import { flatten, LOCALES } from "../i18n/locales";

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
      expect(screen.getByRole("combobox", { name: "Lightning source" })).toHaveTextContent("7 available…");
      // Registry order; custodial and experimental ones say so.
      expect((await options(user)).map((o) => o.text)).toEqual([
        "Cashu mints · Custodial",
        "Fedimint · Custodial · Experimental",
        "Breez (Spark) · Experimental",
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
      expect(status()).toHaveTextContent(/^Couldn't connect to LND node\. Refused$/);
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

    it.each(["mainnet", "testnet"] as const)("offers Breez in %s, as experimental", async (mode) => {
      const { user } = picker("lightning", sourceView({ mode, offered: offered("lightning", mode) }));
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
      expect(await screen.findByTestId("lightning-source-error")).toHaveTextContent("Couldn't connect to Nostr Wallet Connect" + "No answer");
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

// covers: wallet.lightning.lnd.connect, wallet.onchain.bitcoind, wallet.lightning.sources
describe("a source's settings, from the form to the engine", () => {
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

// covers: wallet.lightning.sources, wallet.onchain.sources, wallet.ark.backup, wallet.bark.backup, wallet.usdt.backup
describe("a card's Source and its backup rows from the keyboard", () => {
  /**
   * A card's Source and its backup rows from the keyboard: the button pressed keeps the focus while it works (busy, not
   * disabled: a disabled one drops it to the page in Chromium) and after a refusal; the others wait, disabled. A block
   * that closes when its work is done gives the focus to the button that opened it.
   */
  const later = <T,>() => { let answer!: (value: T) => void, refuse!: (e: Error) => void; const promise = new Promise<T>((resolve, reject) => { answer = resolve; refuse = reject; }); return { promise, answer, refuse }; };
  const busy = (button: HTMLElement) => {
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toBeEnabled();
    expect(button).toHaveFocus();
  };
  const done = (button: HTMLElement) => waitFor(() => expect(button).not.toHaveAttribute("aria-busy"));
  const press = async (user: { keyboard(keys: string): Promise<void> }, button: HTMLElement) => { button.focus(); await user.keyboard("{Enter}"); };

  /** A BDK source on Signet that does not answer: Retry, Change server and Remove. */
  const failing = () => sourceView({ mode: "testnet", offered: offered("onchain", "testnet"), providerId: "bdk", label: "BDK wallet", status: "error", failures: 4, problem: "unreachable",
    config: { network: "signet", script: "bip84", esplora: "https://mempool.space/signet/api" }, error: "Could not connect to BDK wallet: no answer" });

  describe("a card's Source", () => {
    it("Retry and Remove are busy where pressed and keep the keys after a refusal; the other buttons wait", async () => {
      const retried = later<void>(), cleared = later<void>();
      const { user } = renderApp(<SourcePicker kind="onchain" view={failing()} onSet={async () => {}} onRetry={() => retried.promise} onClear={() => cleared.promise} onReconfigure={async () => {}} />);
      const retry = screen.getByTestId("onchain-source-retry"), clear = screen.getByTestId("onchain-source-clear");
      await press(user, retry);
      busy(retry);
      expect(clear).toBeDisabled();
      expect(screen.getByTestId("onchain-source-change-server")).toBeDisabled();
      retried.refuse(new Error("Could not connect to BDK wallet: no answer"));
      await done(retry);
      expect(retry).toHaveFocus();

      await press(user, clear);
      busy(clear);
      expect(retry).toBeDisabled();
      cleared.refuse(new Error("A payment is still in flight through BDK wallet"));
      await done(clear);
      expect(clear).toHaveFocus();
    });

    it("Use this server is busy where pressed and keeps the keys after a refusal; once used, or on Cancel, Change server takes them", async () => {
      let used = later<void>();
      const { user } = renderApp(<SourcePicker kind="onchain" view={failing()} onRetry={async () => {}} onReconfigure={() => used.promise} />);
      await user.click(screen.getByTestId("onchain-source-change-server"));
      const save = screen.getByTestId("onchain-source-server-save");
      await press(user, save);
      busy(save);
      expect(save).toHaveTextContent("Connecting…");
      used.refuse(new Error("Could not connect to BDK wallet: wrong network"));
      await done(save);
      expect(save).toHaveFocus();

      used = later();
      await user.keyboard("{Enter}");
      used.answer();
      await waitFor(() => expect(screen.getByTestId("onchain-source-change-server")).toHaveFocus());

      await user.keyboard("{Enter}");
      await press(user, screen.getByRole("button", { name: "Cancel" }));
      expect(screen.getByTestId("onchain-source-change-server")).toHaveFocus();
    });

    it("a provider's save is busy where pressed and keeps the keys after a refusal", async () => {
      const set = later<void>();
      const { user } = renderApp(<SourcePicker kind="lightning" view={sourceView({ offered: offered("lightning", "mainnet") })} onSet={() => set.promise} />);
      await choose(user, screen.getByRole("combobox", { name: "Lightning source" }), "nwc");
      await user.type(screen.getByLabelText("Connection URI"), "nostr+walletconnect://wallet");
      const save = screen.getByTestId("provider-save");
      await press(user, save);
      busy(save);
      expect(save).toHaveTextContent("Connecting…");
      set.refuse(new Error("Could not connect to Nostr Wallet Connect: no answer"));
      await done(save);
      expect(save).toHaveFocus();
    });

    it("once a provider's save has worked, the source select takes the keys from the form it closed", async () => {
      const set = later<void>();
      const { user } = renderApp(<SourcePicker kind="lightning" view={sourceView({ offered: offered("lightning", "mainnet") })} onSet={() => set.promise} />);
      const select = screen.getByRole("combobox", { name: "Lightning source" });
      await choose(user, select, "nwc");
      await user.type(screen.getByLabelText("Connection URI"), "nostr+walletconnect://wallet");
      await press(user, screen.getByTestId("provider-save"));
      set.answer();
      await screen.findByTestId("lightning-source-saved");
      expect(screen.queryByTestId("provider-save")).not.toBeInTheDocument();
      // SourcePicker moves the focus in an effect, which may run after the saved line is in the page.
      await waitFor(() => expect(select).toHaveFocus());
    });

    /** The card as BitcoinWalletPanel holds it: Remove clears the source, and the engine's view follows (`late`: once it has answered). */
    function Removable({ list, late = false }: { list: ReturnType<typeof offered>; late?: boolean }) {
      const [view, setView] = useState(() => ({ ...failing(), offered: list }));
      const cleared = () => setView(sourceView({ mode: "testnet", offered: list }));
      return <SourcePicker kind="onchain" view={view} onSet={async () => {}} onRetry={async () => {}} onReconfigure={async () => {}}
        onClear={async () => { if (late) setTimeout(cleared, 10); else cleared(); }} />;
    }

    for (const late of [false, true]) {
      it(`once Remove has worked, the source select takes the keys from the button it took away${late ? " (the view follows later)" : ""}`, async () => {
        const { user } = renderApp(<Removable list={offered("onchain", "testnet")} late={late} />);
        await press(user, screen.getByTestId("onchain-source-clear"));
        await waitFor(() => expect(screen.queryByTestId("onchain-source-clear")).not.toBeInTheDocument());
        await waitFor(() => expect(screen.getByRole("combobox", { name: "Bitcoin source" })).toHaveFocus());
      });
    }

    it("once Remove has worked on a card with nothing else to choose, the source's row takes the keys", async () => {
      const { user } = renderApp(<Removable list={[]} />);
      await press(user, screen.getByTestId("onchain-source-clear"));
      await waitFor(() => expect(screen.queryByTestId("onchain-source-clear")).not.toBeInTheDocument());
      await waitFor(() => expect(screen.getByTestId("onchain-source-status")).toHaveFocus());
    });
  });

  /** The rows as a wallet panel holds them: its own run, which the rows share. */
  function Rows({ reveal, exportBackup, restorePhrase }: { reveal: () => Promise<string>; exportBackup: (password: string) => Promise<string>; restorePhrase: (phrase: string) => Promise<void> }) {
    const { busy, running, run } = useRun();
    return <BackupRows name="Ark" busy={busy} running={running} run={run} canReplace reveal={reveal} exportBackup={exportBackup} restorePhrase={restorePhrase} restoreFile={async () => {}} />;
  }

  describe("a wallet's backup rows", () => {
    it("Show (the recovery phrase) and the file's Download are busy where pressed and keep the keys after a refusal", async () => {
      const revealed = later<string>(), exported = later<string>();
      const { user } = renderApp(<Rows reveal={() => revealed.promise} exportBackup={() => exported.promise} restorePhrase={async () => {}} />);
      const show = screen.getByTestId("ark-recovery-show");
      await press(user, show);
      busy(show);
      expect(screen.getByRole("button", { name: "Download" })).toBeEnabled();
      revealed.refuse(new Error("The wallet is locked"));
      await done(show);
      expect(show).toHaveFocus();

      await user.click(screen.getByRole("button", { name: "Download" }));
      await user.type(screen.getByLabelText("Ark backup password"), "a long password");
      // Open, the row's own button says Cancel: the one Download left is the file's.
      const download = screen.getByRole("button", { name: "Download" });
      await press(user, download);
      busy(download);
      expect(show).toBeDisabled();
      exported.refuse(new Error("The wallet is locked"));
      await done(download);
      expect(download).toHaveFocus();
    });

    it("Restore from the phrase is busy where pressed and keeps the keys after a refusal; once restored, the row's Restore takes them", async () => {
      let restored = later<void>();
      const { user } = renderApp(<Rows reveal={async () => ""} exportBackup={async () => ""} restorePhrase={() => restored.promise} />);
      await user.click(screen.getByRole("button", { name: "Restore" }));
      await user.type(screen.getByRole("textbox", { name: "Recovery phrase" }), "abandon ability able");
      const go = screen.getByRole("button", { name: "Restore from phrase" });
      await press(user, go);
      busy(go);
      restored.refuse(new Error("Not a recovery phrase"));
      await done(go);
      expect(go).toHaveFocus();

      restored = later();
      await user.keyboard("{Enter}");
      restored.answer();
      await waitFor(() => expect(screen.getByRole("button", { name: "Restore" })).toHaveFocus());
    });
  });
});

// covers: wallet.lightning.sources, wallet.onchain.sources
describe("ProviderConfigForm", () => {
  /** The generic form a provider gets from its declared fields (every provider without its own form). */
  const form = (d: ProviderDescriptorView, mode: "mainnet" | "testnet" = "mainnet", busy = false, saving = false) => {
    const onSubmit = vi.fn();
    return { onSubmit, ...renderApp(<ProviderConfigForm descriptor={d} mode={mode} busy={busy} saving={saving} onSubmit={onSubmit} />) };
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
    // The label is the provider's (a <bdi>), the mark the app's, beside it.
    expect(screen.getByText("TLS certificate").parentElement!.textContent).toBe("TLS certificate (optional)");
    expect(screen.getByText("Macaroon (hex)").parentElement!.textContent).toBe("Macaroon (hex)");
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

  it("says it is connecting while it saves, busy and still focusable; another run of the card only disables it", () => {
    const { unmount } = form(descriptor("nwc"), "mainnet", true, true);
    expect(screen.getByTestId("provider-save")).toHaveTextContent("Connecting…");
    expect(screen.getByTestId("provider-save")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("provider-save")).toBeEnabled();
    unmount();
    form(descriptor("nwc"), "mainnet", true);
    expect(screen.getByTestId("provider-save")).toBeDisabled();
    expect(screen.getByTestId("provider-save")).not.toHaveTextContent("Connecting…");
  });

  it("submits with Enter from a field", async () => {
    const { user, onSubmit } = form(descriptor("nwc"));
    await user.type(screen.getByLabelText("Connection URI"), "nostr+walletconnect://abc{enter}");
    expect(onSubmit).toHaveBeenCalledWith({ uri: "nostr+walletconnect://abc" });
  });
});

// covers: wallet.lightning.sources, wallet.onchain.sources, app.i18n
describe("in Arabic, a payment provider's form", () => {
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

// covers: wallet.lightning.sources, wallet.onchain.sources, wallet.instances.create
describe("a provider's lines and their English keys", () => {
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
});

// covers: wallet.onchain.bdk.create, wallet.lightning.breez.connect, wallet.lightning.webln.connect
describe("the providers' own forms", () => {
  /** A valid BIP39 phrase (the standard test vector), to restore from. */
  const RESTORE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

  function render(Form: ComponentType<ProviderFormProps>, id: string, mode: "mainnet" | "testnet", busy = false, saving = false) {
    const onSubmit = vi.fn();
    return { onSubmit, ...renderApp(<Form descriptor={descriptor(id)} mode={mode} busy={busy} saving={saving} onSubmit={onSubmit} />) };
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

    it("says it is connecting while it saves, busy and still focusable; another run of the card only disables it", () => {
      const { unmount } = render(BreezForm, "breez", "testnet", true, true);
      expect(save()).toHaveTextContent("Connecting…");
      expect(save()).toHaveAttribute("aria-busy", "true");
      expect(save()).toBeEnabled();
      unmount();
      render(BreezForm, "breez", "testnet", true);
      expect(save()).not.toHaveTextContent("Connecting…");
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

    it("waits for the wallet while it saves, busy and still focusable", () => {
      render(WeblnForm, "webln", "mainnet", true, true);
      expect(screen.getByTestId("provider-save")).toHaveTextContent("Waiting for the wallet…");
      expect(screen.getByTestId("provider-save")).toHaveAttribute("aria-busy", "true");
      expect(screen.getByTestId("provider-save")).toBeEnabled();
    });
  });
});

// covers: wallet.ark.backup, wallet.bark.backup, wallet.usdt.backup
describe("a wallet's recovery phrase on screen keeps the window secure (Android)", () => {
  function Rows() {
    const { busy, running, run } = useRun();
    return <BackupRows name="Ark" busy={busy} running={running} run={run} reveal={async () => "abandon ability able"} exportBackup={async () => ""} />;
  }

  let hide: ReturnType<typeof vi.fn<(on: boolean) => Promise<void>>>;
  beforeEach(() => {
    hide = vi.fn(async (_on: boolean) => {});
    setBrowserHost({ hideFromSwitcher: hide } as Partial<BrowserHost> as BrowserHost);
  });
  afterEach(() => lockSecuresWindow(false));

  it("with the app lock off: secure while the phrase shows, not once it is hidden or the rows go", async () => {
    lockSecuresWindow(false);
    const { user, unmount } = renderApp(<Rows />);
    expect(hide).not.toHaveBeenCalledWith(true);
    await user.click(screen.getByTestId("ark-recovery-show"));
    await waitFor(() => expect(screen.getByTestId("ark-recovery")).toBeInTheDocument());
    expect(hide).toHaveBeenLastCalledWith(true);
    await user.click(screen.getByTestId("ark-recovery-show"));
    expect(screen.queryByTestId("ark-recovery")).not.toBeInTheDocument();
    expect(hide).toHaveBeenLastCalledWith(false);
    await user.click(screen.getByTestId("ark-recovery-show"));
    await waitFor(() => expect(hide).toHaveBeenLastCalledWith(true));
    unmount();
    expect(hide).toHaveBeenLastCalledWith(false);
  });

  it("with the app lock on: hiding the phrase leaves the window secure", async () => {
    lockSecuresWindow(true);
    const { user } = renderApp(<Rows />);
    await user.click(screen.getByTestId("ark-recovery-show"));
    await waitFor(() => expect(screen.getByTestId("ark-recovery")).toBeInTheDocument());
    await user.click(screen.getByTestId("ark-recovery-show"));
    expect(screen.queryByTestId("ark-recovery")).not.toBeInTheDocument();
    expect(hide).toHaveBeenLastCalledWith(true);
    expect(hide).not.toHaveBeenCalledWith(false);
  });
});
