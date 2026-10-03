import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { Settings } from "../../pages/Settings";
import { AddDeviceDialog } from "../../components/devices/AddDeviceDialog";
import { JoinProfileDialog } from "../../components/devices/JoinProfileDialog";
import { defaultDeviceName, lockPasswordMin, lockPasswordProblem } from "../../lib/devices";
import { hashPassword } from "../../lib/settings";
import { Home } from "../../pages/Home";
import { renderApp } from "../render";
// covers: devices.enroll

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

const waiting = { role: "inviter" as const, step: "waiting" as const, code: "ghostly1zexample", expires: 1 };

afterEach(() => { vi.unstubAllGlobals(); Reflect.deleteProperty(navigator, "userAgent"); });

describe("the lock password a device set needs (WISP 06 § Adding a device)", () => {
  it("is 8 characters with a device set, 4 without, and typed the same twice", () => {
    expect(lockPasswordMin(false)).toBe(4);
    expect(lockPasswordMin(true)).toBe(8);
    expect(lockPasswordProblem("abcd", "abcd", false)).toBeNull();
    expect(lockPasswordProblem("abcd", "abcd", true)).toBe("short");
    expect(lockPasswordProblem("abcdefg", "abcdefg", true)).toBe("short");
    expect(lockPasswordProblem("abcdefgh", "abcdefgh", true)).toBeNull();
    expect(lockPasswordProblem("abcdefgh", "abcdefgx", true)).toBe("mismatch");
  });

  it("Add a device asks to set one first, and refuses one under 8 characters; nothing starts until it is set", async () => {
    const { user, engine } = renderApp(<AddDeviceDialog onClose={() => {}} />);
    engine.on("deviceEnrollInvite", () => waiting);
    expect(screen.getByText("Set a password first")).toBeInTheDocument();
    expect(screen.getByText("Without a password, anyone holding one of your devices can take this profile.")).toBeInTheDocument();
    await user.type(screen.getByTestId("device-add-password"), "short1");
    await user.type(screen.getByTestId("device-add-password-again"), "short1");
    await user.click(screen.getByTestId("device-add-next"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Use 8 characters or more.");
    expect(engine.callsTo("deviceEnrollInvite")).toHaveLength(0);
    await user.clear(screen.getByTestId("device-add-password")); await user.clear(screen.getByTestId("device-add-password-again"));
    await user.type(screen.getByTestId("device-add-password"), "long enough");
    await user.type(screen.getByTestId("device-add-password-again"), "long enough");
    await user.click(screen.getByTestId("device-add-next"));
    await waitFor(() => expect(engine.callsTo("deviceEnrollInvite")).toHaveLength(1));
    expect(await screen.findByTestId("device-add-code")).toHaveAttribute("data-code", "ghostly1zexample");
    expect(screen.getByText("Valid for 10 minutes")).toBeInTheDocument();
    // The lock is on, with the new password.
    expect(JSON.parse(localStorage.getItem("ghostly_app_settings")!).lockScreen).toMatchObject({ enabled: true });
  });

  it("a password stored with the lock turned off: typing it turns the lock on before the code is made", async () => {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: false, passwordHash: await hashPassword("a long password"), timeoutMinutes: 5 } }));
    const { user, engine } = renderApp(<AddDeviceDialog onClose={() => {}} />);
    engine.on("deviceEnrollInvite", () => waiting);
    await user.type(screen.getByTestId("device-add-password"), "a long password");
    await user.click(screen.getByTestId("device-add-next"));
    await waitFor(() => expect(engine.callsTo("deviceEnrollInvite")).toHaveLength(1));
    expect(JSON.parse(localStorage.getItem("ghostly_app_settings")!).lockScreen).toMatchObject({ enabled: true });
  }, 20_000);

  it("Settings keeps 8 characters while it does not know the profile has no device set (loading, or the call failed)", async () => {
    const settings = () => renderApp(<LockScreenProvider><UpdateProvider><Routes><Route path="/settings" element={<Settings />} /></Routes></UpdateProvider></LockScreenProvider>, { route: "/settings" });
    const { user, engine } = settings();
    engine.on("deviceSet", () => { throw new Error("no answer"); });
    await user.click(screen.getByTestId("settings-lock"));
    const [fresh, again] = screen.getByTestId("settings-password-form").querySelectorAll("input");
    await user.type(fresh, "abcde"); await user.type(again, "abcde");
    await user.click(screen.getByRole("button", { name: "Set password" }));
    expect(await screen.findByText("A profile on several devices keeps its lock password, 8 characters or more.")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}").lockScreen?.passwordHash ?? null).toBeNull();
  }, 20_000);

  it("Settings keeps the 4-character rule for a profile that has no device set", async () => {
    const { user, engine } = renderApp(<LockScreenProvider><UpdateProvider><Routes><Route path="/settings" element={<Settings />} /></Routes></UpdateProvider></LockScreenProvider>, { route: "/settings" });
    engine.on("deviceSet", () => ({ state: "single", devices: [] }));
    await waitFor(() => expect(engine.callsTo("deviceSet")).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await user.click(screen.getByTestId("settings-lock"));
    const [fresh, again] = screen.getByTestId("settings-password-form").querySelectorAll("input");
    await user.type(fresh, "abcde"); await user.type(again, "abcde");
    await user.click(screen.getByRole("button", { name: "Set password" }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("ghostly_app_settings")!).lockScreen.passwordHash).toBeTruthy());
  }, 20_000);

  it("a lock of 4 characters still opens the profile, and is made longer before a device is added", async () => {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: await hashPassword("1234"), timeoutMinutes: 5 } }));
    const { user, engine } = renderApp(<AddDeviceDialog onClose={() => {}} />);
    engine.on("deviceEnrollInvite", () => waiting);
    expect(screen.getByText("Type your lock password")).toBeInTheDocument();
    await user.type(screen.getByTestId("device-add-password"), "4321");
    await user.click(screen.getByTestId("device-add-next"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong password.");
    await user.clear(screen.getByTestId("device-add-password"));
    await user.type(screen.getByTestId("device-add-password"), "1234");
    await user.click(screen.getByTestId("device-add-next"));
    expect(await screen.findByText("Choose a longer password")).toBeInTheDocument();
    expect(engine.callsTo("deviceEnrollInvite")).toHaveLength(0);
  }, 20_000);

  it("the digits, and the person's answer goes to the engine", async () => {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: await hashPassword("a long password"), timeoutMinutes: 5 } }));
    const { user, engine } = renderApp(<AddDeviceDialog onClose={() => {}} />);
    engine.on("deviceEnrollInvite", () => waiting);
    engine.on("deviceEnrollView", () => ({ role: "inviter", step: "confirm", digits: "482913", device: "Phone", kind: "web", refused: 1 }));
    engine.on("deviceEnrollConfirm", () => ({ role: "inviter", step: "adding", device: "Phone" }));
    await user.type(screen.getByTestId("device-add-password"), "a long password");
    await user.click(screen.getByTestId("device-add-next"));
    expect(await screen.findByTestId("device-add-digits", {}, { timeout: 3_000 })).toHaveTextContent("482 913");
    // The name is the new device's own claim; the digits are the check.
    expect(screen.getByTestId("device-add")).toHaveTextContent("The new device calls itself Phone. Do both devices show these digits?");
    expect(screen.getByTestId("device-add-refused")).toHaveTextContent("Another device tried to use this code. It got nothing.");
    await user.click(screen.getByTestId("device-add-match"));
    expect(engine.callsTo("deviceEnrollConfirm")).toEqual([{ match: true }]);
  }, 20_000);
});

describe("I already use Ghostly", () => {
  it("is offered on a new profile, with Add this device to my profile and Restore a backup", async () => {
    const { user } = renderApp(<Home />);
    await user.click(screen.getByTestId("home-already"));
    expect(screen.getByTestId("device-join-add")).toHaveTextContent("Add this device to my profile");
    expect(screen.getByTestId("device-join-restore")).toHaveTextContent("Restore a backup");
  });

  it("on an iPhone in a browser tab it only says to add Ghostly to the Home Screen first", () => {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });
    renderApp(<JoinProfileDialog onClose={() => {}} onRestore={() => {}} />);
    expect(screen.getByTestId("device-join-home-screen")).toHaveTextContent("Add Ghostly to your Home Screen first.");
    expect(screen.queryByTestId("device-join-add")).toBeNull();
  });

  it("names the device from what it is, at most 16 characters", () => {
    expect(defaultDeviceName({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" })).toBe("iPhone");
    expect(defaultDeviceName({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/131.0" })).toBe("Firefox on Mac");
    expect(defaultDeviceName({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", desktop: true })).toBe("Mac app");
    expect(defaultDeviceName({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36 Chrome/131.0" })).toBe("Phone");
    for (const ua of ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0"]) expect(defaultDeviceName({ userAgent: ua }).length).toBeLessThanOrEqual(16);
  });
});
