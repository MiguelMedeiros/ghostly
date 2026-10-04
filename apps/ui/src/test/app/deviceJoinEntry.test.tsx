import type { ReactNode } from "react";
import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceInvite, inviteQrSegments } from "@ghostly/core";
import type { DeviceSetView } from "@ghostly/browser/devices/links";
import { JoinDialog } from "../../components/JoinDialog";
import { ProfileSwitcherMenu } from "../../components/ProfileSwitcher";
import { Sidebar } from "../../components/Sidebar";
import { DevicesSection } from "../../components/devices/DevicesSection";
import { JoinHost } from "../../components/devices/JoinHost";
import { Home } from "../../pages/Home";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { Profile } from "../../pages/Profile";
import { offerDeviceLink, takeDeviceLink, takeDeviceLinkFromAddress, takeJoinRequest } from "../../lib/devices";
import { activeProfileId, createProfile, listProfiles, prefixOf } from "../../lib/profiles";
import { listSessions } from "../../lib/storage";
import { appLinkOrigin } from "../../lib/url";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: devices.enroll

/*
 * Where a device is added to a profile it does not hold yet (WISP 06 § User experience): "I already use Ghostly" on a
 * fresh profile, on a phone too; "Add this device to another profile" in the switcher, the profile list and Profile,
 * Devices; and a device code opened as a link, which leaves the address at once and never goes into a profile in use.
 */

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

const Providers = ({ children }: { children: ReactNode }) => <LockScreenProvider><UpdateProvider>{children}</UpdateProvider></LockScreenProvider>;
const code = () => createDeviceInvite(new Uint8Array(32).fill(7)).code;
const JOIN_REQUEST = "ghostly_join_device";

/** A chat in this profile: a device that is in use. */
function aChat() {
  localStorage.setItem(`${prefixOf(activeProfileId())}chat1`, JSON.stringify({ id: "chat1", mySeedB64: "s", peerPubKeyB64: "p", encKeyB64: "e", createdAt: 0, messages: [{ id: "m0" }] }));
}

/** The reload a profile switch ends with, caught: the test stays on this page. */
function catchReload() {
  const reload = vi.fn();
  const location = window.location;
  vi.spyOn(window, "location", "get").mockReturnValue(new Proxy(location, { get: (target, key) => (key === "reload" ? reload : Reflect.get(target, key)) }));
  return reload;
}

const phone = () => vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query === "(max-width: 767px)", media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }));

beforeEach(() => {
  fakeEngine.features = { ...fakeEngine.features, profiles: true };
  sessionStorage.clear();
  window.history.replaceState(null, "", "#/");
  takeDeviceLink();
});
afterEach(() => {
  fakeEngine.features = { ...fakeEngine.features, profiles: false };
  vi.restoreAllMocks();
});

describe("I already use Ghostly", () => {
  it("on a phone the chat list of a fresh profile offers it, and the dialog opens over the list", async () => {
    phone();
    const { user } = renderApp(<Providers><Sidebar /><JoinHost /></Providers>);
    await user.click(await screen.findByTestId("sidebar-already"));
    expect(screen.getByTestId("device-join-add")).toHaveTextContent("Add this device to my profile");
  });

  it("on a wide screen the chat list leaves it to the home pane, which opens the same dialog", async () => {
    const { user } = renderApp(<Providers><Sidebar /><Home /><JoinHost /></Providers>);
    expect(screen.queryByTestId("sidebar-already")).toBeNull();
    await user.click(screen.getByTestId("home-already"));
    expect(screen.getByTestId("device-join-restore")).toHaveTextContent("Restore a backup");
  });
});

describe("Add this device to another profile", () => {
  it("is in the profile switcher; it asks, then makes a new profile that opens at the device's name, and leaves this one as it was", async () => {
    aChat();
    const reload = catchReload();
    const before = listProfiles().length;
    const glances = { current: listProfiles()[0], others: [], othersUnread: 0, othersFresh: 0 };
    const { user } = renderApp(<><ProfileSwitcherMenu variant="sheet" glances={glances} onClose={() => {}} /><JoinHost /></>);
    await user.click(screen.getByRole("menuitem", { name: "Add this device to another profile" }));
    const ask = screen.getByTestId("device-join-another");
    expect(ask).toHaveTextContent("A new profile opens here for it. Your profiles here stay as they are.");
    await user.click(within(ask).getByTestId("device-join-another-info"));
    expect(ask).toHaveTextContent("On the device you use now, open Profile, Devices, Add a device.");
    await user.click(within(ask).getByTestId("device-join-another-go"));
    const added = listProfiles().find((entry) => entry.name === "From another device")!;
    expect(listProfiles()).toHaveLength(before + 1);
    expect(JSON.parse(sessionStorage.getItem(JOIN_REQUEST)!)).toEqual({ id: added.id, start: "name" });
    await waitFor(() => expect(reload).toHaveBeenCalled());
    // This profile keeps its chat; the new one is empty.
    expect(localStorage.getItem(`${prefixOf("")}chat1`)).not.toBeNull();
    expect(localStorage.getItem(`${prefixOf(added.id)}chat1`)).toBeNull();
  });

  it("Cancel makes nothing", async () => {
    const before = listProfiles().length;
    const glances = { current: listProfiles()[0], others: [], othersUnread: 0, othersFresh: 0 };
    const { user } = renderApp(<><ProfileSwitcherMenu variant="popover" glances={glances} onClose={() => {}} /><JoinHost /></>);
    await user.click(screen.getByTestId("profile-switcher-join"));
    await user.click(screen.getByTestId("device-join-another-cancel"));
    expect(screen.queryByTestId("device-join-another")).toBeNull();
    expect(listProfiles()).toHaveLength(before);
    expect(sessionStorage.getItem(JOIN_REQUEST)).toBeNull();
  });

  it("is under New profile in the profile list, where profiles can be made", async () => {
    const { user } = renderApp(<><Profile /><JoinHost /></>);
    await user.click(screen.getByTestId("profile-join-another"));
    expect(screen.getByTestId("device-join-another")).toBeInTheDocument();
  });

  const set = (devices: DeviceSetView["devices"]): DeviceSetView => ({ state: devices.length ? "active" : "single", devices } as DeviceSetView);

  it("Profile, Devices offers it while the profile has no other device, and not once it has", async () => {
    fakeEngine.on("deviceSet", () => set([]));
    const { user, unmount } = renderApp(<><DevicesSection /><JoinHost /></>);
    const row = await screen.findByTestId("device-join-another-row");
    expect(row).toHaveTextContent("Use this device with a profile from another device");
    await user.click(within(row).getByTestId("device-join-another-open"));
    expect(screen.getByTestId("device-join-another")).toBeInTheDocument();
    unmount();

    fakeEngine.on("deviceSet", () => set([
      { key: "D".repeat(43), name: "MacBook", slot: 0, self: true, active: true },
      { key: "P".repeat(43), name: "iPhone", slot: 1, self: false, active: false, status: "live" },
    ] as DeviceSetView["devices"]));
    renderApp(<DevicesSection />);
    await screen.findAllByTestId("device-row");
    expect(screen.queryByTestId("device-join-another-row")).toBeNull();
  });

  it("is not offered where an app has one profile only", async () => {
    fakeEngine.features = { ...fakeEngine.features, profiles: false };
    fakeEngine.on("deviceSet", () => set([]));
    renderApp(<DevicesSection />);
    await waitFor(() => expect(fakeEngine.callsTo("deviceSet").length).toBeGreaterThan(0));
    expect(screen.queryByTestId("device-join-another-row")).toBeNull();
  });
});

describe("a device code opened as a link (the QR code, by a phone's camera)", () => {
  it("leaves the address at once, in any case and as a web+ghostly: link, and is kept for the join host only", () => {
    const device = code();
    window.history.replaceState(null, "", `#${device.toUpperCase()}`);
    takeDeviceLinkFromAddress();
    expect(window.location.hash).toBe("#/");
    expect(takeDeviceLink()).toBe(device.toUpperCase());
    // Taken once.
    expect(takeDeviceLink()).toBeNull();

    window.history.replaceState(null, "", `#web%2Bghostly%3A${device}`);
    takeDeviceLinkFromAddress();
    expect(window.location.hash).toBe("#/");
    expect(takeDeviceLink()).toBe(device);
  });

  it("leaves a chat invite and a route alone, for the router", () => {
    window.history.replaceState(null, "", "#/settings");
    takeDeviceLinkFromAddress();
    expect(window.location.hash).toBe("#/settings");
    expect(takeDeviceLink()).toBeNull();
  });

  it("on a device in use: asks first, and the code goes into a new profile, never into this one", async () => {
    aChat();
    const reload = catchReload();
    const device = code();
    offerDeviceLink(device);
    const { user } = renderApp(<JoinHost />);
    const ask = await screen.findByTestId("device-join-another");
    expect(ask).toHaveTextContent("Add this device to another profile?");
    expect(ask).not.toHaveTextContent(device);
    await user.click(within(ask).getByTestId("device-join-another-go"));
    const added = listProfiles().find((entry) => entry.name === "From another device")!;
    expect(JSON.parse(sessionStorage.getItem(JOIN_REQUEST)!)).toEqual({ id: added.id, code: device, start: "name" });
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(fakeEngine.callsTo("deviceEnrollJoin")).toHaveLength(0);
    expect(listSessions()).toHaveLength(1);
    // The new profile, once it starts, reads the request once.
    expect(takeJoinRequest(added.id)).toEqual({ code: device, start: "name" });
    expect(takeJoinRequest(added.id)).toBeNull();
  });

  it("on a fresh install: straight to the device's name, and the code is used after it, without the scanner", async () => {
    const device = code();
    offerDeviceLink(device);
    fakeEngine.on("deviceEnrollJoin", () => ({ role: "joiner", step: "connecting" }));
    const { user } = renderApp(<JoinHost />);
    const form = await screen.findByTestId("device-join-name-form");
    expect(form).toHaveAttribute("data-code-given", "true");
    await user.clear(screen.getByTestId("device-join-name"));
    await user.type(screen.getByTestId("device-join-name"), "Pixel");
    await user.click(screen.getByTestId("device-join-next"));
    await waitFor(() => expect(fakeEngine.callsTo("deviceEnrollJoin")).toHaveLength(1));
    expect(fakeEngine.callsTo("deviceEnrollJoin")[0]).toMatchObject({ code: device, name: "Pixel" });
    expect(screen.queryByRole("textbox", { name: "Invite code" })).toBeNull();
    expect(listProfiles()).toHaveLength(1);
  });

  it("a code the engine refuses is said, and the next try asks for a code", async () => {
    offerDeviceLink(code());
    fakeEngine.on("deviceEnrollJoin", () => { throw new Error("enroll-used: Another device used this code first."); });
    const { user } = renderApp(<JoinHost />);
    await screen.findByTestId("device-join-name-form");
    await user.click(screen.getByTestId("device-join-next"));
    expect(await screen.findByTestId("device-join-error")).toHaveTextContent("Another device used this code first. Make a new one.");
    expect(screen.getByTestId("device-join-name-form")).not.toHaveAttribute("data-code-given");
  });

  it("an expired code is said over the app, and nothing opens", async () => {
    offerDeviceLink(createDeviceInvite(new Uint8Array(32).fill(7), 1_000).code);
    renderApp(<JoinHost />);
    expect(await screen.findByTestId("device-link-invalid")).toHaveTextContent("This code ran out of time. Make a new one.");
    expect(screen.queryByTestId("device-join")).toBeNull();
    expect(screen.queryByTestId("device-join-another")).toBeNull();
  });

  it("scanned with Join, a device code goes where such a code goes instead of being refused", async () => {
    const onClose = vi.fn();
    const device = code();
    const { user } = renderApp(<><JoinDialog onJoin={() => {}} onClose={onClose} /><JoinHost /></>);
    fakeEngine.readClipboardText = vi.fn(async () => `${appLinkOrigin()}/#${device}`);
    aChat();
    await user.click(screen.getByRole("button", { name: "Paste from clipboard" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(await screen.findByTestId("device-join-another")).toHaveTextContent("Add this device to another profile?");
  });

  it("the QR code is the code's link on the web app, in the segments a QR packs best", () => {
    const device = code();
    expect(appLinkOrigin()).toBe(window.location.origin);
    expect(inviteQrSegments(device, appLinkOrigin())).toEqual([`${window.location.origin}/`.toUpperCase(), "#", device.toUpperCase()]);
    // From the desktop app, which has no address another device opens: the public web app.
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    try { expect(appLinkOrigin()).toBe("https://app.ghostly.tools"); } finally { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); }
  });
});

describe("a profile made to join", () => {
  it("opens the join dialog when it starts, once", async () => {
    const entry = createProfile("Joining");
    sessionStorage.setItem(JOIN_REQUEST, JSON.stringify({ id: activeProfileId(), start: "name" }));
    renderApp(<JoinHost />);
    expect(await screen.findByTestId("device-join-name-form")).toBeInTheDocument();
    expect(sessionStorage.getItem(JOIN_REQUEST)).toBeNull();
    expect(entry.id).not.toBe(activeProfileId());
  });

  it("reads a request in the older form (the profile id alone) as one at the first step", () => {
    sessionStorage.setItem(JOIN_REQUEST, "abc");
    expect(takeJoinRequest("other")).toBeNull();
    expect(takeJoinRequest("abc")).toEqual({});
  });

  it("is not opened on a device on standby", () => {
    sessionStorage.setItem(JOIN_REQUEST, JSON.stringify({ id: activeProfileId() }));
    renderApp(<JoinHost standby />);
    act(() => {});
    expect(screen.queryByTestId("device-join")).toBeNull();
  });
});
