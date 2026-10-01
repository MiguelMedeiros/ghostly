import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { ProfileBackups } from "../../components/ProfileBackups";
import { Profile } from "../../pages/Profile";
import { openProfileBackup, restoreOpenedBackup, sameIdentityProfiles } from "../../lib/profileBackup";
import { createProfile, switchProfile, type ProfileEntry } from "../../lib/profiles";
import { renderApp } from "../render";

function Where() { const { pathname, search } = useLocation(); return <p data-testid="where">{pathname + search}</p>; }
// covers: backup.profile.same-device

// Which profiles a bundle is a copy of is worked out elsewhere (packages/browser/test/profileRestoreSameDevice.test.ts):
// here, what the person is asked and what each answer does.
vi.mock("../../lib/profileBackup", async (original) => ({
  ...(await original<typeof import("../../lib/profileBackup")>()),
  openProfileBackup: vi.fn(async () => ({ name: "Work", payload: {} })),
  sameIdentityProfiles: vi.fn(async () => []),
  restoreOpenedBackup: vi.fn(async () => ({ id: "copycopyco", name: "Work", createdAt: 1, restored: true })),
}));
vi.mock("../../lib/profiles", async (original) => ({
  ...(await original<typeof import("../../lib/profiles")>()),
  switchProfile: vi.fn(),
}));

const work: ProfileEntry = { id: "abcdefghij", name: "Work", createdAt: 0 };
const first: ProfileEntry = { id: "", name: "Personal", createdAt: 0 };

async function pickBackup(originals: ProfileEntry[]) {
  vi.mocked(sameIdentityProfiles).mockResolvedValue(originals);
  const view = renderApp(<ProfileBackups canSwitch />);
  const { user } = view;
  await user.click(screen.getByTestId("restore-open"));
  await user.upload(screen.getByTestId("restore-file"), new File(["sealed"], "work.ghostly-backup", { type: "application/json" }));
  await user.type(screen.getByTestId("restore-passphrase"), "a long backup passphrase");
  await waitFor(() => expect(screen.getByTestId("restore-go")).toBeEnabled());
  await user.click(screen.getByTestId("restore-go"));
  return view;
}

describe("restoring a backup of a profile still on this device", () => {
  beforeEach(() => { vi.mocked(restoreOpenedBackup).mockClear(); vi.mocked(switchProfile).mockClear(); vi.mocked(openProfileBackup).mockClear(); });

  it("warns before anything is restored, and Replace restores the copy and opens the original's removal there", async () => {
    const { user } = await pickBackup([work]);
    const warning = await screen.findByTestId("restore-same-device");
    expect(warning).toHaveTextContent("This backup is “Work”, which is on this device");
    expect(warning).toHaveTextContent("Both would act as the same person to your contacts.");
    expect(restoreOpenedBackup, "nothing restored before the person chooses").not.toHaveBeenCalled();
    expect(screen.getByTestId("restore-copy")).toHaveTextContent("Restore as a copy anyway");
    await user.click(screen.getByTestId("restore-replace"));
    await waitFor(() => expect(switchProfile).toHaveBeenCalledWith("copycopyco", { route: "/profile?replace=abcdefghij" }));
    expect(restoreOpenedBackup).toHaveBeenCalledOnce();
  });

  it("restores a copy anyway when asked, and Cancel restores nothing", async () => {
    const { user } = await pickBackup([work]);
    await user.click(await screen.findByTestId("restore-cancel"));
    expect(screen.queryByTestId("restore-same-device")).not.toBeInTheDocument();
    expect(restoreOpenedBackup).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("restore-go"));
    await user.click(await screen.findByTestId("restore-copy"));
    await waitFor(() => expect(switchProfile).toHaveBeenCalledWith("copycopyco", { route: "/profile" }));
  });

  it("offers no Replace when the original is the first profile, which cannot be removed", async () => {
    await pickBackup([first]);
    const warning = await screen.findByTestId("restore-same-device");
    expect(warning).toHaveTextContent("The first profile can't be removed.");
    expect(screen.queryByTestId("restore-replace")).not.toBeInTheDocument();
    expect(screen.getByTestId("restore-copy")).toBeInTheDocument();
  });

  it("the copy's profile page then opens the original's removal, once, with its usual checks", async () => {
    const original = createProfile("Work");
    renderApp(<><Profile /><Routes><Route path="*" element={<Where />} /></Routes></>, { route: `/profile?replace=${original.id}` });
    const dialog = await screen.findByTestId("delete-profile");
    expect(dialog).toHaveTextContent("Work");
    expect(within(dialog).getByTestId("delete-profile-confirm"), "its name, to confirm").toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(/^\/profile$/));
  });

  it("restores a backup of no profile on this device at once, with no warning", async () => {
    await pickBackup([]);
    await waitFor(() => expect(switchProfile).toHaveBeenCalledWith("copycopyco", { route: "/profile" }));
    expect(screen.queryByTestId("restore-same-device")).not.toBeInTheDocument();
  });
});
