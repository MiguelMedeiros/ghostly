import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddAppDialog } from "../../components/apps/AddAppDialog";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";
import type { AppStorePreview, AppStoreSummary } from "@ghostly/browser/engine/apps";

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

describe("Add, the link of a store the person has already", () => {
  const held = (sequence: number, heldSequence?: number) => (): AppStorePreview => ({ ...preview(), sequence, held: heldSequence === undefined ? {} : { sequence: heldSequence } });
  const check = async (answer: () => AppStorePreview) => {
    const added: unknown[] = [];
    fakeEngine.on("appStorePreview", answer).on("appStoreAdd", (params) => { added.push(params); return {} as AppStoreSummary; });
    const onStoreAdded = vi.fn();
    const { user } = renderApp(<AddAppDialog onClose={() => {}} onStoreAdded={onStoreAdded} />);
    await user.type(screen.getByTestId("apps-add-url"), STORE);
    await user.click(screen.getByTestId("apps-add-check"));
    const card = await screen.findByTestId("apps-add-store");
    return { card, user, added, onStoreAdded };
  };

  it("the same index: says it is on the Apps page, with Close and no Add store", async () => {
    const { card } = await check(held(5, 5));
    expect(within(card).getByTestId("apps-add-store-held")).toHaveTextContent("You have this store already: it is on your Apps page.");
    expect(within(card).queryByTestId("apps-add-store-confirm")).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Add store" })).not.toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Close" })).toHaveFocus();
  });

  it("an older index: says it is an older copy, and offers nothing to add", async () => {
    const { card } = await check(held(4, 5));
    expect(within(card).getByTestId("apps-add-store-held")).toHaveTextContent("This is an older copy of a store you have. Yours is newer and stays as it is.");
    expect(within(card).queryByTestId("apps-add-store-confirm")).not.toBeInTheDocument();
  });

  it("a newer index: Update store takes it", async () => {
    const { card, user, added, onStoreAdded } = await check(held(6, 5));
    expect(within(card).getByTestId("apps-add-store-held")).toHaveTextContent("You have this store already. This link holds a newer copy of it.");
    expect(within(card).getByTestId("apps-add-store-confirm")).toHaveTextContent("Update store");
    await user.click(within(card).getByTestId("apps-add-store-confirm"));
    expect(added).toEqual([{ url: STORE, key: "s" }]);
    expect(onStoreAdded).toHaveBeenCalled();
  });

  it("a store not held (or removed): Add store as before, with no such line", async () => {
    const { card } = await check(preview);
    expect(within(card).queryByTestId("apps-add-store-held")).not.toBeInTheDocument();
    expect(within(card).getByTestId("apps-add-store-confirm")).toHaveTextContent("Add store");
  });
});
