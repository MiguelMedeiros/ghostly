import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { AddDeviceDialog } from "../../components/devices/AddDeviceDialog";
import { UseHereDialog } from "../../components/devices/Handoff";
import { renderApp } from "../render";
// covers: devices.enroll, devices.handoff

/*
 * The device dialogs open with the focus on the field their first answer is typed in. happy-dom has no modal dialog, so
 * this gives it a browser's two rules that matter here: nothing inside a closed <dialog> takes the focus (it is hidden),
 * and showModal() puts the focus on the first control inside. Before the fix the field's autoFocus ran while the dialog
 * was still closed, and the focus ended on Close.
 */
const originals = { focus: HTMLElement.prototype.focus, showModal: HTMLDialogElement.prototype.showModal };
beforeEach(() => {
  HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
    const dialog = this.closest("dialog");
    if (dialog && !dialog.open) return;
    originals.focus.call(this, options);
  };
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
    this.querySelector<HTMLElement>("button, input, textarea, select, [tabindex]")?.focus();
  };
});
afterEach(() => {
  HTMLElement.prototype.focus = originals.focus;
  HTMLDialogElement.prototype.showModal = originals.showModal;
});

describe("a device dialog's first focus", () => {
  it("Add a device: the new password field, not Close", async () => {
    renderApp(<AddDeviceDialog onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("device-add-password")).toHaveFocus());
  });

  it("Use here: the lock password field, not Close", async () => {
    renderApp(<UseHereDialog device="Desktop" onClose={() => {}} onStarted={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("handoff-password")).toHaveFocus());
  });
});
