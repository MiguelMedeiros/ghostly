import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import type { DeviceSetView } from "@ghostly/browser/devices/links";
import { DevicesSection } from "../../components/devices/DevicesSection";
import { renderApp } from "../render";
// covers: devices.screens

/*
 * Rename (WISP 06 § User experience, the row menu): on the active device every row's ⋮ has Rename, this device's own
 * row included; it opens a dialog with the name the set holds, Enter saves, Escape cancels, and the focus comes back
 * to the ⋮. A standby offers none: only the active device writes the set's record.
 */

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

const DESKTOP = "D".repeat(43), PHONE = "P".repeat(43);
const activeSet = (phone = "Chrome, Windows"): DeviceSetView => ({
  state: "active",
  devices: [
    { key: DESKTOP, name: "Desktop", slot: 0, self: true, active: true },
    { key: PHONE, name: phone, slot: 1, self: false, active: false, status: "live" },
  ],
});
const menuItems = () => [...screen.getByTestId("device-menu-items").querySelectorAll("[data-menu-item]")].map((item) => item.getAttribute("data-testid"));
const rowOf = (name: string) => screen.getAllByTestId("device-row").find((row) => row.textContent?.includes(name))!;

describe("Rename, on the active device", () => {
  it("opens with the current name, saves the trimmed name by the device's key on Enter, and shows it on the row", async () => {
    const { user, engine } = renderApp(<DevicesSection />);
    let phone = "Chrome, Windows";
    engine.on("deviceSet", () => activeSet(phone));
    engine.on("deviceRename", (params) => { phone = (params as { name: string }).name; return activeSet(phone); });
    const menu = await screen.findByTestId("device-menu");
    await user.click(menu);
    const items = menuItems();
    expect(items).toEqual(["device-check", "device-rename-open", "device-remove-open"]);
    await user.click(screen.getByTestId("device-rename-open"));
    const dialog = screen.getByTestId("device-rename");
    expect(dialog).toHaveTextContent("Rename Chrome, Windows");
    const field = screen.getByTestId("device-rename-name") as HTMLInputElement;
    expect(field.value).toBe("Chrome, Windows");
    await user.clear(field);
    await user.type(field, "  Work laptop {Enter}");
    await waitFor(() => expect(engine.callsTo("deviceRename")).toEqual([{ key: PHONE, name: "Work laptop" }]));
    await waitFor(() => expect(screen.queryByTestId("device-rename")).toBeNull());
    expect(rowOf("Work laptop")).toBeTruthy();
    await waitFor(() => expect(menu).toHaveFocus());
  });

  it("keeps the name to the 16 bytes a slot holds, as the join step does", async () => {
    const { user, engine } = renderApp(<DevicesSection />);
    engine.on("deviceSet", () => activeSet());
    await user.click(await screen.findByTestId("device-menu"));
    await user.click(screen.getByTestId("device-rename-open"));
    const field = screen.getByTestId("device-rename-name") as HTMLInputElement;
    await user.clear(field);
    await user.type(field, "A very long device name");
    expect(field.value).toBe("A very long devi");
    await user.clear(field);
    expect(screen.getByTestId("device-rename-save")).toBeDisabled();
  });

  it("Escape cancels: nothing is renamed, and the focus is back on the ⋮", async () => {
    const { user, engine } = renderApp(<DevicesSection />);
    engine.on("deviceSet", () => activeSet());
    engine.on("deviceRename", () => activeSet());
    const menu = await screen.findByTestId("device-menu");
    await user.click(menu);
    await user.click(screen.getByTestId("device-rename-open"));
    const dialog = screen.getByTestId("device-rename");
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(screen.queryByTestId("device-rename")).toBeNull());
    await waitFor(() => expect(menu).toHaveFocus());
    // Cancel does the same.
    await user.click(menu);
    await user.click(screen.getByTestId("device-rename-open"));
    await user.click(screen.getByTestId("device-rename-cancel"));
    await waitFor(() => expect(screen.queryByTestId("device-rename")).toBeNull());
    expect(engine.callsTo("deviceRename")).toEqual([]);
  });

  it("renames this device too, from its own row's menu", async () => {
    const { user, engine } = renderApp(<DevicesSection />);
    engine.on("deviceSet", () => activeSet());
    engine.on("deviceRename", () => activeSet());
    await user.click(await screen.findByTestId("device-menu-self"));
    expect(menuItems()).toEqual(["device-rename-open"]);
    await user.click(screen.getByTestId("device-rename-open"));
    const field = screen.getByTestId("device-rename-name");
    await user.clear(field);
    await user.type(field, "Office PC");
    await user.click(screen.getByTestId("device-rename-save"));
    await waitFor(() => expect(engine.callsTo("deviceRename")).toEqual([{ key: DESKTOP, name: "Office PC" }]));
  });

  it("says why the engine refused, keeps the dialog open, and gives the keyboard focus back to the name", async () => {
    const { user, engine } = renderApp(<DevicesSection />);
    engine.on("deviceSet", () => activeSet());
    engine.on("deviceRename", () => { throw new Error("rename-name: A device name cannot hold this character."); });
    await user.click(await screen.findByTestId("device-menu"));
    await user.click(screen.getByTestId("device-rename-open"));
    const field = screen.getByTestId("device-rename-name");
    await user.type(field, "x");
    await user.click(screen.getByTestId("device-rename-save"));
    expect(await screen.findByTestId("device-rename-error")).toHaveTextContent("This name can't be used. Try another one.");
    expect(screen.getByTestId("device-rename")).toBeTruthy();
    // The field and Save were disabled while it saved, which leaves a browser's focus on the page: it comes back here.
    await waitFor(() => expect(field).toHaveFocus());
  });

  it("while the save runs it says so and stays open, so a refusal that comes later is still said", async () => {
    const { user, engine } = renderApp(<DevicesSection />);
    engine.on("deviceSet", () => activeSet());
    let refuse!: (error: Error) => void;
    engine.on("deviceRename", () => new Promise((_, reject) => { refuse = reject; }));
    await user.click(await screen.findByTestId("device-menu"));
    await user.click(screen.getByTestId("device-rename-open"));
    await user.type(screen.getByTestId("device-rename-name"), "x");
    await user.click(screen.getByTestId("device-rename-save"));
    await waitFor(() => expect(engine.callsTo("deviceRename")).toHaveLength(1));
    expect(screen.getByTestId("device-rename-busy")).toHaveTextContent("Saving…");
    expect(screen.getByTestId("device-rename-busy")).toHaveAttribute("role", "status");
    // Escape and the × do nothing while it saves, as Cancel does.
    const dialog = screen.getByTestId("device-rename");
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByTestId("device-rename")).toBeTruthy();
    refuse(new Error("rename-unreachable: Can't check which device is active. Try again."));
    expect(await screen.findByTestId("device-rename-error")).toHaveTextContent("Can't check which device is active.");
    expect(screen.queryByTestId("device-rename-busy")).toBeNull();
  });

  it("on a standby offers no Rename", async () => {
    const { engine } = renderApp(<DevicesSection />);
    engine.on("deviceSet", () => ({ ...activeSet(), state: "standby", devices: activeSet().devices.map((d) => ({ ...d, self: d.key === PHONE, active: d.key === DESKTOP })) }));
    await waitFor(() => expect(screen.getAllByTestId("device-row")).toHaveLength(2));
    expect(screen.queryByTestId("device-menu-self")).toBeNull();
    expect(screen.queryByTestId("device-rename-open")).toBeNull();
  });
});
