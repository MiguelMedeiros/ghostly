import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FederationInfo } from "@ghostly/browser/engine/paymentAdapters/fedimintSdk";
import { FedimintWalletPanel } from "../../components/FedimintWalletPanel";
import type { WalletPlatform, WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: wallet.fedimint.backup, wallet.fedimint.join, wallet.fedimint.notes

/** Two federations of a Testnet wallet: Alpha has movements, Beta was just joined and has none. */
const federation = (id: string, name: string, balance: number) => ({ id, name, balance, status: "ready" as const, lightning: true, invite: `fed1${id}`,
  guardians: [{ id: 0, name: "g0" }], consensusVersion: "2.1", network: "regtest", modules: ["ln", "mint"] });
const ALPHA = "a".repeat(64), BETA = "b".repeat(64);
const state = (history: object[]) => walletView({ mode: "testnet", fedimint: { federations: [federation(ALPHA, "Alpha", 5_000), federation(BETA, "Beta", 0)], balance: 5_000, history } as never }) as WalletState;
const MOVED = [
  { id: "t1", federation: ALPHA, kind: "lightning-out", amount: 12_000, fee: 1_500, state: "done", createdAt: 2 },
  { id: "t2", federation: ALPHA, kind: "notes-in", amount: 300, state: "done", createdAt: 1 },
];
const wallet = (calls: Partial<WalletPlatform> = {}) => calls as WalletPlatform;
const choose = async (user: ReturnType<typeof renderApp>["user"], name: string) => {
  await user.click(screen.getByRole("combobox", { name: "Federation" }));
  await user.click(await screen.findByRole("option", { name: new RegExp(name) }));
};

describe("the Fedimint panel's history", () => {
  it("says Nothing yet for a federation with no movement, whatever the others hold", async () => {
    const { user } = renderApp(<FedimintWalletPanel wallet={wallet()} state={state(MOVED)} />);
    await user.click(screen.getByTestId("wallet-history"));
    expect(within(screen.getByTestId("fedimint-history")).getAllByTestId("fedimint-tx")).toHaveLength(2);
    await choose(user, "Beta");
    const history = screen.getByTestId("fedimint-history");
    expect(within(history).queryAllByTestId("fedimint-tx")).toHaveLength(0);
    expect(history).toHaveTextContent("Nothing yet.");
  });

  it("writes a row's fee as it writes its amount", async () => {
    const { user } = renderApp(<FedimintWalletPanel wallet={wallet()} state={state(MOVED)} />);
    await user.click(screen.getByTestId("wallet-history"));
    expect(screen.getAllByTestId("fedimint-tx")[0]).toHaveTextContent("−12,000 (fee 1,500)");
  });
});

describe("notes made in the Fedimint panel", () => {
  const made = async () => {
    const calls = { fedimintSpendNotes: vi.fn(async () => ({ notes: "notes-out-1", operation: "op-1" })), fedimintTakeBack: vi.fn(async () => "canceled" as const) };
    const { user } = renderApp(<FedimintWalletPanel wallet={wallet(calls)} state={state([])} />);
    await user.click(screen.getByTestId("wallet-send"));
    await user.type(screen.getByTestId("fedimint-send-amount"), "100");
    await user.click(screen.getByTestId("fedimint-spend"));
    expect(await screen.findByTestId("fedimint-notes-out")).toHaveTextContent("notes-out-1");
    return { calls, user };
  };

  it("stay, with their Take back, when a key lands in the amount", async () => {
    const { calls, user } = await made();
    await user.type(screen.getByTestId("fedimint-send-amount"), "5");
    expect(screen.getByTestId("fedimint-notes-out")).toHaveTextContent("notes-out-1");
    expect(screen.queryByTestId("fedimint-spend")).toBeNull();
    await user.click(screen.getByTestId("fedimint-take-back"));
    expect(calls.fedimintTakeBack).toHaveBeenCalledWith(ALPHA, "op-1");
  });

  it("are their federation's: another one shows none, and they are there again on the way back", async () => {
    const { calls, user } = await made();
    await choose(user, "Beta");
    expect(screen.queryByTestId("fedimint-notes-out")).toBeNull();
    expect(screen.getByTestId("fedimint-spend")).toBeInTheDocument();
    await choose(user, "Alpha");
    expect(screen.getByTestId("fedimint-notes-out")).toHaveTextContent("notes-out-1");
    await user.click(screen.getByTestId("fedimint-take-back"));
    expect(calls.fedimintTakeBack).toHaveBeenCalledWith(ALPHA, "op-1");
  });

  it("go when the person says Done, and Create notes is back", async () => {
    const { calls, user } = await made();
    await user.click(screen.getByTestId("fedimint-notes-done"));
    expect(screen.queryByTestId("fedimint-notes-out")).toBeNull();
    expect(screen.queryByTestId("fedimint-take-back")).toBeNull();
    expect(screen.getByTestId("fedimint-spend")).toBeInTheDocument();
    expect(calls.fedimintTakeBack).not.toHaveBeenCalled();
  });
});

describe("a backup file picked under Restore", () => {
  const empty = walletView({ mode: "testnet", fedimint: { federations: [], balance: 0, history: [] } as never }) as WalletState;
  const backup = (text: string, size = text.length) => Object.defineProperty(new File([text], "ghostly-fedimint-backup.json", { type: "application/json" }), "size", { value: size });
  const open = async () => {
    const calls = { fedimintRestoreBackup: vi.fn(async () => ({ joined: 1, failed: [] })) };
    const view = renderApp(<FedimintWalletPanel wallet={wallet(calls)} state={empty} />);
    await view.user.click(screen.getByRole("button", { name: "Restore" }));
    return { calls, ...view };
  };

  it("says when it is too large to be a backup, and asks no password for it", async () => {
    const { user } = await open();
    await user.upload(screen.getByLabelText("…or an encrypted backup file"), backup("{}", 2 * 1024 * 1024));
    expect(await screen.findByText("This backup is too large to restore here.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Fedimint backup file password")).toBeNull();
  });

  it("takes the place of the one picked before: a file that is not read leaves nothing to restore", async () => {
    const { user, calls } = await open();
    const input = screen.getByLabelText("…or an encrypted backup file");
    await user.upload(input, backup('{"first":true}'));
    expect(await screen.findByLabelText("Fedimint backup file password")).toBeInTheDocument();
    await user.upload(input, backup("{}", 2 * 1024 * 1024));
    expect(await screen.findByText("This backup is too large to restore here.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Fedimint backup file password")).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore backup" })).toBeNull();
    expect(calls.fedimintRestoreBackup).not.toHaveBeenCalled();
  });
});

describe("notes taken back in the Fedimint panel", () => {
  it("say so under Send, and never as notes redeemed under Receive", async () => {
    const calls = { fedimintSpendNotes: vi.fn(async () => ({ notes: "notes-out-1", operation: "op-1" })), fedimintTakeBack: vi.fn(async () => "canceled" as const) };
    const { user } = renderApp(<FedimintWalletPanel wallet={wallet(calls)} state={state([])} />);
    await user.click(screen.getByTestId("wallet-send"));
    await user.type(screen.getByTestId("fedimint-send-amount"), "100");
    await user.click(screen.getByTestId("fedimint-spend"));
    await user.click(await screen.findByTestId("fedimint-take-back"));
    expect(calls.fedimintTakeBack).toHaveBeenCalledWith(ALPHA, "op-1");
    expect(await screen.findByTestId("fedimint-taken-back")).toHaveTextContent("Taken back.");
    await user.click(screen.getByTestId("wallet-receive"));
    expect(screen.queryByTestId("fedimint-redeemed")).toBeNull();
    expect(screen.queryByText("Taken back.")).toBeNull();
  });
});

// covers: wallet.fedimint.join, wallet.fedimint.notes, wallet.fedimint.backup
describe("the Fedimint panel", () => {
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

  it("a phone's keyboard is told not to change a typed invite or notes", () => {
    renderApp(<FedimintWalletPanel wallet={{} as WalletPlatform} state={joined()} />);
    for (const field of [screen.getByLabelText("Federation invite code"), screen.getByTestId("fedimint-notes-in")]) {
      expect(field).toHaveAttribute("autocapitalize", "none");
      expect(field).toHaveAttribute("autocorrect", "off");
      expect(field).toHaveAttribute("spellcheck", "false");
    }
  });

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
