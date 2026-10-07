import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { DeleteProfileDialog } from "../../components/DeleteProfileDialog";
import { ProfileBackups } from "../../components/ProfileBackups";
import { backUpToFile } from "../../lib/backupFile";
import { openProfileBackup, profileBackupSizes, restoreOpenedBackup, type BackupOptions, type BackupProgress } from "../../lib/profileBackup";
import { fakeEngine, walletView } from "../fakeEngine";
import { renderApp } from "../render";
// covers: backup.profile.file, backup.progress, backup.unprotected, profiles.delete, backup.light

// The bundle itself is made elsewhere (packages/browser/test/profileBackupStream.test.ts): here only the page around
// it. What `backUpToFile` and a restore would do is played by the test, a step at a time.
vi.mock("../../lib/backupFile", async (original) => ({
  ...(await original<typeof import("../../lib/backupFile")>()),
  backUpToFile: vi.fn(),
}));
vi.mock("../../lib/profileBackup", async (original) => ({
  ...(await original<typeof import("../../lib/profileBackup")>()),
  openProfileBackup: vi.fn(),
  sameIdentityProfiles: vi.fn(async () => []),
  restoreOpenedBackup: vi.fn(),
  profileBackupSizes: vi.fn(async () => ({ everything: 21 * 1024 * 1024, light: 300 * 1024, leftOut: 1, leftOutBytes: 20 * 1024 * 1024 })),
}));

const RESULT = { bytes: 5 * 1024 * 1024, files: 212, fileBytes: 4 * 1024 * 1024, skipped: 0 };
const cancelled = () => Object.assign(new Error("Cancelled"), { name: "AbortError" });
/** A backup the test drives: it reports what the test tells it to, and ends when the test says, or when it is cancelled. */
function drivenBackup() {
  let options!: BackupOptions, onSaving: (() => void) | undefined, finish!: (how: "saved" | "downloaded" | "cancelled") => void, fail!: (error: Error) => void;
  vi.mocked(backUpToFile).mockImplementation((given, _name, saving) => new Promise((resolve, reject) => {
    options = given; onSaving = saving;
    finish = (how) => resolve({ how, result: RESULT });
    fail = reject;
    given.signal?.addEventListener("abort", () => reject(cancelled()));
  }));
  return {
    get options() { return options; },
    tell: (progress: BackupProgress) => act(() => options.onProgress?.(progress)),
    saving: () => act(() => onSaving?.()),
    finish: (how: "saved" | "downloaded" | "cancelled") => act(async () => { finish(how); await Promise.resolve(); }),
    fail: (error: Error) => act(async () => { fail(error); await Promise.resolve(); }),
  };
}
async function startBackup(user: ReturnType<typeof renderApp>["user"]) {
  await user.click(screen.getByTestId("backup-open"));
  await user.type(screen.getByTestId("backup-passphrase"), "a long backup passphrase");
  await user.type(screen.getByTestId("backup-confirm"), "a long backup passphrase");
  await user.click(screen.getByTestId("backup-download"));
}

describe("a profile backup's file", () => {
  beforeEach(() => { vi.mocked(backUpToFile).mockReset(); vi.mocked(openProfileBackup).mockReset(); vi.mocked(restoreOpenedBackup).mockReset(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("an empty one says why Restore stays off", async () => {
    const { user } = renderApp(<ProfileBackups canSwitch={false} />);
    await user.click(screen.getByTestId("restore-open"));
    await user.type(screen.getByTestId("restore-passphrase"), "a long backup passphrase");
    await user.upload(screen.getByTestId("restore-file"), new File([""], "empty.ghostly-backup", { type: "application/json" }));
    expect(await screen.findByTestId("backup-error")).toHaveTextContent("This file is empty. Choose a backup file.");
    expect(screen.getByTestId("restore-go")).toBeDisabled();
    // A real one takes its place, and the message goes.
    await user.upload(screen.getByTestId("restore-file"), new File(["{}"], "real.ghostly-backup", { type: "application/json" }));
    await waitFor(() => expect(screen.getByTestId("restore-go")).toBeEnabled());
    expect(screen.queryByTestId("backup-error")).not.toBeInTheDocument();
  });

  it("shows what a backup is doing as it goes: the stage, the file, the bytes, then where it was saved", async () => {
    const backup = drivenBackup();
    const { user } = renderApp(<ProfileBackups canSwitch={false} />);
    await startBackup(user);

    const dialog = await screen.findByTestId("backup-progress");
    expect(dialog).toHaveAttribute("role", "dialog");
    expect(dialog).toHaveTextContent("Backing up");
    expect(screen.getByTestId("backup-progress-stage")).toHaveTextContent("Reading the profile");
    // Nothing to measure yet: the bar moves without a figure.
    expect(screen.getByTestId("backup-progress-bar")).not.toHaveAttribute("aria-valuenow");
    expect(backup.options.passphrase).toBe("a long backup passphrase");

    await backup.tell({ stage: "writing", files: 36, filesTotal: 212, bytes: 100 * 1024 * 1024, bytesTotal: 400 * 1024 * 1024 });
    expect(screen.getByTestId("backup-progress-stage")).toHaveTextContent("Encrypting and writing");
    expect(screen.getByTestId("backup-progress-files")).toHaveTextContent("Files 37 of 212");
    expect(screen.getByTestId("backup-progress-bytes")).toHaveTextContent("100.0 MB of 400.0 MB");
    expect(screen.getByTestId("backup-progress-bar")).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByTestId("backup-progress-cancel")).toBeEnabled();

    await backup.tell({ stage: "writing", files: 212, filesTotal: 212, bytes: 400 * 1024 * 1024, bytesTotal: 400 * 1024 * 1024 });
    expect(screen.getByTestId("backup-progress-files")).toHaveTextContent("Files 212 of 212");
    expect(screen.getByTestId("backup-progress-bar")).toHaveAttribute("aria-valuenow", "100");
    // The bundle is whole; the file is being saved (the desktop app's dialog is open): nothing left to cancel here.
    await backup.saving();
    expect(screen.getByTestId("backup-progress-stage")).toHaveTextContent("Saving the file");
    expect(screen.queryByTestId("backup-progress-cancel")).not.toBeInTheDocument();

    await backup.finish("saved");
    await waitFor(() => expect(screen.queryByTestId("backup-progress")).not.toBeInTheDocument());
    expect(screen.getByTestId("backup-done")).toHaveTextContent(/^Saved as [\w-]+\.ghostly-backup · 5\.0 MB$/);
    expect(vi.mocked(backUpToFile).mock.calls[0][1]).toMatch(/^[\w-]+\.ghostly-backup$/);
    expect(screen.getByTestId("backup-passphrase"), "the passphrase is not left in the page").toHaveValue("");
  });

  it("a browser's download says the file's name and size too, and files that could not be read are counted", async () => {
    const backup = drivenBackup();
    vi.mocked(backUpToFile).mockResolvedValueOnce({ how: "downloaded", result: { ...RESULT, skipped: 2 } });
    void backup;
    const { user } = renderApp(<ProfileBackups canSwitch={false} />);
    await startBackup(user);
    expect(await screen.findByTestId("backup-done")).toHaveTextContent(/^Downloaded [\w-]+\.ghostly-backup · 5\.0 MB 2 files could not be read on this device and are not in the backup\.$/);
  });

  it("Light is a choice with the size of each before backing up, and the result says what was left out", async () => {
    vi.mocked(backUpToFile).mockResolvedValueOnce({ how: "downloaded", result: { ...RESULT, leftOut: 1, leftOutBytes: 20 * 1024 * 1024 } });
    const { user } = renderApp(<ProfileBackups canSwitch={false} />);
    await user.click(screen.getByTestId("backup-open"));
    expect(await screen.findByTestId("backup-content-size")).toHaveTextContent("Files: 21.0 MB");
    await user.click(screen.getByRole("radio", { name: "Light" }));
    expect(screen.getByTestId("backup-content-size")).toHaveTextContent("Files: 300 KB. Leaves out 20.0 MB.");
    await user.click(within(screen.getByTestId("backup-content")).getByTestId("row-info"));
    expect(screen.getByTestId("row-info-text")).toHaveTextContent("voice messages up to 4 MB stay");
    await user.type(screen.getByTestId("backup-passphrase"), "a long backup passphrase");
    await user.type(screen.getByTestId("backup-confirm"), "a long backup passphrase");
    await user.click(screen.getByTestId("backup-download"));
    expect(await screen.findByTestId("backup-done")).toHaveTextContent(/^Downloaded [\w-]+\.ghostly-backup · 5\.0 MB Files over 1 MB were left out \(20\.0 MB\)\.$/);
    expect(vi.mocked(backUpToFile).mock.calls[0][0].light).toBe(true);
    expect(vi.mocked(profileBackupSizes)).toHaveBeenCalled();
  });

  it("Cancel stops the backup, and the page says nothing was saved", async () => {
    const backup = drivenBackup();
    const { user } = renderApp(<ProfileBackups canSwitch={false} />);
    await startBackup(user);
    await backup.tell({ stage: "writing", files: 3, filesTotal: 10, bytes: 30, bytesTotal: 100 });
    await user.click(await screen.findByTestId("backup-progress-cancel"));
    await waitFor(() => expect(screen.queryByTestId("backup-progress")).not.toBeInTheDocument());
    expect(backup.options.signal?.aborted).toBe(true);
    expect(screen.getByTestId("backup-done")).toHaveTextContent("Cancelled. Nothing was saved.");
    expect(screen.queryByTestId("backup-error")).not.toBeInTheDocument();
    expect(screen.getByTestId("backup-passphrase"), "the passphrase stays, to try again").toHaveValue("a long backup passphrase");
  });

  it("a save dialog the person closed saves nothing, and nothing is said to be saved", async () => {
    const backup = drivenBackup();
    const { user } = renderApp(<ProfileBackups canSwitch={false} />);
    await startBackup(user);
    await backup.finish("cancelled");
    await waitFor(() => expect(screen.getByTestId("backup-download")).toBeEnabled());
    expect(screen.queryByTestId("backup-done")).not.toBeInTheDocument();
    expect(screen.getByTestId("backup-passphrase"), "the passphrase stays, to try again").toHaveValue("a long backup passphrase");
  });

  it("a backup that fails says why in the app's language, and what to try", async () => {
    const backup = drivenBackup();
    const { user } = renderApp(<ProfileBackups canSwitch={false} />, { language: "pt" });
    await startBackup(user);
    await backup.fail(Object.assign(new Error("This device has no room left for this backup. Free some space, then try again."), {}));
    await waitFor(() => expect(screen.queryByTestId("backup-progress")).not.toBeInTheDocument());
    expect(screen.getByTestId("backup-error")).toHaveTextContent(/espaço/);
    expect(screen.queryByTestId("backup-done")).not.toBeInTheDocument();
  });

  it("a backup without a passphrase is a choice made twice: picked, warned about, then confirmed", async () => {
    const backup = drivenBackup();
    const { user } = renderApp(<ProfileBackups canSwitch={false} />);
    await user.click(screen.getByTestId("backup-open"));
    // Sealed by default: the passphrase fields are there, and nothing downloads without one.
    expect(screen.getByRole("radio", { name: "Passphrase" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("backup-download")).toBeDisabled();

    await user.click(screen.getByRole("radio", { name: "No passphrase" }));
    expect(screen.queryByTestId("backup-passphrase")).not.toBeInTheDocument();
    expect(screen.getByTestId("backup-unprotected-warning")).toHaveTextContent("Not encrypted" + "Anyone with the file gets your keys, chats and money.");
    expect(screen.queryByTestId("backup-unprotected-mainnet"), "no real money here: not said").not.toBeInTheDocument();
    expect(screen.getByTestId("backup-download"), "not before the person says they understand").toBeDisabled();
    await user.click(screen.getByLabelText("I understand. Make it without a passphrase."));
    await user.click(screen.getByTestId("backup-download"));
    await screen.findByTestId("backup-progress");
    expect(backup.options.passphrase, "null: the bundle is not sealed").toBeNull();
    await backup.tell({ stage: "writing", files: 0, filesTotal: 1, bytes: 0, bytesTotal: 10 });
    expect(screen.getByTestId("backup-progress-stage"), "nothing is encrypted, and the bar does not say it is").toHaveTextContent(/^Writing$/);
    await backup.finish("downloaded");
    await screen.findByTestId("backup-done");
    // The next backup is sealed again unless chosen otherwise.
    expect(screen.getByRole("radio", { name: "Passphrase" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("backup-download")).toBeDisabled();
  });

  it("with real money on Mainnet, the warning says so by name", async () => {
    fakeEngine.update({ wallet: walletView({ backupReminders: { "cashu:mainnet": { funded: 1 } } }) });
    const { user } = renderApp(<ProfileBackups canSwitch={false} />);
    await user.click(screen.getByTestId("backup-open"));
    await user.click(screen.getByRole("radio", { name: "No passphrase" }));
    expect(screen.getByTestId("backup-unprotected-mainnet")).toHaveTextContent("This profile has held real money" + "Whoever gets the file can spend it.");
  });

  it("what a backup holds, and what it does not, is behind the ⓘ", async () => {
    const { user } = renderApp(<ProfileBackups canSwitch={false} />);
    await user.click(screen.getAllByTestId("row-info")[0]);
    expect(screen.getByTestId("profile-backups")).toHaveTextContent("files of any size");
    expect(screen.getByTestId("profile-backups")).toHaveTextContent("Not in it: S3 storage keys");
  });

  it("a file made without a passphrase asks for none, and says it was not protected", async () => {
    vi.mocked(openProfileBackup).mockResolvedValue({ name: "Work", protection: "none", payload: { profile: { name: "Work" }, storage: {} } });
    vi.mocked(restoreOpenedBackup).mockResolvedValue({ id: "copycopyco", name: "Work (restored)", createdAt: 1, restored: true });
    const { user } = renderApp(<ProfileBackups canSwitch={false} />);
    await user.click(screen.getByTestId("restore-open"));
    const header = `${JSON.stringify({ format: "ghostly-backup", version: 2, protection: "none", check: { name: "SHA-256-chain" } })}\n`;
    await user.upload(screen.getByTestId("restore-file"), new File([header, "frames"], "open.ghostly-backup"));
    expect(await screen.findByTestId("restore-unprotected")).toHaveTextContent("This backup has no passphrase. Anyone who had the file could read it.");
    expect(screen.queryByTestId("restore-passphrase")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("restore-go"));
    expect(await screen.findByTestId("backup-done")).toHaveTextContent("Restored as “Work (restored)”.");
    expect(vi.mocked(openProfileBackup).mock.calls[0][1], "no passphrase is made up for it").toBeUndefined();
    // A sealed one picked next asks for its passphrase again.
    await user.upload(screen.getByTestId("restore-file"), new File(['{"format":"ghostly-backup","version":1}'], "sealed.ghostly-backup"));
    expect(await screen.findByTestId("restore-passphrase")).toBeInTheDocument();
    expect(screen.queryByTestId("restore-unprotected")).not.toBeInTheDocument();
  });

  it("a restore shows its progress, and Cancel says nothing was restored", async () => {
    vi.mocked(openProfileBackup).mockResolvedValue({ name: "Work", protection: "passphrase", payload: { profile: { name: "Work" }, storage: {} } });
    let run!: Parameters<typeof restoreOpenedBackup>[1];
    vi.mocked(restoreOpenedBackup).mockImplementation((_opened, given) => new Promise((_resolve, reject) => { run = given; given?.signal?.addEventListener("abort", () => reject(cancelled())); }));
    const { user } = renderApp(<ProfileBackups canSwitch={false} />);
    await user.click(screen.getByTestId("restore-open"));
    await user.upload(screen.getByTestId("restore-file"), new File(["sealed"], "work.ghostly-backup"));
    await user.type(screen.getByTestId("restore-passphrase"), "a long backup passphrase");
    await waitFor(() => expect(screen.getByTestId("restore-go")).toBeEnabled());
    await user.click(screen.getByTestId("restore-go"));
    const dialog = await screen.findByTestId("backup-progress");
    expect(dialog).toHaveTextContent("Restoring");
    await waitFor(() => expect(run).toBeDefined());
    act(() => run!.onProgress?.({ stage: "restoring", files: 4, filesTotal: 9, bytes: 512 * 1024, bytesTotal: 2 * 1024 * 1024 }));
    expect(screen.getByTestId("backup-progress-files")).toHaveTextContent("Files 5 of 9");
    expect(screen.getByTestId("backup-progress-bytes")).toHaveTextContent("512 KB of 2.0 MB");
    act(() => run!.onProgress?.({ stage: "verifying", files: 9, filesTotal: 9, bytes: 2 * 1024 * 1024, bytesTotal: 2 * 1024 * 1024 }));
    expect(screen.getByTestId("backup-progress-stage")).toHaveTextContent("Checking the backup");
    await user.click(screen.getByTestId("backup-progress-cancel"));
    await waitFor(() => expect(screen.queryByTestId("backup-progress")).not.toBeInTheDocument());
    expect(screen.getByTestId("backup-done")).toHaveTextContent("Cancelled. Nothing was restored.");
  });

  it("on a phone the progress is a sheet from the bottom", async () => {
    const wide = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query.includes("max-width"), media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
    try {
      drivenBackup();
      const { user } = renderApp(<ProfileBackups canSwitch={false} />);
      await startBackup(user);
      expect(await screen.findByTestId("backup-progress")).toHaveAttribute("data-side", "bottom");
    } finally { window.matchMedia = wide; }
  });

  it("the delete dialog's backup shows its progress too, and is only marked saved when it was", async () => {
    const backup = drivenBackup();
    const { user } = renderApp(<DeleteProfileDialog entry={{ id: "abcdefghij", name: "Work", createdAt: 0 }} onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Download a backup first" }));
    await user.type(screen.getByLabelText("Backup passphrase"), "a long backup passphrase");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByTestId("backup-progress");
    expect(vi.mocked(backUpToFile).mock.calls[0][1]).toBe("Work.ghostly-backup");
    expect(backup.options).toMatchObject({ passphrase: "a long backup passphrase", id: "abcdefghij" });
    await backup.finish("cancelled");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    expect(screen.queryByText("Backup downloaded ✓")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByTestId("backup-progress");
    await backup.finish("saved");
    expect(await screen.findByText("Backup downloaded ✓")).toBeInTheDocument();
  });

  it.each([
    ["仕事", "仕事.ghostly-backup"],
    ["Trabalho é bom", "Trabalho-é-bom.ghostly-backup"],
    ["عمل", "عمل.ghostly-backup"],
    ["!!!", "profile.ghostly-backup"],
  ])("backing up %s before deleting it saves %s", async (name, file) => {
    vi.mocked(backUpToFile).mockResolvedValue({ how: "downloaded", result: RESULT });
    const { user } = renderApp(<DeleteProfileDialog entry={{ id: "abcdefghij", name, createdAt: 0 }} onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Download a backup first" }));
    await user.type(screen.getByLabelText("Backup passphrase"), "a long backup passphrase");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(vi.mocked(backUpToFile).mock.calls.map((call) => call[1])).toEqual([file]));
  });
});
