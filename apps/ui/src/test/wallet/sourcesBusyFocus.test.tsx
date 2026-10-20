import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SourcePicker } from "../../components/wallet/providers/SourcePicker";
import { BackupRows } from "../../components/wallet/BackupRows";
import { useRun } from "../../components/wallet/run";
import { renderApp } from "../render";
import { choose } from "../select";
import { offered, sourceView } from "./descriptors";

// covers: wallet.lightning.sources, wallet.onchain.sources, wallet.ark.backup, wallet.bark.backup, wallet.usdt.backup

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
