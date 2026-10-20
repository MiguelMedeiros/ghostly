import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { newIdentityBinding } from "@ghostly/core";
import { IDENTITY_PROVIDERS } from "@ghostly/browser/proofs/registry";
import { AddIdentityDialog } from "../../components/identities/AddIdentityDialog";
import { renderApp } from "../render";

// covers: proofs.picker, proofs.ssh, app.i18n

/**
 * A provider's name, summary, description, limits, privacy line, signer description and steps come from its module,
 * in English. In Arabic they keep their own direction (a <bdi>), or "(Settings → SSH keys)." showed as
 * ".… (Settings → SSH keys(", and the card follows the dialog's direction: its text at the start, its rounded
 * corners on the outside.
 */
const WITHOUT_OIDC = IDENTITY_PROVIDERS.filter((p) => p.id !== "oidc");
const SSH = IDENTITY_PROVIDERS.find((p) => p.id === "ssh")!;
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

const arabic = () => renderApp(<AddIdentityDialog onClose={() => {}} />, { language: "ar" });
/** The element showing exactly this text is laid out in its own direction: a <bdi>, or dir="auto". */
const ownDirection = (root: HTMLElement, text: string) => {
  const shown = within(root).getByText(text);
  return shown.tagName === "BDI" || shown.getAttribute("dir") === "auto";
};

describe("in Arabic, Identities → Add", () => {
  it.each(WITHOUT_OIDC.map((p) => [p.id, p] as const))("%s: the card's text starts on the dialog's side, its corners outside", async (id, p) => {
    const { user } = arabic();
    if (p.advanced) await user.click(screen.getByTestId("add-identity-advanced"));
    const choose = screen.getByTestId(`add-identity-${id}`), about = screen.getByTestId(`add-identity-about-${id}`);
    expect(choose).toHaveClass("text-start", "rounded-s-xl");
    expect(choose).not.toHaveClass("text-left", "rounded-l-xl");
    expect(about).toHaveClass("rounded-e-xl");
    expect(about).not.toHaveClass("rounded-r-xl");
    const card = screen.getByTestId(`add-identity-card-${id}`);
    expect(ownDirection(card, p.label)).toBe(true);
    expect(ownDirection(card, p.summary)).toBe(true);
    await user.click(about);
    expect(ownDirection(card, p.description)).toBe(true);
    if (p.limits) expect(ownDirection(card, p.limits)).toBe(true);
  });

  it("the chosen provider's lines and its steps keep their own direction, the steps' numbers inside the list", async () => {
    const { user, engine } = arabic();
    engine.on("beginIdentityProof", ({ provider: id, subject, validityDays = 30 }) =>
      ({ draftId: "draft-1", binding: newIdentityBinding({ provider: id, subject: SSH.subject.normalize(subject), validitySeconds: validityDays * 86400 }).binding }));
    await user.click(screen.getByTestId("add-identity-ssh"));
    const dialog = screen.getByTestId("add-identity");
    expect(ownDirection(screen.getByTestId("add-identity-about"), SSH.description)).toBe(true);
    const signer = SSH.signers[0]!;
    if (signer.description) expect(ownDirection(dialog, signer.description)).toBe(true);
    // The provider's sentence, then the app's own: each in its own direction, in the dialog's order.
    expect(ownDirection(dialog, SSH.privacy)).toBe(true);
    await user.type(screen.getByTestId("add-identity-subject"), KEY);
    await user.click(screen.getByTestId("add-identity-start"));
    await screen.findByTestId("add-identity-finish");
    const steps = dialog.querySelector("ol")!;
    expect(steps).toHaveClass("ps-5");
    expect(steps).not.toHaveClass("pl-5");
    const items = within(steps).getAllByRole("listitem");
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.querySelector(":scope > p > bdi")).not.toBeNull();
  });
});
