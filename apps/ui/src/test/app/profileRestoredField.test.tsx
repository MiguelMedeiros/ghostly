import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { useSettings } from "../../contexts/SettingsContext";
import { DeleteProfileDialog } from "../../components/DeleteProfileDialog";
import { listProfiles, registryKey } from "../../lib/profiles";
import type { Language } from "../../lib/settings";
import { Profile } from "../../pages/Profile";
import { renderApp } from "../render";
// covers: backup.profile.file, app.i18n, profiles.delete

// The bundle itself is made elsewhere (packages/browser/test/profileRestoredName.test.ts): here only the page around it.
vi.mock("../../lib/profileBackup", async (original) => ({
  ...(await original<typeof import("../../lib/profileBackup")>()),
  createProfileBackup: vi.fn(async () => "sealed bundle"),
}));

const WORK = "abcdefghij";
/** A device whose profile in use is "Work", restored from a backup: the registry keeps its name and the mark. */
function restoredWorkInUse() {
  localStorage.setItem(registryKey(), JSON.stringify({ version: 1, active: WORK, profiles: [{ id: "", name: "Personal", createdAt: 0 }, { id: WORK, name: "Work", createdAt: 1, restored: true }] }));
}
const stored = () => (JSON.parse(localStorage.getItem(registryKey())!) as { profiles: { id: string; name: string; restored?: boolean }[] }).profiles.find((p) => p.id === WORK);
const shownName = () => listProfiles().find((p) => p.id === WORK)?.name;

function Language({ to }: { to: Language }) {
  const { updateLanguage } = useSettings();
  return <button type="button" onClick={() => updateLanguage(to)}>{`language ${to}`}</button>;
}

describe("a restored profile's name field", () => {
  it.each([
    ["pt", "Restaurado", "Work (restaurado)"],
    ["es", "Restaurado", "Work (restaurado)"],
  ] as const)("in %s edits the name only, keeps the mark, and says restored once in every language", async (language, tag, shown) => {
    restoredWorkInUse();
    const { user } = renderApp(<><Profile /><Language to="en" /><Language to={language} /></>, { language });
    const field = screen.getByTestId("profile-name");
    // The name, without the word: the word is the tag beside it.
    expect(field).toHaveValue("Work");
    expect(screen.getByTestId("profile-restored-tag")).toHaveTextContent(tag);
    expect(shownName()).toBe(shown);

    // Only the name edited, as Miguel's reproduction did: saved as written, still restored.
    await user.clear(field);
    await user.type(field, "Old work{Enter}");
    expect(stored()).toEqual({ id: WORK, name: "Old work", createdAt: 1, restored: true });
    expect(shownName()).toBe(shown.replace("Work", "Old work"));

    // The displayed name pasted back into the field: the word is the mark, never part of the name.
    await user.clear(field);
    await user.type(field, `${shown.replace("Work", "Older work")}{Enter}`);
    expect(stored()).toEqual({ id: WORK, name: "Older work", createdAt: 1, restored: true });
    expect(field).toHaveValue("Older work");

    // In English the word follows, once, and the field still holds the name only.
    await user.click(screen.getByRole("button", { name: "language en" }));
    await waitFor(() => expect(screen.getByTestId("profile-restored-tag")).toHaveTextContent("Restored"));
    expect(field).toHaveValue("Older work");
    expect(shownName()).toBe("Older work (restored)");
    expect(screen.getByTestId("profile-list")).toHaveTextContent("Older work (restored)");
    await user.click(screen.getByRole("button", { name: `language ${language}` }));
    await waitFor(() => expect(shownName()).toBe(shown.replace("Work", "Older work")));

    // The tag's x takes the mark off: the name alone from then on.
    await user.click(screen.getByTestId("profile-restored-remove"));
    expect(stored()).toEqual({ id: WORK, name: "Older work", createdAt: 1 });
    expect(screen.queryByTestId("profile-restored-tag")).not.toBeInTheDocument();
    expect(shownName()).toBe("Older work");
  });

  it("a registry an earlier build left with the translated word in the name and no mark is read as restored", () => {
    localStorage.setItem(registryKey(), JSON.stringify({ version: 1, active: WORK, profiles: [{ id: "", name: "Personal", createdAt: 0 }, { id: WORK, name: "Old work (restaurado)", createdAt: 1 }] }));
    renderApp(<Profile />, { language: "en" });
    expect(screen.getByTestId("profile-name")).toHaveValue("Old work");
    expect(screen.getByTestId("profile-restored-tag")).toHaveTextContent("Restored");
    expect(shownName()).toBe("Old work (restored)");
  });

  it("deleting one asks for its name and names the backup file after it, without the word", async () => {
    restoredWorkInUse();
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
    URL.createObjectURL ??= () => "blob:x";
    URL.revokeObjectURL ??= () => {};
    // As the Profile page's list hands it over: the entry as shown, read under the app's language.
    const Dialog = () => <DeleteProfileDialog entry={listProfiles().find((p) => p.id === WORK)!} onClose={() => {}} />;
    const { user } = renderApp(<Dialog />, { language: "pt" });
    expect(screen.getByRole("heading")).toHaveTextContent("Work (restaurado)");
    await user.click(screen.getByRole("button", { name: "Baixe um backup antes" }));
    await user.type(screen.getByLabelText("Frase-senha do backup"), "a long backup passphrase");
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(names).toEqual(["Work.ghostly-backup"]));
    expect(screen.getByTestId("delete-profile-confirm")).toHaveAttribute("placeholder", expect.stringContaining("Work"));
    expect(screen.getByTestId("delete-profile-confirm").getAttribute("placeholder")).not.toContain("restaurado");
    await user.type(screen.getByTestId("delete-profile-confirm"), "Work");
    expect(screen.getByTestId("delete-profile-go")).toBeEnabled();
    vi.restoreAllMocks();
  });
});
