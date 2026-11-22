import { afterEach, describe, expect, it, vi } from "vitest";
import { act, configure, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { Settings } from "../../pages/Settings";
import { AddDeviceDialog } from "../../components/devices/AddDeviceDialog";
import { hashPassword } from "../../lib/settings";
import { renderApp } from "../render";
// covers: profiles.lock, settings.lock.password, devices.enroll

/*
 * The lock password typed anywhere but the lock screen (Add a device, Settings' current password) is paced with the
 * lock screen's own count: a wrong one counts, and a wait already running refuses even the right one.
 */
configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

const ATTEMPTS_KEY = "ghostly_lock_attempts";
const attempts = () => JSON.parse(localStorage.getItem(ATTEMPTS_KEY) ?? "null") as { failures: number; retryAt: number } | null;
const storedHash = () => JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}").lockScreen?.passwordHash ?? null;

async function lockWith(password: string) {
  const hash = await hashPassword(password);
  localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: hash, timeoutMinutes: 5 } }));
  return hash;
}

/** The lock screen's wait, five minutes of it, after twelve wrong tries. */
function waitRunning() {
  const retryAt = Date.now() + 5 * 60_000;
  localStorage.setItem(ATTEMPTS_KEY, JSON.stringify({ failures: 12, retryAt }));
  return retryAt;
}

async function renderSettings() {
  const result = renderApp(<LockScreenProvider><UpdateProvider><Routes><Route path="/settings" element={<Settings />} /></Routes></UpdateProvider></LockScreenProvider>, { route: "/settings" });
  result.engine.on("deviceSet", () => ({ state: "single", devices: [] }));
  await waitFor(() => expect(result.engine.callsTo("deviceSet")).toHaveLength(1));
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  return result;
}

afterEach(() => { localStorage.clear(); sessionStorage.clear(); });

describe("the lock password in Add a device", () => {
  it("a wrong one counts as on the lock screen", async () => {
    await lockWith("a long password");
    const { user, engine } = renderApp(<AddDeviceDialog onClose={() => {}} />);
    await user.type(screen.getByTestId("device-add-password"), "not the one");
    await user.click(screen.getByTestId("device-add-next"));
    expect(await screen.findByTestId("device-add-password-error")).toHaveTextContent("Wrong password.");
    expect(attempts()?.failures).toBe(1);
    expect(engine.callsTo("deviceEnrollInvite")).toHaveLength(0);
  });

  it("the right one waits for the lock screen's wait: no code is made, and the count stays", async () => {
    await lockWith("a long password");
    const retryAt = waitRunning();
    const { user, engine } = renderApp(<AddDeviceDialog onClose={() => {}} />);
    engine.on("deviceEnrollInvite", () => ({ role: "inviter", step: "waiting", code: "ghostly1zexample", expires: Math.floor(Date.now() / 1000) + 600 }));
    await user.type(screen.getByTestId("device-add-password"), "a long password");
    await user.click(screen.getByTestId("device-add-next"));
    expect(await screen.findByTestId("device-add-password-error")).toHaveTextContent(/^Too many attempts\. Try again in \d+ s$/);
    expect(engine.callsTo("deviceHandoffVerifier")).toHaveLength(0);
    expect(engine.callsTo("deviceEnrollInvite")).toHaveLength(0);
    expect(attempts()).toEqual({ failures: 12, retryAt });
  });

  it("the right one with no wait clears the count and makes the code", async () => {
    await lockWith("a long password");
    localStorage.setItem(ATTEMPTS_KEY, JSON.stringify({ failures: 2, retryAt: 0 }));
    const { user, engine } = renderApp(<AddDeviceDialog onClose={() => {}} />);
    engine.on("deviceHandoffVerifier", () => {});
    engine.on("deviceEnrollInvite", () => ({ role: "inviter", step: "waiting", code: "ghostly1zexample", expires: Math.floor(Date.now() / 1000) + 600 }));
    await user.type(screen.getByTestId("device-add-password"), "a long password");
    await user.click(screen.getByTestId("device-add-next"));
    expect(await screen.findByTestId("device-add-code")).toBeInTheDocument();
    expect(attempts()).toBeNull();
  });
});

describe("the current lock password in Settings", () => {
  it("a wrong one counts as on the lock screen", async () => {
    const hash = await lockWith("first secret");
    const { user } = await renderSettings();
    await user.click(screen.getByTestId("settings-password-edit"));
    await user.type(screen.getByTestId("settings-password-current"), "not it");
    await user.type(screen.getByTestId("settings-password-new"), "second secret");
    await user.type(screen.getByTestId("settings-password-confirm"), "second secret");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByTestId("settings-password-current-error")).toHaveTextContent("Incorrect password");
    expect(attempts()?.failures).toBe(1);
    expect(storedHash()).toBe(hash);
  });

  it("changing it waits for the lock screen's wait, even with the right one", async () => {
    const hash = await lockWith("first secret");
    const retryAt = waitRunning();
    const { user } = await renderSettings();
    await user.click(screen.getByTestId("settings-password-edit"));
    await user.type(screen.getByTestId("settings-password-current"), "first secret");
    await user.type(screen.getByTestId("settings-password-new"), "second secret");
    await user.type(screen.getByTestId("settings-password-confirm"), "second secret");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByTestId("settings-password-current-error")).toHaveTextContent(/^Too many attempts\. Try again in \d+ s$/);
    expect(storedHash()).toBe(hash);
    expect(attempts()).toEqual({ failures: 12, retryAt });
  });

  it("removing it waits for the lock screen's wait, even with the right one", async () => {
    const hash = await lockWith("first secret");
    const retryAt = waitRunning();
    const { user } = await renderSettings();
    await user.click(screen.getByTestId("settings-password-edit"));
    await user.type(screen.getByTestId("settings-password-current"), "first secret");
    await user.click(screen.getByRole("button", { name: "Remove password" }));
    expect(await screen.findByTestId("settings-password-current-error")).toHaveTextContent(/^Too many attempts\. Try again in \d+ s$/);
    expect(storedHash()).toBe(hash);
    expect(attempts()).toEqual({ failures: 12, retryAt });
  });
});
