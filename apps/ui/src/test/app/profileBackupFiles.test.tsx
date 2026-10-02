import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { DeleteProfileDialog } from "../../components/DeleteProfileDialog";
import { ProfileBackups } from "../../components/ProfileBackups";
import { servicesPlatform } from "../../lib/platform";
import { renderApp } from "../render";
// covers: backup.profile.file, profiles.delete

// The bundle itself is made elsewhere (packages/browser/test/profileBackup.test.ts): here only the file around it.
vi.mock("../../lib/profileBackup", async (original) => ({
  ...(await original<typeof import("../../lib/profileBackup")>()),
  createProfileBackup: vi.fn(async () => "sealed bundle"),
}));

describe("a profile backup's file", () => {
  afterEach(() => { vi.restoreAllMocks(); delete (servicesPlatform as { saveBlob?: unknown }).saveBlob; });

  // The desktop app's WebView downloads nothing from a link: there the file goes through the system's save dialog.
  const fillAndDownload = async (saveBlob: (blob: Blob, name: string) => Promise<boolean | null>) => {
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    Object.assign(servicesPlatform!, { saveBlob });
    const { user } = renderApp(<ProfileBackups canSwitch={false} />);
    await user.click(screen.getByTestId("backup-open"));
    await user.type(screen.getByTestId("backup-passphrase"), "a long backup passphrase");
    await user.type(screen.getByTestId("backup-confirm"), "a long backup passphrase");
    await user.click(screen.getByTestId("backup-download"));
    return clicked;
  };

  it("where the platform has a save dialog, the backup is saved through it and the page names the file", async () => {
    const saveBlob = vi.fn(async (_blob: Blob, _name: string) => true);
    const clicked = await fillAndDownload(saveBlob);
    expect(await screen.findByTestId("backup-done")).toHaveTextContent(/^Saved as [\w-]+\.ghostly-backup · 1 KB$/);
    expect(saveBlob).toHaveBeenCalledWith(expect.any(Blob), expect.stringMatching(/^[\w-]+\.ghostly-backup$/));
    expect(await saveBlob.mock.calls[0]![0].text()).toBe("sealed bundle");
    expect(clicked, "no link is clicked: nothing would come of it there").not.toHaveBeenCalled();
    expect(screen.getByTestId("backup-passphrase")).toHaveValue("");
  });

  it("a save dialog the person closed saves nothing, and nothing is said to be saved", async () => {
    const saveBlob = vi.fn(async (_blob: Blob, _name: string) => false);
    const clicked = await fillAndDownload(saveBlob);
    await waitFor(() => expect(screen.getByTestId("backup-download")).toBeEnabled());
    expect(saveBlob).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("backup-done")).not.toBeInTheDocument();
    expect(clicked).not.toHaveBeenCalled();
    expect(screen.getByTestId("backup-passphrase"), "the passphrase stays, to try again").toHaveValue("a long backup passphrase");
  });

  it("the delete dialog's backup goes through the save dialog too, and is only marked saved when it was", async () => {
    const answers = [false, true];
    const saveBlob = vi.fn(async (_blob: Blob, _name: string) => answers.shift()!);
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    Object.assign(servicesPlatform!, { saveBlob });
    const { user } = renderApp(<DeleteProfileDialog entry={{ id: "abcdefghij", name: "Work", createdAt: 0 }} onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Download a backup first" }));
    await user.type(screen.getByLabelText("Backup passphrase"), "a long backup passphrase");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveBlob).toHaveBeenCalledWith(expect.any(Blob), "Work.ghostly-backup"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    expect(screen.queryByText("Backup downloaded ✓")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Backup downloaded ✓")).toBeInTheDocument();
    expect(clicked).not.toHaveBeenCalled();
  });

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

  it.each([
    ["仕事", "仕事.ghostly-backup"],
    ["Trabalho é bom", "Trabalho-é-bom.ghostly-backup"],
    ["عمل", "عمل.ghostly-backup"],
    ["!!!", "profile.ghostly-backup"],
  ])("backing up %s before deleting it downloads %s", async (name, file) => {
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
    URL.createObjectURL ??= () => "blob:x";
    URL.revokeObjectURL ??= () => {};
    const { user } = renderApp(<DeleteProfileDialog entry={{ id: "abcdefghij", name, createdAt: 0 }} onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Download a backup first" }));
    await user.type(screen.getByLabelText("Backup passphrase"), "a long backup passphrase");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(names).toEqual([file]));
  });
});
