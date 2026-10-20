import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { FederationInfo } from "@ghostly/browser/engine/paymentAdapters/fedimintSdk";
import { FedimintWalletPanel } from "../../components/FedimintWalletPanel";
import type { WalletPlatform, WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: wallet.fedimint.join, wallet.fedimint.notes, wallet.fedimint.backup

/**
 * The Fedimint panel from the keyboard: the button pressed keeps the focus while it works (busy, not disabled: a
 * disabled one drops it to the page in Chromium) and after a refusal; the panel's other buttons wait, disabled. Look
 * hands the focus to Join, which takes its place, and Cancel hands it back.
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

const ALPHA = "a".repeat(64), BETA = "b".repeat(64);
const federation = (id: string, name: string, balance: number) => ({ id, name, balance, status: "ready" as const, lightning: true, invite: `fed1${id}`,
  guardians: [{ id: 0, name: "g0" }], consensusVersion: "2.1", network: "regtest", modules: ["ln", "mint"] });
const joined = (federations = [federation(ALPHA, "Alpha", 5_000)]) =>
  walletView({ mode: "testnet", fedimint: { federations, balance: federations.reduce((sum, f) => sum + f.balance, 0), history: [] } as never }) as WalletState;
const facts: FederationInfo = { federationId: BETA, name: "Beta", guardians: [{ id: 0, name: "g0" }], consensusVersion: "2.1", network: "regtest", modules: ["ln", "mint"] } as never;

/** One press of `button`, refused: busy while it runs, then the focus still on it. */
async function refused(user: Parameters<typeof press>[0], button: HTMLElement, pending: { refuse(e: Error): void }) {
  await press(user, button);
  busy(button);
  pending.refuse(new Error("The federation did not answer"));
  await done(button);
  expect(button).toHaveFocus();
}

describe("the Fedimint panel", () => {
  it("Look at this federation is busy where pressed and keeps the keys after a refusal; Join takes them, Cancel gives them back", async () => {
    let previewed = later<FederationInfo>();
    const wallet = { fedimintPreview: () => previewed.promise } as Partial<WalletPlatform> as WalletPlatform;
    const { user } = renderApp(<FedimintWalletPanel wallet={wallet} state={joined()} />);
    await user.type(screen.getByLabelText("Federation invite code"), "fed1beta");
    const look = screen.getByTestId("fedimint-preview");
    await refused(user, look, previewed);

    previewed = later();
    await user.keyboard("{Enter}");
    previewed.answer(facts);
    await waitFor(() => expect(screen.getByTestId("fedimint-join")).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("fedimint-preview")).toHaveFocus();
  });

  it("Join is busy where pressed and keeps the keys after a refusal", async () => {
    const joining = later<never>();
    const wallet = { fedimintPreview: async () => facts, fedimintJoin: () => joining.promise } as Partial<WalletPlatform> as WalletPlatform;
    const { user } = renderApp(<FedimintWalletPanel wallet={wallet} state={joined()} />);
    await user.type(screen.getByLabelText("Federation invite code"), "fed1beta");
    await user.click(screen.getByTestId("fedimint-preview"));
    await refused(user, await screen.findByTestId("fedimint-join"), joining);
  });

  it("Create invoice and Redeem are busy where pressed and keep the keys after a refusal", async () => {
    const invoiced = later<never>(), redeemed = later<never>();
    const wallet = { fedimintInvoice: () => invoiced.promise, fedimintReceiveNotes: () => redeemed.promise } as Partial<WalletPlatform> as WalletPlatform;
    const { user } = renderApp(<FedimintWalletPanel wallet={wallet} state={joined()} />);
    await user.type(screen.getByTestId("fedimint-receive-amount"), "100");
    await refused(user, screen.getByTestId("fedimint-receive-invoice"), invoiced);
    await user.type(screen.getByTestId("fedimint-notes-in"), "notes");
    await refused(user, screen.getByTestId("fedimint-redeem"), redeemed);
  });

  it("Create notes and Take them back are busy where pressed and keep the keys after a refusal", async () => {
    let spent = later<{ notes: string; operation: string }>();
    const takenBack = later<never>();
    const wallet = { fedimintSpendNotes: () => spent.promise, fedimintTakeBack: () => takenBack.promise } as Partial<WalletPlatform> as WalletPlatform;
    const { user } = renderApp(<FedimintWalletPanel wallet={wallet} state={joined()} />);
    await user.click(screen.getByTestId("wallet-send"));
    await user.type(screen.getByTestId("fedimint-send-amount"), "100");
    await refused(user, screen.getByTestId("fedimint-spend"), spent);
    spent = later();
    await user.keyboard("{Enter}");
    spent.answer({ notes: "notes-out-1", operation: "op-1" });
    await refused(user, await screen.findByTestId("fedimint-take-back"), takenBack);
  });

  it("Use for Lightning, Leave and Show are busy where pressed and keep the keys after a refusal", async () => {
    const used = later<never>(), left = later<never>(), shown = later<never>();
    const wallet = { lightningSetSource: () => used.promise, fedimintLeave: () => left.promise, fedimintBackup: () => shown.promise } as Partial<WalletPlatform> as WalletPlatform;
    const { user } = renderApp(<FedimintWalletPanel wallet={wallet} state={joined([federation(ALPHA, "Alpha", 0)])} />);
    await refused(user, screen.getByTestId("fedimint-use-lightning"), used);
    await refused(user, screen.getByTestId("fedimint-leave"), left);
    await refused(user, screen.getByRole("button", { name: "Show" }), shown);
  });

  it("Download (the backup file) is busy where pressed and keeps the keys after a refusal", async () => {
    const exported = later<never>();
    const wallet = { fedimintExportBackup: () => exported.promise } as Partial<WalletPlatform> as WalletPlatform;
    const { user } = renderApp(<FedimintWalletPanel wallet={wallet} state={joined()} />);
    await user.click(screen.getByRole("button", { name: "Download" }));
    await user.type(screen.getByLabelText("Fedimint backup password"), "a long backup password");
    // Open, the row's own button says Cancel: the one Download left is the file's.
    await refused(user, screen.getByRole("button", { name: "Download" }), exported);
  });

  it("Restore from phrase is busy where pressed and keeps the keys after a refusal", async () => {
    const restored = later<never>();
    const wallet = { fedimintRestorePhrase: () => restored.promise } as Partial<WalletPlatform> as WalletPlatform;
    const { user } = renderApp(<FedimintWalletPanel wallet={wallet} state={joined([])} />);
    await user.click(screen.getByRole("button", { name: "Restore" }));
    await user.type(screen.getByLabelText("Fedimint recovery phrase"), "twelve words");
    await user.type(screen.getByLabelText("Invite codes to restore"), "fed1alpha");
    await refused(user, screen.getByRole("button", { name: "Restore from phrase" }), restored);
  });
});
