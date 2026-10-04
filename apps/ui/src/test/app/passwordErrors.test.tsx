import { describe, expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { Settings } from "../../pages/Settings";
import { AddDeviceDialog } from "../../components/devices/AddDeviceDialog";
import { Toast } from "../../components/ui/Toast";
import { useToast } from "../../hooks/useToast";
import { hashPassword } from "../../lib/settings";
import { renderApp } from "../render";
// covers: settings.lock.password, devices.enroll

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

const stored = () => JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}").lockScreen?.passwordHash ?? null;

async function lockWith(password: string) {
  const hash = await hashPassword(password);
  localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: hash, timeoutMinutes: 5 } }));
  return hash;
}

/** Settings for a profile with no device set, once it knows that (until then it takes the stricter rule of a set). */
async function renderSettings() {
  const result = renderApp(<LockScreenProvider><UpdateProvider><Routes><Route path="/settings" element={<Settings />} /></Routes></UpdateProvider></LockScreenProvider>, { route: "/settings" });
  result.engine.on("deviceSet", () => ({ state: "single", devices: [] }));
  await waitFor(() => expect(result.engine.callsTo("deviceSet")).toHaveLength(1));
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  return result;
}

/** The field is marked wrong, says why under it, and has the focus with its text selected, to be typed again. */
function expectRefused(input: HTMLElement, errorTestId: string, text: string) {
  const error = screen.getByTestId(errorTestId);
  expect(error).toHaveTextContent(text);
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(input).toHaveAttribute("aria-describedby", error.id);
  expect(input).toHaveFocus();
  const field = input as HTMLInputElement;
  expect([field.selectionStart, field.selectionEnd]).toEqual([0, field.value.length]);
}

describe("a refused lock password in Settings", () => {
  it("a wrong current password: said under the field and in a floating card, and the password is not changed", async () => {
    const hash = await lockWith("first secret");
    const { user } = await renderSettings();
    await user.click(screen.getByTestId("settings-password-edit"));
    await user.type(screen.getByTestId("settings-password-current"), "not it");
    await user.type(screen.getByTestId("settings-password-new"), "second secret");
    await user.type(screen.getByTestId("settings-password-confirm"), "second secret");
    await user.click(screen.getByRole("button", { name: "Change password" }));

    const card = await screen.findByTestId("settings-notice");
    expect(card).toHaveAttribute("data-tone", "error");
    expect(screen.getByTestId("settings-notice-title")).toHaveTextContent("Password not changed");
    expect(screen.getByTestId("settings-notice-text")).toHaveTextContent("Incorrect password");
    // Read out by screen readers: the card sits in a polite live region.
    expect(card.parentElement).toHaveAttribute("role", "status");
    expect(card.parentElement).toHaveAttribute("aria-live", "polite");
    expectRefused(screen.getByTestId("settings-password-current"), "settings-password-current-error", "Incorrect password");
    expect(stored()).toBe(hash);
    // The form stays open with what was typed.
    expect(screen.getByTestId("settings-password-new")).toHaveValue("second secret");

    // Typing straight away replaces the selected text and clears the field's error; the right one changes the password.
    await user.keyboard("first secret");
    expect(screen.getByTestId("settings-password-current")).toHaveValue("first secret");
    expect(screen.queryByTestId("settings-password-current-error")).toBeNull();
    expect(screen.getByTestId("settings-password-current")).not.toHaveAttribute("aria-invalid");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() => expect(stored()).not.toBe(hash));
    expect(await screen.findByTestId("settings-notice-text")).toHaveTextContent("Password changed successfully");
    expect(screen.getByTestId("settings-notice")).toHaveAttribute("data-tone", "success");
  }, 30_000);

  it("removing with a wrong current password keeps the lock", async () => {
    const hash = await lockWith("first secret");
    const { user } = await renderSettings();
    await user.click(screen.getByTestId("settings-password-edit"));
    await user.type(screen.getByTestId("settings-password-current"), "not it");
    await user.click(screen.getByRole("button", { name: "Remove password" }));
    expect(await screen.findByTestId("settings-notice-title")).toHaveTextContent("Password not removed");
    expectRefused(screen.getByTestId("settings-password-current"), "settings-password-current-error", "Incorrect password");
    expect(stored()).toBe(hash);
  }, 30_000);

  it("too short, then not the same twice: each under its own field, with the card", async () => {
    const { user } = await renderSettings();
    await user.click(screen.getByTestId("settings-lock"));
    await user.type(screen.getByTestId("settings-password-new"), "boo");
    await user.type(screen.getByTestId("settings-password-confirm"), "boo");
    await user.click(screen.getByRole("button", { name: "Set password" }));
    expect(await screen.findByTestId("settings-notice-title")).toHaveTextContent("Password not set");
    expectRefused(screen.getByTestId("settings-password-new"), "settings-password-new-error", "Password must be at least 4 characters");

    await user.type(screen.getByTestId("settings-password-new"), "spooky");
    await user.clear(screen.getByTestId("settings-password-confirm"));
    await user.type(screen.getByTestId("settings-password-confirm"), "spookier");
    await user.click(screen.getByRole("button", { name: "Set password" }));
    await waitFor(() => expect(screen.getByTestId("settings-notice-text")).toHaveTextContent("Passwords do not match"));
    expectRefused(screen.getByTestId("settings-password-confirm"), "settings-password-confirm-error", "Passwords do not match");
    expect(screen.queryByTestId("settings-password-new-error")).toBeNull();
    expect(stored()).toBeNull();
  }, 30_000);
});

describe("a refused lock password in Add a device", () => {
  it("a wrong password: under the field and in a card inside the dialog, and nothing starts", async () => {
    await lockWith("a long password");
    const { user, engine } = renderApp(<AddDeviceDialog onClose={() => {}} />);
    await user.type(screen.getByTestId("device-add-password"), "not the one");
    await user.click(screen.getByTestId("device-add-next"));
    const card = await screen.findByTestId("device-add-notice");
    expect(card).toHaveTextContent("Wrong password.");
    // In the modal dialog, not behind it.
    expect(screen.getByTestId("device-add")).toContainElement(card);
    expectRefused(screen.getByTestId("device-add-password"), "device-add-password-error", "Wrong password.");
    expect(engine.callsTo("deviceHandoffVerifier")).toHaveLength(0);
    expect(engine.callsTo("deviceEnrollInvite")).toHaveLength(0);
  }, 30_000);

  it("a set that could not be made ready says so in the form and in the card", async () => {
    const { user, engine } = renderApp(<AddDeviceDialog onClose={() => {}} />);
    engine.on("deviceHandoffVerifier", () => { throw new Error("offline"); });
    await user.type(screen.getByTestId("device-add-password"), "long enough");
    await user.type(screen.getByTestId("device-add-password-again"), "long enouhg");
    await user.click(screen.getByTestId("device-add-next"));
    expectRefused(await screen.findByTestId("device-add-password-again"), "device-add-password-again-error", "The two passwords are not the same.");
    expect(screen.getByTestId("device-add-notice")).toHaveTextContent("The two passwords are not the same.");
    await user.clear(screen.getByTestId("device-add-password-again"));
    await user.type(screen.getByTestId("device-add-password-again"), "long enough");
    await user.click(screen.getByTestId("device-add-next"));
    expect(await screen.findByTestId("device-add-error")).toHaveTextContent("This password could not be set up for moving the profile. Try again.");
    expect(screen.getByTestId("device-add-notice")).toHaveTextContent("This password could not be set up for moving the profile. Try again.");
    expect(engine.callsTo("deviceEnrollInvite")).toHaveLength(0);
  }, 30_000);
});

describe("the floating card", () => {
  function Harness() {
    const notice = useToast(1_000);
    return <>
      <button type="button" onClick={() => notice.show("Saved", { tone: "success" })}>show</button>
      <Toast toast={notice.toast} onDismiss={notice.dismiss} />
    </>;
  }

  it("goes by itself after a while, or at once with its close button", async () => {
    const { user } = renderApp(<Harness />);
    // The live region is there before anything is said, so the first card is read out too.
    expect(screen.getByTestId("toast-region")).toHaveAttribute("role", "status");
    await user.click(screen.getByRole("button", { name: "show" }));
    expect(screen.getByTestId("toast")).toHaveTextContent("Saved");
    await user.click(screen.getByTestId("toast-close"));
    expect(screen.queryByTestId("toast")).toBeNull();
    await user.click(screen.getByRole("button", { name: "show" }));
    expect(screen.getByTestId("toast")).toBeInTheDocument();
    await act(() => new Promise((resolve) => setTimeout(resolve, 1_100)));
    expect(screen.queryByTestId("toast")).toBeNull();
  });
});
