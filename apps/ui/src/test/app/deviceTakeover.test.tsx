import { beforeEach, describe, expect, it, vi } from "vitest";
import { toBase64Url } from "@ghostly/core";
import { screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import type { GroupMemberView, GroupView } from "@ghostly/browser/shared/types";
import { ProfileBackups } from "../../components/ProfileBackups";
import { DeviceStandby } from "../../components/DeviceStandby";
import { ForkRows } from "../../components/devices/Forks";
import { GroupChat } from "../../pages/GroupChat";
import { openProfileBackup, restoreOpenedBackup, sameIdentityProfiles } from "../../lib/profileBackup";
import { restoreForTakeover } from "../../lib/restoreGuard";
import { switchProfile } from "../../lib/profiles";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";
// covers: devices.takeover, devices.restore-guard

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

const KEY = "A".repeat(43);
const bundleDevices = { d: toBase64Url(new Uint8Array(32).fill(5)), set: [{ key: KEY, name: "MacBook" }, null], turn: 500, takeovers: 0 };

vi.mock("../../lib/profileBackup", async (original) => ({
  ...(await original<typeof import("../../lib/profileBackup")>()),
  openProfileBackup: vi.fn(async () => ({ name: "Work", protection: "passphrase", payload: { profile: { name: "Work" }, storage: {} } })),
  sameIdentityProfiles: vi.fn(async () => []),
  restoreOpenedBackup: vi.fn(async () => ({ id: "copycopyco", name: "Work", createdAt: 1, restored: true })),
}));
vi.mock("../../lib/restoreGuard", async (original) => ({
  ...(await original<typeof import("../../lib/restoreGuard")>()),
  restoreForTakeover: vi.fn(async () => ({ id: "takentaken", name: "Work", createdAt: 1, restored: true })),
}));
vi.mock("../../lib/profiles", async (original) => ({ ...(await original<typeof import("../../lib/profiles")>()), switchProfile: vi.fn() }));

async function pickBackup(devices?: typeof bundleDevices) {
  vi.mocked(openProfileBackup).mockResolvedValue({ name: "Work", protection: "passphrase", payload: { profile: { name: "Work" }, storage: {} }, ...(devices ? { devices } : {}) });
  const view = renderApp(<ProfileBackups canSwitch />);
  await view.user.click(screen.getByTestId("restore-open"));
  await view.user.upload(screen.getByTestId("restore-file"), new File(["sealed"], "work.ghostly-backup", { type: "application/json" }));
  await view.user.type(screen.getByTestId("restore-passphrase"), "a long backup passphrase");
  return view;
}

describe("restoring a backup where a device set exists (WISP 06)", () => {
  beforeEach(() => { vi.mocked(restoreOpenedBackup).mockClear(); vi.mocked(restoreForTakeover).mockClear(); vi.mocked(switchProfile).mockClear(); vi.mocked(sameIdentityProfiles).mockClear(); });

  it("a record with a device active: the copy does not start; Take over restores it on standby and opens it", async () => {
    const { user, engine } = await pickBackup(bundleDevices);
    engine.on("deviceTurnPeek", () => ({ result: "other", record: { turn: 501, active: 0, slots: [{ key: KEY, name: "MacBook" }, null, null, null] } }));
    await user.click(screen.getByTestId("restore-go"));
    expect(await screen.findByTestId("restore-guard-title")).toHaveTextContent("This profile is active on MacBook");
    expect(engine.callsTo("deviceTurnPeek")).toEqual([{ d: bundleDevices.d }]);
    expect(restoreOpenedBackup).not.toHaveBeenCalled();
    expect(screen.getByTestId("restore-add-instead")).toHaveTextContent("Add this device instead");
    await user.click(screen.getByTestId("restore-take-over"));
    await waitFor(() => expect(switchProfile).toHaveBeenCalledWith("takentaken", { route: "/" }));
    expect(restoreForTakeover).toHaveBeenCalledOnce();
    expect(restoreOpenedBackup).not.toHaveBeenCalled();
  });

  it("no record while the bundle carries a device set (the record expired) is the same case; Cancel restores nothing", async () => {
    const { user, engine } = await pickBackup(bundleDevices);
    engine.on("deviceTurnPeek", () => ({ result: "none" }));
    await user.click(screen.getByTestId("restore-go"));
    expect(await screen.findByTestId("restore-guard-title")).toHaveAttribute("data-case", "active");
    expect(screen.getByTestId("restore-guard-title")).toHaveTextContent("This profile is active on MacBook");
    await user.click(screen.getByTestId("restore-guard-cancel"));
    expect(screen.queryByTestId("restore-guard")).toBeNull();
    expect(restoreOpenedBackup).not.toHaveBeenCalled();
  });

  it("Add this device instead says where to start, and restores nothing", async () => {
    const { user, engine } = await pickBackup(bundleDevices);
    engine.on("deviceTurnPeek", () => ({ result: "other", record: { turn: 501, active: 0, slots: [{ key: KEY, name: "MacBook" }, null, null, null] } }));
    await user.click(screen.getByTestId("restore-go"));
    await user.click(await screen.findByTestId("restore-add-instead"));
    expect(await screen.findByText(/On MacBook, open Profile, then Add a device/)).toBeInTheDocument();
    expect(restoreOpenedBackup).not.toHaveBeenCalled();
  });

  it("a tombstone starts the copy only as a profile of its own, after its name is typed", async () => {
    const { user, engine } = await pickBackup(bundleDevices);
    engine.on("deviceTurnPeek", () => ({ result: "tombstone" }));
    await user.click(screen.getByTestId("restore-go"));
    expect(await screen.findByTestId("restore-guard-title")).toHaveTextContent("This backup is from before a device was removed.");
    expect(screen.getByTestId("restore-own-go")).toBeDisabled();
    await user.type(screen.getByTestId("restore-own-name"), "Work");
    await user.click(screen.getByTestId("restore-own-go"));
    await waitFor(() => expect(restoreOpenedBackup).toHaveBeenCalledOnce());
    expect(restoreForTakeover).not.toHaveBeenCalled();
  });

  it("a turn that cannot be read stops a bundle with a device set, and says so", async () => {
    const { user, engine } = await pickBackup(bundleDevices);
    engine.on("deviceTurnPeek", () => ({ result: "unreachable" }));
    await user.click(screen.getByTestId("restore-go"));
    expect(await screen.findByTestId("restore-guard-title")).toHaveTextContent("Can't check which device is active.");
    expect(restoreOpenedBackup).not.toHaveBeenCalled();
  });

  it("a bundle of a profile that was never enrolled, with no record, restores as before", async () => {
    const { user, engine } = await pickBackup();
    engine.on("deviceTurnPeek", () => ({ result: "none" }));
    await user.click(screen.getByTestId("restore-go"));
    await waitFor(() => expect(restoreOpenedBackup).toHaveBeenCalledOnce());
    expect(screen.queryByTestId("restore-guard")).toBeNull();
  });
});

describe("a replaced device (WISP 06 § User experience: \"Use here\", \"It wasn't me\")", () => {
  it("offers Use here, a pull from the device that replaced it, beside It wasn't me", async () => {
    const { user, engine } = renderApp(<DeviceStandby gate={{ state: "superseded", activeDevice: "Phone" }} />);
    engine.on("deviceTakeoverInfo", () => ({ offered: true, device: "Phone", copy: "frozen", password: true }));
    expect(await screen.findByTestId("handoff-use-here")).toHaveTextContent("Use here");
    expect(await screen.findByTestId("takeover-open")).toHaveTextContent("It wasn't me");
    await user.click(screen.getByTestId("handoff-use-here"));
    expect(await screen.findByTestId("handoff-use-here-dialog")).toBeInTheDocument();
  });

  it("keeps what only it held as Only on this device in Data and storage, until Discard is pressed twice", async () => {
    let forks = ["ghostly_oldcopy"];
    const { user, engine } = renderApp(<ForkRows />);
    engine.on("deviceSet", () => ({ state: "active", devices: [], ...(forks.length ? { forks } : {}) }));
    engine.on("deviceForkDiscard", () => { forks = []; return undefined; });
    const row = await screen.findByTestId("settings-fork");
    expect(row).toHaveTextContent("Only on this device");
    await user.click(screen.getByTestId("settings-fork-discard"));
    expect(engine.callsTo("deviceForkDiscard")).toEqual([]);
    expect(screen.getByTestId("settings-fork")).toHaveTextContent("Discard this copy for good?");
    await user.click(screen.getByTestId("settings-fork-discard-confirm"));
    expect(engine.callsTo("deviceForkDiscard")).toEqual([{ database: "ghostly_oldcopy" }]);
    await waitFor(() => expect(screen.queryByTestId("settings-fork")).toBeNull());
  });
});

describe("the forced takeover on the standby screen", () => {
  it("a replaced device offers It wasn't me: the password and the name go to the engine, a wrong one is said", async () => {
    const { user, engine } = renderApp(<DeviceStandby gate={{ state: "superseded", activeDevice: "Phone" }} />);
    engine.on("deviceTakeoverInfo", () => ({ offered: true, device: "Phone", copy: "frozen", password: true }));
    engine.on("deviceTakeover", () => { throw new Error("takeover-password: Wrong password."); });
    expect(screen.getByTestId("device-standby-title")).toHaveTextContent("This device was replaced");
    expect(screen.getByTestId("device-standby")).toHaveTextContent("Phone took over without this one. This device has stopped.");
    await user.click(await screen.findByTestId("takeover-open"));
    expect(screen.getByTestId("takeover-dialog")).toHaveTextContent("Take over without Phone?");
    expect(screen.getByTestId("takeover-dialog")).toHaveTextContent("This will make Phone stop.");
    expect(screen.getByTestId("takeover-go")).toBeDisabled();
    await user.type(screen.getByTestId("takeover-password"), "not it");
    await user.type(screen.getByTestId("takeover-name"), "Phone");
    // "Lost or stolen?" is answered before anything goes.
    expect(screen.getByTestId("takeover-go")).toBeDisabled();
    await user.click(screen.getByTestId("takeover-lost-no"));
    await user.click(screen.getByTestId("takeover-go"));
    expect(await screen.findByTestId("takeover-error")).toHaveTextContent("Wrong password.");
    expect(engine.callsTo("deviceTakeover")).toEqual([{ password: "not it", name: "Phone", lost: false }]);
  });

  it("a standby with a frozen copy offers My other device is lost or broken; one without a copy offers nothing", async () => {
    const first = renderApp(<DeviceStandby gate={{ state: "standby", activeDevice: "MacBook" }} />);
    first.engine.on("deviceTakeoverInfo", () => ({ offered: true, device: "MacBook", copy: "frozen", password: true }));
    expect(await screen.findByTestId("takeover-open")).toHaveTextContent("My other device is lost or broken");
    first.unmount();
    const second = renderApp(<DeviceStandby gate={{ state: "standby", activeDevice: "MacBook" }} />);
    second.engine.on("deviceTakeoverInfo", () => ({ offered: false }));
    await waitFor(() => expect(second.engine.callsTo("deviceTakeoverInfo").length).toBeGreaterThan(0));
    expect(screen.queryByTestId("takeover-open")).toBeNull();
  });

  it("a copy restored from a backup says where the profile is active and offers Take over, with no password", async () => {
    const { user, engine } = renderApp(<DeviceStandby gate={{ state: "standby", activeDevice: "MacBook" }} />);
    engine.on("deviceTakeoverInfo", () => ({ offered: true, device: "MacBook", copy: "restored", password: false }));
    expect(await screen.findByText("This profile is active on MacBook")).toBeInTheDocument();
    expect(screen.queryByTestId("handoff-use-here")).toBeNull();
    await user.click(screen.getByTestId("takeover-open"));
    expect(screen.queryByTestId("takeover-password")).toBeNull();
    expect(screen.getByTestId("takeover-name")).toBeInTheDocument();
  });
});

const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const adminGroup = (patch: Partial<GroupView> = {}) => groupView({ status: "active", epoch: 2, isAdmin: true, members: [member({ key: ME, me: true, role: "admin" }), member({ key: ALICE, nick: "Alice" })], ...patch });

describe("Manage groups from this device", () => {
  it("after a takeover the group says admin work is off here, and turning it on says what it risks first", async () => {
    fakeEngine.update({ groups: [adminGroup({ adminOff: true })] });
    const { user, engine } = renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
    engine.on("setGroupManage", () => undefined);
    expect(await screen.findByTestId("group-manage-off")).toHaveTextContent("Managing this group is off on this device.");
    await user.click(screen.getByTestId("group-manage-open"));
    expect(screen.getByTestId("group-manage-warning")).toHaveTextContent("can break the group for everyone");
    await user.click(screen.getByTestId("group-manage-confirm"));
    await waitFor(() => expect(engine.callsTo("setGroupManage")).toEqual([{ groupId: "group-1", on: true }]));
  });

  it("is not shown where admin work is on", async () => {
    fakeEngine.update({ groups: [adminGroup()] });
    renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
    expect(await screen.findByTestId("group-name")).toBeInTheDocument();
    expect(screen.queryByTestId("group-manage-off")).toBeNull();
  });
});
