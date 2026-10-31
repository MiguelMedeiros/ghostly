import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddAppDialog } from "../../components/apps/AddAppDialog";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.page

const STORE = "https://raw.githubusercontent.com/g/s/HEAD/ghostly-store.json";

const preview = () => ({ key: "s", fingerprint: "abcd efgh ijkl mnop", url: STORE, name: "Ghostly", kind: "curated" as const,
  sequence: 1, expires: 2_000_000_000, expired: false, apps: 1 });

afterEach(() => { vi.restoreAllMocks(); });

describe("Add, a store's link", () => {
  it("by keyboard on Check: the focus goes to the store's Cancel, not to the page", async () => {
    fakeEngine.on("appStorePreview", preview);
    const { user } = renderApp(<AddAppDialog onClose={() => {}} onStoreAdded={() => {}} />);
    await user.type(screen.getByTestId("apps-add-url"), STORE);
    // Tab to Check, and Enter on it: the button goes as the store's question comes.
    await user.tab();
    await user.tab();
    expect(screen.getByTestId("apps-add-check")).toHaveFocus();
    await user.keyboard("{Enter}");
    const question = await screen.findByTestId("apps-add-store");
    expect(document.activeElement?.closest("[data-testid=apps-add-dialog]")).not.toBeNull();
    expect(within(question).getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("by a click on Check: the same", async () => {
    fakeEngine.on("appStorePreview", preview);
    const { user } = renderApp(<AddAppDialog onClose={() => {}} onStoreAdded={() => {}} />);
    await user.type(screen.getByTestId("apps-add-url"), STORE);
    await user.click(screen.getByTestId("apps-add-check"));
    const question = await screen.findByTestId("apps-add-store");
    expect(within(question).getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("by Enter in the field: the focus stays in the field", async () => {
    fakeEngine.on("appStorePreview", preview);
    const { user } = renderApp(<AddAppDialog onClose={() => {}} onStoreAdded={() => {}} />);
    await user.type(screen.getByTestId("apps-add-url"), `${STORE}{Enter}`);
    await screen.findByTestId("apps-add-store");
    expect(screen.getByTestId("apps-add-url")).toHaveFocus();
  });
});
