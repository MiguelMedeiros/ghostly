import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { DeleteProfileDialog } from "../../components/DeleteProfileDialog";
import { ProfileBackups } from "../../components/ProfileBackups";
import { renderApp } from "../render";
// covers: backup.profile.file, profiles.delete

// The bundle itself is made elsewhere (packages/browser/test/profileBackup.test.ts): here only the file around it.
vi.mock("../../lib/profileBackup", async (original) => ({
  ...(await original<typeof import("../../lib/profileBackup")>()),
  createProfileBackup: vi.fn(async () => "sealed bundle"),
}));

describe("a profile backup's file", () => {
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
